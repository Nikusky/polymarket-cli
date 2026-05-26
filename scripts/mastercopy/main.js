// Mastercopy daemon — paper "what-if" simulator of cE25 / b55fa / ohanism trades.
//
// Limitation: this is NOT a real copy. The master's fill came from a maker order
// they placed earlier; we observe it post-trade. The simulation answers
// "what if we received the master's exact fill at the master's exact price?"
// Useful to validate that master BUYs are profitable post-fill; NOT a recipe
// for replicating their results in live trading.
//
// Env:
//   STRATEGY_DATA_DIR     - where to write ledger + state (default ./data)
//   MASTER_ADDRESSES      - CSV of proxy wallet addresses
//   MIRROR_SIZE_USD       - paper cost per copy (default 1)
//   SLUG_PREFIXES         - CSV of slug prefixes to follow (default btc-updown-15m-)
//   POLL_INTERVAL_SEC     - how often to query data-api (default 30)
//
// CLI:  node scripts/mastercopy/main.js [runtimeHours]

const fs = require('fs');
const path = require('path');
const {
  selectNewTrades,
  buildMirror,
  settleMirror,
  advanceLastSeen,
  isFresh,
} = require('./lib');

const DATA_DIR = process.env.STRATEGY_DATA_DIR
  ? path.resolve(process.env.STRATEGY_DATA_DIR)
  : path.join(__dirname, 'data');
const LEDGER = path.join(DATA_DIR, 'strategy-ledger.jsonl');
const STATE = path.join(DATA_DIR, 'strategy-state.json');

const MASTERS = (process.env.MASTER_ADDRESSES || '0xce25e214d5cfe4f459cf67f08df581885aae7fdc,0xb55fa1296e6ec55d0ce53d93b9237389f11764d4,0x89b5cdaaa4866c1e738406712012a630b4078beb')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const SLUG_PREFIXES = (process.env.SLUG_PREFIXES || 'btc-updown-15m-')
  .split(',').map((s) => s.trim()).filter(Boolean);

const MIRROR_SIZE_USD = parseFloat(process.env.MIRROR_SIZE_USD || '1');
// MIRROR_MODE = 'FLAT' (default; paperSize = MIRROR_SIZE_USD per fill) or
// 'SCALED' (paperShares = master's actual trade.size; paperSize = shares * price).
// SCALED tracks what we'd realize at the master's real notional; FLAT measures
// edge-per-fill independent of master size. MIRROR_SIZE_USD is ignored in SCALED.
const MIRROR_MODE = (process.env.MIRROR_MODE || 'FLAT').toUpperCase() === 'SCALED' ? 'SCALED' : 'FLAT';
const POLL_INTERVAL_SEC = parseInt(process.env.POLL_INTERVAL_SEC || '30', 10);
// Trades whose slot resolved more than MAX_LAG_SEC ago are dropped — we can't
// usefully paper-mirror them (gamma prunes old closed markets).
const MAX_LAG_SEC = parseInt(process.env.MAX_LAG_SEC || '7200', 10);
// MIRROR_SIDES picks which half of the master's flow to paper-replicate.
// Default 'BUY' = legacy behaviour. Set to 'SELL' to test the inverse hypothesis
// (the masters' SELL flow is the profitable half) or 'BUY,SELL' for both.
const MIRROR_SIDES = new Set(
  (process.env.MIRROR_SIDES || 'BUY').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
);
const MAX_HOURS = parseFloat(process.argv[2] || '168');
const STOP_AT = Date.now() + MAX_HOURS * 3600 * 1000;

fs.mkdirSync(DATA_DIR, { recursive: true });

function log(level, msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts.slice(11, 19)}] ${level.padEnd(5)} ${msg}`);
}
function append(record) { fs.appendFileSync(LEDGER, JSON.stringify(record) + '\n'); }
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); }
  catch { return { lastSeenByMaster: {}, positions: {} }; }
}
function saveState(s) { fs.writeFileSync(STATE, JSON.stringify(s)); }

const HEADERS = { 'User-Agent': 'polybot-mastercopy/1.0', 'Accept': 'application/json' };
async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: HEADERS });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function fetchMasterTrades(addr, limit = 50) {
  try {
    const url = `https://data-api.polymarket.com/trades?user=${addr}&limit=${limit}`;
    const data = await getJson(url);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    log('warn', `fetch trades failed for ${addr.slice(0, 8)}: ${e.message}`);
    return [];
  }
}

async function gammaWinner(slug) {
  try {
    const url = `https://gamma-api.polymarket.com/markets?slug=${slug}&closed=true`;
    const data = await getJson(url);
    if (!data || data.length === 0) return null;
    const m = data[0];
    if (!m.closed) return null;
    const prices = JSON.parse(m.outcomePrices || '["0","0"]');
    if (prices.length < 2) return null;
    return parseFloat(prices[0]) > 0.5 ? 'Up' : 'Down';
  } catch (e) {
    return null;
  }
}

function positionKey(mirror) {
  return `${mirror.master}|${mirror.slug}|${mirror.masterTxHash}`;
}

async function pollOnce(state, deps = {}) {
  const fetchTrades = deps.fetchTrades || fetchMasterTrades;
  const fetchWinner = deps.fetchWinner || gammaWinner;
  const nowFn = deps.now || (() => Math.floor(Date.now() / 1000));

  const newMirrors = [];
  for (const addr of MASTERS) {
    const trades = await fetchTrades(addr);
    const candidates = selectNewTrades(trades, {
      slugPrefixes: SLUG_PREFIXES,
      lastSeenByMaster: state.lastSeenByMaster,
      allowedSides: MIRROR_SIDES,
    });
    for (const t of candidates) {
      if (!isFresh(t, nowFn(), MAX_LAG_SEC)) continue;
      const m = buildMirror(t, MIRROR_SIZE_USD, nowFn(), MIRROR_MODE);
      if (!m) continue;
      const key = positionKey(m);
      if (state.positions[key]) continue;
      state.positions[key] = { ...m, settled: false };
      append(m);
      newMirrors.push(m);
      log('MIRROR', `${(m.masterName || m.master.slice(0, 8))} ${m.outcome} @ ${m.masterPrice.toFixed(3)} ` +
                    `${m.slug.slice(-10)} (min ${m.minuteInSlot.toFixed(1)})`);
    }
    advanceLastSeen(state.lastSeenByMaster, candidates);
  }

  const now = nowFn();
  let settledCount = 0;
  for (const [key, pos] of Object.entries(state.positions)) {
    if (pos.settled) continue;
    if (pos.resolveTs + 60 > now) continue;
    const winner = await fetchWinner(pos.slug);
    if (!winner) continue;
    const exit = settleMirror(pos, winner, now);
    pos.settled = true;
    pos.actualWinner = winner;
    pos.realizedPnl = exit.pnl;
    pos.settleTs = now;
    append(exit);
    log(exit.won ? 'WIN  ' : 'LOSS ', `${exit.outcome}->${winner} pnl=$${exit.pnl.toFixed(4)} ${exit.slug.slice(-10)}`);
    settledCount++;
  }

  for (const key of Object.keys(state.positions)) {
    const p = state.positions[key];
    if (p.settled && p.settleTs + 3600 < now) delete state.positions[key];
  }

  saveState(state);
  return { newMirrors: newMirrors.length, settled: settledCount };
}

async function main() {
  const sizeLabel = MIRROR_MODE === 'SCALED' ? 'master.size' : `$${MIRROR_SIZE_USD}`;
  log('info', `mastercopy starting | mode=${MIRROR_MODE} masters=${MASTERS.length} ` +
              `prefixes=${SLUG_PREFIXES.join(',')} sides=${[...MIRROR_SIDES].join('/')} ` +
              `size=${sizeLabel} poll=${POLL_INTERVAL_SEC}s maxLag=${MAX_LAG_SEC}s runtime=${MAX_HOURS}h`);
  log('info', `ledger=${LEDGER}`);
  const state = loadState();
  while (Date.now() < STOP_AT) {
    try { await pollOnce(state); }
    catch (e) { log('err', e.message); }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_SEC * 1000));
  }
  log('info', 'runtime cap reached, exiting');
}

if (require.main === module) main();

module.exports = { pollOnce, positionKey, loadState, saveState };
