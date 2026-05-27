// polyBOT strategy-live — places real CLOB orders mirroring polybot-strategy-s.
//
// Reads:  /opt/polybot/polymarket-cli/scripts/strategy/data-s/strategy-ledger.jsonl
// Writes: /opt/polybot/polymarket-cli/scripts/strategy-live/data-live/strategy-ledger-live.jsonl
//         /opt/polybot/polymarket-cli/scripts/strategy-live/data-live/state.json
//
// Env (required at runtime, unless DRY_RUN):
//   POLYMARKET_PRIVATE_KEY      EOA private key (0x + 64 hex)
//   POLYMARKET_FUNDER_OVERRIDE  Proxy wallet (0x66c2...4E96 for Nikusky7)
//
// Env (optional):
//   LIVE_DATA_DIR               default: ./data-live (relative to this file)
//   PAPER_LEDGER_PATH           default: ../strategy/data-s/strategy-ledger.jsonl
//   POLL_MS                     default: 2000
//   MAX_FILL_PRICE              default: 0.92 (post-trade slippage tripwire)
//   DRY_RUN                     default: 'false'
//
// Hardcoded safety rails: scripts/strategy-live/safety.js
// SDK pattern: scripts/lib/clob.js (validated against mastercopy/test_live_order.js).

const fs = require('fs');
const path = require('path');
const {
  bootstrapClobClient, placeMarketBuy, placeMarketSell,
} = require('../lib/clob');
const {
  loadState, saveState, recordOrder, hasOrderFor,
  addRealizedPnl, dailyPnlForToday,
} = require('./state');
const { allClear, RAILS } = require('./safety');

const ROOT = __dirname;
const DATA_DIR = process.env.LIVE_DATA_DIR
  ? path.resolve(process.env.LIVE_DATA_DIR)
  : path.join(ROOT, 'data-live');
const PAPER_LEDGER = process.env.PAPER_LEDGER_PATH
  ? path.resolve(process.env.PAPER_LEDGER_PATH)
  : path.resolve(ROOT, '..', 'strategy', 'data-s', 'strategy-ledger.jsonl');
// Match the dashboard's convention (readers.js reads <dataDir>/strategy-ledger.jsonl).
const LIVE_LEDGER = path.join(DATA_DIR, 'strategy-ledger.jsonl');
const POLL_MS = parseInt(process.env.POLL_MS || '2000', 10);
const MAX_FILL_PRICE = parseFloat(process.env.MAX_FILL_PRICE || '0.92');
const DRY_RUN = String(process.env.DRY_RUN || 'false').toLowerCase() === 'true';

fs.mkdirSync(DATA_DIR, { recursive: true });

function log(level, msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts.slice(11, 19)}] ${level.padEnd(7)} ${msg}`);
}
function appendLive(record) { fs.appendFileSync(LIVE_LEDGER, JSON.stringify(record) + '\n'); }

let _lastOffset = -1;
function readNewLedgerLines() {
  let stat;
  try { stat = fs.statSync(PAPER_LEDGER); }
  catch { return []; }
  if (_lastOffset < 0) {
    _lastOffset = stat.size;
    log('info', `cold-start: skipping ${_lastOffset} bytes of existing paper history`);
    return [];
  }
  if (stat.size === _lastOffset) return [];
  if (stat.size < _lastOffset) {
    log('warn', `paper ledger truncated (${stat.size} < ${_lastOffset}); resetting`);
    _lastOffset = 0;
  }
  const fd = fs.openSync(PAPER_LEDGER, 'r');
  const buf = Buffer.alloc(stat.size - _lastOffset);
  fs.readSync(fd, buf, 0, buf.length, _lastOffset);
  fs.closeSync(fd);
  _lastOffset = stat.size;
  return buf.toString('utf8').split('\n').filter(s => s.trim().length > 0);
}

function openCount(state) {
  return Object.keys(state.positions).filter(slug => {
    const p = state.positions[slug];
    return p && !p.settled;
  }).length;
}

async function handleEntry(record, state) {
  const slug = record.slug;
  if (hasOrderFor(state, slug)) {
    log('skip', `${slug.slice(-10)}  already-placed (idempotency hit)`);
    return;
  }
  const gate = allClear({
    sizeUsd: record.paperCost || 100,
    dailyPnl: dailyPnlForToday(state, Math.floor(Date.now() / 1000)),
    openCount: openCount(state),
  });
  if (!gate.ok) {
    log('skip', `${slug.slice(-10)}  rail=${gate.reason}`);
    appendLive({
      kind: 'skip', ts: Math.floor(Date.now() / 1000),
      slug, paperSlug: slug, reason: gate.reason,
    });
    return;
  }

  const sizeUsd = Math.min(record.paperCost || 100, RAILS.PER_TRADE_USD);
  const paperFill = record.avgFillPrice;

  if (DRY_RUN) {
    log('DRY', `${slug.slice(-10)}  WOULD-BUY ${record.betSide} sizeUsd=$${sizeUsd} (paperFill=${paperFill.toFixed(3)})`);
    appendLive({
      kind: 'entry', ts: Math.floor(Date.now() / 1000),
      slug, paperSlug: slug, betSide: record.betSide,
      dryRun: true, sizeUsd, paperFillPrice: paperFill,
    });
    recordOrder(state, slug, 'DRY-' + Math.floor(Date.now() / 1000));
    saveState(DATA_DIR, state);
    return;
  }

  try {
    const res = await placeMarketBuy({
      tokenId: record.tokenId,
      sizeUsd,
      maxFillPrice: MAX_FILL_PRICE,
    });
    const slipBps = paperFill > 0
      ? ((res.fillPrice - paperFill) / paperFill) * 10000
      : 0;
    log('BUY', `${slug.slice(-10)}  ${record.betSide} @ ${res.fillPrice.toFixed(3)} sh=${res.filledShares.toFixed(1)} $${res.filledUsd.toFixed(2)}  slip=${slipBps.toFixed(1)}bps  order=${String(res.orderId).slice(0, 10)}`);
    state.positions[slug] = {
      clobOrderId: res.orderId, betSide: record.betSide,
      tokenId: record.tokenId,
      shares: res.filledShares, cost: res.filledUsd, fillPrice: res.fillPrice,
      paperFillPrice: paperFill, settled: false,
    };
    recordOrder(state, slug, res.orderId);
    appendLive({
      kind: 'entry', ts: Math.floor(Date.now() / 1000),
      slug, paperSlug: slug, clobOrderId: res.orderId, betSide: record.betSide,
      realShares: res.filledShares, realFillPrice: res.fillPrice, realCost: res.filledUsd,
      paperFillPrice: paperFill, fillSlippageBps: slipBps,
    });
    saveState(DATA_DIR, state);
  } catch (e) {
    const failedCall = e && e.failedCall;
    const httpStatus = e && e.httpStatus;
    const stackHead = e && e.stack ? String(e.stack).slice(0, 1500) : undefined;
    const tag = failedCall ? `[${failedCall}${httpStatus ? ` http=${httpStatus}` : ''}] ` : '';
    log('ERROR', `${slug.slice(-10)}  ${tag}${e.message}`);
    if (e && e.responseBody) {
      log('ERROR', `${slug.slice(-10)}  body=${String(e.responseBody).slice(0, 400)}`);
    }
    appendLive({
      kind: 'error', ts: Math.floor(Date.now() / 1000),
      slug, paperSlug: slug, error: e.message,
      failedCall, httpStatus,
      responseBody: e && e.responseBody,
      tokenIdDec: e && e.tokenIdDec,
      stack: stackHead,
    });
  }
}

async function handleExit(record, state) {
  const slug = record.slug;
  const pos = state.positions[slug];
  if (!pos || pos.settled) return;

  if (record.stoppedOut) return handleStoppedOut(record, pos, state);

  // Resolution exit (won/lost at market close, no stop-loss). v2 placeholder:
  // log paper PnL as approximation. Real reconciliation against ConditionalToken
  // payouts is v3 — for now the position is marked settled and tracked via paper.
  log('RESOLVE', `${slug.slice(-10)}  paper.won=${record.won} paper.pnl=${record.pnl}; real reconciliation TODO`);
  pos.settled = true;
  addRealizedPnl(state, record.ts, record.pnl || 0);
  appendLive({
    kind: 'exit', ts: Math.floor(Date.now() / 1000),
    slug, paperSlug: slug, won: record.won, stoppedOut: false,
    pnl: record.pnl, paperPnl: record.pnl,
    note: 'paper_pnl_only_pending_reconciliation',
  });
  saveState(DATA_DIR, state);
}

// Live SELL path: paper twin emitted exit with stoppedOut=true. Close the
// real position via FAK SELL for all held shares; book realized PnL as
// proceeds - entry cost.
async function handleStoppedOut(record, pos, state) {
  const slug = record.slug;
  const tokenId = pos.tokenId || record.tokenId;
  if (!tokenId) {
    log('ERROR', `${slug.slice(-10)}  cannot SELL: tokenId missing (pre-v2 position?)`);
    appendLive({
      kind: 'error', ts: Math.floor(Date.now() / 1000),
      slug, paperSlug: slug, error: 'sell_missing_tokenId',
    });
    return;
  }
  if (!(pos.shares > 0)) {
    log('ERROR', `${slug.slice(-10)}  cannot SELL: pos.shares=${pos.shares}`);
    appendLive({
      kind: 'error', ts: Math.floor(Date.now() / 1000),
      slug, paperSlug: slug, error: 'sell_zero_shares', shares: pos.shares,
    });
    return;
  }

  if (DRY_RUN) {
    log('DRY', `${slug.slice(-10)}  WOULD-SELL ${pos.shares.toFixed(1)}sh (paper stop-loss; entryCost=$${pos.cost.toFixed(2)})`);
    appendLive({
      kind: 'exit', ts: Math.floor(Date.now() / 1000),
      slug, paperSlug: slug, dryRun: true, stoppedOut: true,
      sharesToSell: pos.shares, entryCost: pos.cost, entryFillPrice: pos.fillPrice,
    });
    pos.settled = true;
    saveState(DATA_DIR, state);
    return;
  }

  try {
    const res = await placeMarketSell({
      tokenId, sharesToSell: pos.shares,
      minFillPrice: pos.fillPrice * 0.5, // tripwire only; sanity floor
    });
    const proceeds = res.filledUsd;
    const realizedPnl = proceeds - pos.cost;
    log('SELL', `${slug.slice(-10)}  @ ${res.fillPrice.toFixed(3)} sh=${res.filledShares.toFixed(1)} proceeds=$${proceeds.toFixed(2)} pnl=$${realizedPnl.toFixed(2)} order=${String(res.orderId).slice(0, 10)}`);
    pos.settled = true;
    pos.exitOrderId = res.orderId;
    pos.exitFillPrice = res.fillPrice;
    pos.exitShares = res.filledShares;
    pos.exitProceeds = proceeds;
    pos.realizedPnl = realizedPnl;
    addRealizedPnl(state, Math.floor(Date.now() / 1000), realizedPnl);
    appendLive({
      kind: 'exit', ts: Math.floor(Date.now() / 1000),
      slug, paperSlug: slug, stoppedOut: true, won: false,
      exitOrderId: res.orderId,
      realExitPrice: res.fillPrice, realExitShares: res.filledShares,
      realProceeds: proceeds, realizedPnl,
      entryCost: pos.cost, entryShares: pos.shares, entryFillPrice: pos.fillPrice,
      paperPnl: record.pnl,
    });
    saveState(DATA_DIR, state);
  } catch (e) {
    const failedCall = e && e.failedCall;
    const httpStatus = e && e.httpStatus;
    const stackHead = e && e.stack ? String(e.stack).slice(0, 1500) : undefined;
    const tag = failedCall ? `[${failedCall}${httpStatus ? ` http=${httpStatus}` : ''}] ` : '';
    log('ERROR', `${slug.slice(-10)}  SELL failed: ${tag}${e.message}`);
    if (e && e.responseBody) {
      log('ERROR', `${slug.slice(-10)}  body=${String(e.responseBody).slice(0, 400)}`);
    }
    // Do NOT mark settled — leave the position open so the next stop-loss
    // signal can retry. Operator can intervene manually via Polymarket UI.
    appendLive({
      kind: 'error', ts: Math.floor(Date.now() / 1000),
      slug, paperSlug: slug, error: `sell_failed: ${e.message}`,
      failedCall, httpStatus,
      responseBody: e && e.responseBody,
      tokenIdDec: e && e.tokenIdDec,
      stack: stackHead,
    });
  }
}

function handlePaperSkip(record) {
  const slug = record.slug || '';
  const reason = record.reason || 'unknown';
  const retBps = typeof record.retBps === 'number' ? ` retBps=${record.retBps.toFixed(2)}` : '';
  log('skip', `${slug.slice(-10)}  paper:${reason}${retBps}`);
  appendLive({
    kind: 'paper_skip', ts: Math.floor(Date.now() / 1000),
    slug, paperSlug: slug, reason,
    retBps: record.retBps, betSide: record.betSide, paperTs: record.ts,
  });
}

async function processLine(line, state) {
  let rec;
  try { rec = JSON.parse(line); }
  catch { log('warn', `skip non-JSON line: ${line.slice(0, 60)}`); return; }
  if (rec.kind === 'entry') return handleEntry(rec, state);
  if (rec.kind === 'exit')  return handleExit(rec, state);
  if (rec.kind === 'skip')  return handlePaperSkip(rec);
}

async function main() {
  log('info', `strategy-live starting | dryRun=${DRY_RUN} paperLedger=${PAPER_LEDGER}`);
  log('info', `safety rails | perTrade=$${RAILS.PER_TRADE_USD} dailyLoss=$${RAILS.DAILY_LOSS_USD} concurrent=${RAILS.MAX_CONCURRENT}`);

  const state = loadState(DATA_DIR);
  log('info', `state | open=${openCount(state)} orderHistory=${Object.keys(state.orderHistory).length} todayPnl=$${dailyPnlForToday(state, Math.floor(Date.now()/1000)).toFixed(2)}`);

  if (!DRY_RUN) {
    await bootstrapClobClient({
      privateKey: process.env.POLYMARKET_PRIVATE_KEY,
      funderAddress: process.env.POLYMARKET_FUNDER_OVERRIDE,
    });
    log('info', 'clob client bootstrapped (POLY_1271)');
  }

  let stopping = false;
  process.on('SIGTERM', () => { log('info', 'SIGTERM received; draining'); stopping = true; });
  process.on('SIGINT',  () => { log('info', 'SIGINT received; draining');  stopping = true; });

  while (!stopping) {
    const lines = readNewLedgerLines();
    for (const line of lines) {
      try { await processLine(line, state); }
      catch (e) { log('ERROR', `unhandled in processLine: ${e.message}`); }
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  log('info', 'strategy-live exiting cleanly');
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
