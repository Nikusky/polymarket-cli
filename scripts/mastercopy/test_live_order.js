// One-shot validation: place a $1 FAK BUY through @polymarket/clob-client-v2
// using the funderAddress override, to prove the v2 SDK + funder override flow
// works end-to-end against the current Polymarket CLOB. Exits after one order.
//
// Env (all required):
//   POLYMARKET_PRIVATE_KEY        - EOA private key (0x... 64 hex)
//   POLYMARKET_FUNDER_OVERRIDE    - target proxy (e.g. 0x66c2...4E96 for Nikusky7)
//
// Run: node scripts/mastercopy/test_live_order.js
//
// ⚠️ PLACES REAL ORDER WITH REAL MONEY. $1 max risk per invocation.

const { ClobClient, OrderType, Side, Chain } = require('@polymarket/clob-client-v2');
const { createWalletClient, http } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { polygon } = require('viem/chains');

const HOST = 'https://clob.polymarket.com';
const SIZE_USD = 1;
const LIMIT_PRICE = 0.55;  // Buy "Up" — generous limit; FAK so unfilled portion cancels

function die(msg) { console.error('ERROR:', msg); process.exit(1); }

const KEY = process.env.POLYMARKET_PRIVATE_KEY;
const FUNDER = process.env.POLYMARKET_FUNDER_OVERRIDE;
if (!KEY || !KEY.startsWith('0x')) die('POLYMARKET_PRIVATE_KEY missing or malformed');
if (!FUNDER || !FUNDER.startsWith('0x')) die('POLYMARKET_FUNDER_OVERRIDE missing or malformed');

async function nextBtcUpdownMarket() {
  const now = Math.floor(Date.now() / 1000);
  const nextSlot = (Math.floor(now / 900) + 1) * 900;
  const slug = `btc-updown-15m-${nextSlot}`;
  const r = await fetch(`https://gamma-api.polymarket.com/markets?slug=${slug}`);
  const data = await r.json();
  if (!data || !data[0]) throw new Error(`no market for ${slug}`);
  const m = data[0];
  if (!m.acceptingOrders) throw new Error(`market ${slug} not accepting orders`);
  const tokenIds = JSON.parse(m.clobTokenIds);
  return { slug, upTokenId: tokenIds[0], downTokenId: tokenIds[1] };
}

(async () => {
  console.log('--- v2 SDK live-order smoke test ---');
  console.log(`  funder:  ${FUNDER}`);
  console.log(`  size:    $${SIZE_USD}`);
  console.log(`  limit:   $${LIMIT_PRICE}`);
  console.log();

  const account = privateKeyToAccount(KEY);
  const walletClient = createWalletClient({ account, chain: polygon, transport: http() });
  console.log(`  EOA derived from key: ${account.address}`);

  // L1 auth: derive API keys for the funder context. This signs an EIP-712 challenge
  // with the EOA, and the server maps EOA → funder to issue HMAC creds.
  console.log('  [1/4] L1: createOrDeriveApiKey (proves the EOA+funder pairing is valid)...');
  const bootstrap = new ClobClient({
    host: HOST,
    chain: Chain.POLYGON,
    signer: walletClient,
    funderAddress: FUNDER,
  });
  const creds = await bootstrap.createOrDeriveApiKey();
  console.log(`        ok — api_key starts with: ${creds.key.slice(0, 8)}...`);

  console.log('  [2/4] L2: authenticated client with creds + funder override...');
  const client = new ClobClient({
    host: HOST,
    chain: Chain.POLYGON,
    signer: walletClient,
    funderAddress: FUNDER,
    creds,
    throwOnError: true,
  });

  console.log('  [3/4] resolve next btc-updown-15m market...');
  const { slug, upTokenId } = await nextBtcUpdownMarket();
  console.log(`        market: ${slug}`);
  console.log(`        upTokenId: ${upTokenId.slice(0, 24)}...`);

  // The size field is shares for limit orders, not USDC. At $0.55 limit, $1 = 1.82 shares.
  const sizeShares = Math.round((SIZE_USD / LIMIT_PRICE) * 100) / 100;
  console.log(`  [4/4] placing FAK BUY @ $${LIMIT_PRICE} × ${sizeShares} shares (~$${SIZE_USD})...`);

  try {
    const resp = await client.createAndPostOrder(
      { tokenID: upTokenId, price: LIMIT_PRICE, side: Side.BUY, size: sizeShares },
      { tickSize: '0.001' },
      OrderType.FAK,
    );
    console.log();
    console.log('=== RESPONSE ===');
    console.log(JSON.stringify(resp, null, 2));
    console.log();
    if (resp.success === false || resp.error) {
      console.log('RESULT: order REJECTED — see error field above');
      process.exit(2);
    } else {
      console.log('RESULT: order ACCEPTED — funder override + v2 SDK works end-to-end');
      process.exit(0);
    }
  } catch (e) {
    console.log();
    console.log('=== EXCEPTION ===');
    console.log('message:', e.message);
    if (e.status) console.log('status: ', e.status);
    if (e.data)   console.log('data:   ', JSON.stringify(e.data));
    console.log();
    console.log('RESULT: order FAILED — see exception above');
    process.exit(3);
  }
})();
