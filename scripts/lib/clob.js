// Polymarket CLOB v2 client helpers used by strategy-live.
//
// Pure helpers are at the top so they can be unit-tested without the SDK
// installed. SDK-dependent code (bootstrap, place orders) is below.
//
// V2 (2026-05-27): corrects the BUY response-parsing bug from V1 and adds
// placeMarketSell for live stop-loss. Authoritative fill data comes from
// `getOrder(orderID)` after submission — relying on the order response's
// `makingAmount`/`takingAmount` in V1 produced impossible fillPrice values
// (e.g. $2.12 for a market priced in [0,1]).

function computeMaxPriceForFill(paperFillPrice, slippageAllowanceBps, maxFillCeiling = 1.0) {
  const slip = paperFillPrice * (slippageAllowanceBps / 10000);
  const raw = paperFillPrice + slip;
  return Math.min(raw, maxFillCeiling, 1.0);
}

function validateFunderAddress(addr) {
  if (typeof addr !== 'string') return false;
  if (!addr.startsWith('0x')) return false;
  if (addr.length !== 42) return false;
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

function sizeUsdToShareSize(sizeUsd, price) {
  if (!(price > 0)) throw new Error('price must be > 0');
  return sizeUsd / price;
}

// Parse a CLOB GET /data/order/{id} response into the canonical fill summary
// used by the live executor. The endpoint returns OpenOrder with:
//   { id, status, side, original_size, size_matched, price, ... }
// where size_matched is shares filled and price is the average fill price.
// Same shape for BUY and SELL (cost is derived: cost = size_matched * price).
//
// Returns { filledShares, fillPrice, filledUsd, status } or null if the order
// document is missing required fields.
function parseGetOrderFill(orderDoc) {
  if (!orderDoc || typeof orderDoc !== 'object') return null;
  const sizeMatched = parseFloat(orderDoc.size_matched);
  const price = parseFloat(orderDoc.price);
  if (!Number.isFinite(sizeMatched) || !Number.isFinite(price)) return null;
  if (sizeMatched <= 0 || price <= 0 || price > 1) return null;
  return {
    filledShares: sizeMatched,
    fillPrice: price,
    filledUsd: sizeMatched * price,
    status: orderDoc.status || 'unknown',
  };
}

// ============================================================================
// SDK-dependent code below. Requires @polymarket/clob-client-v2 + viem.
// Pattern validated against scripts/mastercopy/test_live_order.js (the proven
// path that placed the first real order 0x557716... on 2026-05-26).
// ============================================================================

const { ClobClient, OrderType, Side, Chain, SignatureTypeV2, AssetType } = require('@polymarket/clob-client-v2');
const { createWalletClient, http } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { polygon } = require('viem/chains');

const CLOB_HOST = 'https://clob.polymarket.com';

let _client = null;

async function bootstrapClobClient({ privateKey, funderAddress }) {
  if (_client) return _client;
  if (!privateKey || !privateKey.startsWith('0x')) {
    throw new Error('POLYMARKET_PRIVATE_KEY missing or malformed');
  }
  if (!validateFunderAddress(funderAddress)) {
    throw new Error(`POLYMARKET_FUNDER_OVERRIDE invalid: ${funderAddress}`);
  }
  const account = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({ account, chain: polygon, transport: http() });
  const opts = {
    host: CLOB_HOST,
    chain: Chain.POLYGON,
    signer: walletClient,
    funderAddress,
    signatureType: SignatureTypeV2.POLY_1271,
  };
  const bootstrap = new ClobClient(opts);
  const creds = await bootstrap.createOrDeriveApiKey();
  _client = new ClobClient({ ...opts, creds, throwOnError: true });
  // Sync CLOB's view of deposit-wallet collateral; tolerate failure.
  try { await _client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL }); }
  catch (e) { /* already in sync — non-fatal per test_live_order.js */ }
  return _client;
}

// Polymarket CLOB SDK expects decimal-string tokenIDs (uint256), but the
// Rust polymarket-cli emits them in 0x-hex form. Convert at the SDK boundary.
function normalizeTokenId(tokenId) {
  if (typeof tokenId !== 'string') throw new Error('tokenId must be a string');
  return tokenId.startsWith('0x') ? BigInt(tokenId).toString() : tokenId;
}

// Pull HTTP-shaped diagnostics off an SDK error (axios / fetch / either).
function describeSdkError(e) {
  const out = { httpStatus: undefined, responseBody: undefined };
  if (!e || typeof e !== 'object') return out;
  if (e.response && typeof e.response === 'object') {
    if (typeof e.response.status === 'number') out.httpStatus = e.response.status;
    const data = e.response.data;
    if (data !== undefined) {
      try { out.responseBody = typeof data === 'string' ? data : JSON.stringify(data); }
      catch { out.responseBody = String(data); }
    }
  }
  if (out.httpStatus === undefined && typeof e.status === 'number') out.httpStatus = e.status;
  if (out.responseBody === undefined && typeof e.body === 'string') out.responseBody = e.body;
  if (out.responseBody && out.responseBody.length > 1500) {
    out.responseBody = out.responseBody.slice(0, 1500) + '…[truncated]';
  }
  return out;
}

function wrapSdkError(e, { failedCall, tokenIdDec }) {
  const { httpStatus, responseBody } = describeSdkError(e);
  const baseMsg = (e && e.message) || String(e);
  const wrapped = new Error(`${failedCall}: ${baseMsg}`);
  if (e && e.stack) wrapped.stack = e.stack;
  wrapped.failedCall = failedCall;
  wrapped.tokenIdDec = tokenIdDec;
  wrapped.httpStatus = httpStatus;
  wrapped.responseBody = responseBody;
  wrapped.cause = e;
  return wrapped;
}

const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

// Fetch the order document via the L2-authenticated /data/order/{id} endpoint
// and translate it to the canonical fill summary. FAK orders can be queried
// even after they close — but there's a small race window where the CLOB
// hasn't recorded the final state yet, so we poll briefly.
async function fetchOrderFill(orderId, { tries = 6, delayMs = 500 } = {}) {
  if (!_client) throw new Error('clob client not bootstrapped');
  let lastDoc = null;
  for (let i = 0; i < tries; i++) {
    let doc;
    try { doc = await _client.getOrder(orderId); }
    catch (e) { throw wrapSdkError(e, { failedCall: 'getOrder', tokenIdDec: undefined }); }
    lastDoc = doc;
    const fill = parseGetOrderFill(doc);
    if (fill) return { ...fill, rawOrder: doc };
    await SLEEP(delayMs);
  }
  // No usable fill data — return zeros with the last-seen document so the
  // caller can still log it for diagnostics.
  return { filledShares: 0, fillPrice: 0, filledUsd: 0, status: lastDoc && lastDoc.status, rawOrder: lastDoc };
}

// FAK BUY for sizeUsd USDC. Returns the authoritative fill summary computed
// from getOrder(orderID), not from the post-order response — the response's
// makingAmount/takingAmount fields were unreliable in production (see ledger
// entry 2026-05-27 22:11 where they yielded fillPrice $2.12).
//
// FAK has NO pre-trade price cap; maxFillPrice is a post-trade tripwire that
// logs a SLIPPAGE_HIGH warning if the actual fill blows past it.
async function placeMarketBuy({ tokenId, sizeUsd, maxFillPrice }) {
  if (!_client) throw new Error('clob client not bootstrapped');
  const tokenIdDec = normalizeTokenId(tokenId);

  let tickSize;
  try { tickSize = await _client.getTickSize(tokenIdDec); }
  catch (e) { throw wrapSdkError(e, { failedCall: 'getTickSize', tokenIdDec }); }

  let resp;
  try {
    resp = await _client.createAndPostMarketOrder(
      { tokenID: tokenIdDec, amount: sizeUsd, side: Side.BUY, orderType: OrderType.FAK },
      { tickSize },
      OrderType.FAK,
    );
  } catch (e) {
    throw wrapSdkError(e, { failedCall: 'createAndPostMarketOrder', tokenIdDec });
  }

  if (!resp || resp.success === false || resp.error) {
    const err = new Error(`createAndPostMarketOrder: order rejected: ${JSON.stringify(resp || {})}`);
    err.failedCall = 'createAndPostMarketOrder';
    err.tokenIdDec = tokenIdDec;
    err.responseBody = JSON.stringify(resp || {});
    throw err;
  }
  const orderId = resp.orderID || resp.orderId || resp.id;
  const fill = await fetchOrderFill(orderId);
  if (maxFillPrice && fill.fillPrice > maxFillPrice * 1.01) {
    console.error(`[clob.placeMarketBuy] SLIPPAGE_HIGH: fill ${fill.fillPrice.toFixed(3)} > maxFill ${maxFillPrice} * 1.01`);
  }
  return {
    orderId,
    fillPrice: fill.fillPrice,
    filledShares: fill.filledShares,
    filledUsd: fill.filledUsd,
    status: fill.status,
    raw: resp,
    rawOrder: fill.rawOrder,
  };
}

// FAK SELL for sharesToSell shares of `tokenId`. Used by the stop-loss path
// to close a long position created earlier by placeMarketBuy.
//
// Per UserMarketOrderV2 docstring: for SELL orders, `amount` is shares (not
// USDC). minFillPrice is a post-trade tripwire — logs SLIPPAGE_HIGH if the
// realized price falls below it. FAK has no pre-trade price floor on the SDK
// side, so callers should sanity-check the orderbook midpoint upstream.
async function placeMarketSell({ tokenId, sharesToSell, minFillPrice }) {
  if (!_client) throw new Error('clob client not bootstrapped');
  if (!(sharesToSell > 0)) throw new Error(`sharesToSell must be > 0 (got ${sharesToSell})`);
  const tokenIdDec = normalizeTokenId(tokenId);

  let tickSize;
  try { tickSize = await _client.getTickSize(tokenIdDec); }
  catch (e) { throw wrapSdkError(e, { failedCall: 'getTickSize', tokenIdDec }); }

  let resp;
  try {
    resp = await _client.createAndPostMarketOrder(
      { tokenID: tokenIdDec, amount: sharesToSell, side: Side.SELL, orderType: OrderType.FAK },
      { tickSize },
      OrderType.FAK,
    );
  } catch (e) {
    throw wrapSdkError(e, { failedCall: 'createAndPostMarketOrder', tokenIdDec });
  }

  if (!resp || resp.success === false || resp.error) {
    const err = new Error(`createAndPostMarketOrder(SELL): order rejected: ${JSON.stringify(resp || {})}`);
    err.failedCall = 'createAndPostMarketOrder';
    err.tokenIdDec = tokenIdDec;
    err.responseBody = JSON.stringify(resp || {});
    throw err;
  }
  const orderId = resp.orderID || resp.orderId || resp.id;
  const fill = await fetchOrderFill(orderId);
  if (minFillPrice && fill.fillPrice > 0 && fill.fillPrice < minFillPrice * 0.99) {
    console.error(`[clob.placeMarketSell] SLIPPAGE_HIGH: fill ${fill.fillPrice.toFixed(3)} < minFill ${minFillPrice} * 0.99`);
  }
  return {
    orderId,
    fillPrice: fill.fillPrice,
    filledShares: fill.filledShares,
    filledUsd: fill.filledUsd,
    status: fill.status,
    raw: resp,
    rawOrder: fill.rawOrder,
  };
}

module.exports = {
  computeMaxPriceForFill, validateFunderAddress, sizeUsdToShareSize,
  normalizeTokenId, parseGetOrderFill,
  bootstrapClobClient, placeMarketBuy, placeMarketSell, fetchOrderFill,
  CLOB_HOST,
};
