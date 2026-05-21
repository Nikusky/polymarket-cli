// Phase 2 strategy bot — paper mode.
//
// Strategy: at minute observe_min of each 15m BTC up/down market, check
// BTC's return from market open via the median of Coinbase + Kraken (a
// stand-in for the Chainlink BTC/USD stream that resolves these markets).
// If |return| > threshold, BUY the matching side at the prevailing ask.
// Hold to settlement.
//
// Paper mode only — no real orders. Writes append-only JSONL ledger.
//
// Usage:
//   node scripts/strategy/main.js [observeMin] [thresholdBps] [positionUsd] [runtimeHours]
// Defaults: 13 / 5 / 100 / 168

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { btcPrice } = require('./btc_price');

const CLI = (() => {
  const base = path.join(__dirname, '..', '..', 'target');
  const candidates = [
    path.join(base, 'release', 'polymarket'),
    path.join(base, 'release', 'polymarket.exe'),
    path.join(base, 'debug', 'polymarket'),
    path.join(base, 'debug', 'polymarket.exe'),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error(`polymarket binary not found; checked: ${candidates.join(', ')}`);
})();
const DATA_DIR = process.env.STRATEGY_DATA_DIR
  ? path.resolve(process.env.STRATEGY_DATA_DIR)
  : path.join(__dirname, 'data');
const LEDGER = path.join(DATA_DIR, 'strategy-ledger.jsonl');
const STATE = path.join(DATA_DIR, 'strategy-state.json');

const OBSERVE_MIN = parseInt(process.argv[2] || '13');
const THRESH_BPS = parseFloat(process.argv[3] || '5');
const POSITION_USD = parseFloat(process.argv[4] || '100');
const MAX_HOURS = parseFloat(process.argv[5] || '168');
const MAX_FILL_PRICE = parseFloat(process.env.MAX_FILL_PRICE || '0.95');
const MAX_OBS_BPS = parseFloat(process.env.MAX_OBS_BPS || 'Infinity');
const STOP_AT = Date.now() + MAX_HOURS * 3600 * 1000;
const POLL_MS = 2000;

fs.mkdirSync(DATA_DIR, { recursive: true });

function log(level, msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts.slice(11, 19)}] ${level.padEnd(5)} ${msg}`);
}
function append(record) { fs.appendFileSync(LEDGER, JSON.stringify(record) + '\n'); }
function loadState() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { decisions: {}, positions: {} }; } }
function saveState(s) { fs.writeFileSync(STATE, JSON.stringify(s)); }

function runCli(args, timeoutMs = 8000) {
  const r = spawnSync(CLI, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function fetchMarketBySlug(slug) {
  const r = runCli(['markets', 'get', slug, '--output', 'json']);
  if (r.code !== 0) return null;
  try {
    const m = JSON.parse(r.stdout);
    if (!m || !m.slug) return null;
    m._tokens = JSON.parse(m.clobTokenIds || '[]');
    m._outcomes = JSON.parse(m.outcomes || '[]');
    m._outcomePrices = JSON.parse(m.outcomePrices || '[]');
    return m;
  } catch { return null; }
}

function fetchBook(tokenId) {
  const r = runCli(['clob', 'book', tokenId, '--output', 'json'], 6000);
  if (r.code !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

function simulateFill(book, usdSize) {
  const asks = (book?.asks || []).slice().sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
  let remaining = usdSize, shares = 0, cost = 0;
  for (const lvl of asks) {
    const px = parseFloat(lvl.price), sz = parseFloat(lvl.size);
    const dollarsHere = px * sz;
    const spend = Math.min(remaining, dollarsHere);
    const sharesHere = spend / px;
    shares += sharesHere;
    cost += spend;
    remaining -= spend;
    if (remaining <= 0.01) break;
  }
  if (shares === 0) return null;
  return { shares, cost, avgPrice: cost / shares, filled: usdSize - remaining, unfilled: remaining };
}

async function makeDecision(openTs, state) {
  const slug = `btc-updown-15m-${openTs}`;
  if (state.decisions[slug]) return;

  const market = fetchMarketBySlug(slug);
  if (!market) { log('warn', `${slug} not listed`); return; }
  if (market.closed) { state.decisions[slug] = { reason: 'closed' }; saveState(state); return; }

  const btcOpen = await btcPrice(openTs);
  const btcNow = await btcPrice();
  if (!btcOpen || !btcNow) { log('warn', 'btc price unavailable'); return; }
  const retBps = Math.log(btcNow / btcOpen) * 10000;

  if (Math.abs(retBps) < THRESH_BPS) {
    log('skip', `${slug.slice(-10)}  retBps=${retBps.toFixed(2)} <${THRESH_BPS}`);
    state.decisions[slug] = { reason: 'below_threshold', retBps };
    append({ kind: 'skip', ts: Math.floor(Date.now()/1000), slug, retBps, reason: 'below_threshold' });
    saveState(state);
    return;
  }

  if (Math.abs(retBps) > MAX_OBS_BPS) {
    log('skip', `${slug.slice(-10)}  retBps=${retBps.toFixed(2)} >${MAX_OBS_BPS} (exhaustion zone)`);
    state.decisions[slug] = { reason: 'obs_too_high', retBps };
    append({ kind: 'skip', ts: Math.floor(Date.now()/1000), slug, retBps, reason: 'obs_too_high' });
    saveState(state);
    return;
  }

  const betSide = retBps > 0 ? 'Up' : 'Down';
  const sideIdx = market._outcomes.indexOf(betSide);
  if (sideIdx < 0) { log('warn', `no ${betSide} token`); return; }
  const tokenId = market._tokens[sideIdx];

  const book = fetchBook(tokenId);
  if (!book) { log('warn', 'book unavailable'); return; }
  const fill = simulateFill(book, POSITION_USD);
  if (!fill) { state.decisions[slug] = { reason: 'no_liquidity' }; saveState(state); return; }
  if (fill.avgPrice > MAX_FILL_PRICE) { log('skip', `avg fill ${fill.avgPrice.toFixed(3)} > ${MAX_FILL_PRICE} too high`); state.decisions[slug] = { reason: 'fill_too_high', avgPrice: fill.avgPrice }; append({ kind: 'skip', ts: Math.floor(Date.now()/1000), slug, reason: 'fill_too_high', avgPrice: fill.avgPrice }); saveState(state); return; }

  const pos = {
    slug, openTs, resolveTs: openTs + 900,
    decideTs: Math.floor(Date.now() / 1000), observeBps: retBps,
    betSide, tokenId, conditionId: market.conditionId,
    btcAtOpen: btcOpen, btcAtDecision: btcNow,
    paperShares: fill.shares, paperCost: fill.cost, avgFillPrice: fill.avgPrice,
    unfilledUsd: fill.unfilled,
    settled: false,
  };
  state.positions[slug] = pos;
  state.decisions[slug] = { reason: 'entered', avgFillPrice: fill.avgPrice };
  append({ kind: 'entry', ts: pos.decideTs, ...pos });
  log('ENTER', `${betSide} @ ${fill.avgPrice.toFixed(3)} × ${fill.shares.toFixed(1)} sh ($${fill.cost.toFixed(0)})  retBps=${retBps.toFixed(1)}  ${slug.slice(-10)}`);
  saveState(state);
}

async function settleOpenPositions(state) {
  const now = Math.floor(Date.now() / 1000);
  let dirty = false;
  for (const [slug, pos] of Object.entries(state.positions)) {
    if (pos.settled) continue;
    if (pos.resolveTs + 60 > now) continue;
    const m = fetchMarketBySlug(slug);
    if (!m) continue;
    if (!m.closed && pos.resolveTs + 600 > now) continue;
    const prices = m._outcomePrices;
    if (!prices || prices.length < 2) continue;
    const upPrice = parseFloat(prices[0]);
    const winner = upPrice > 0.5 ? 'Up' : 'Down';
    const won = pos.betSide === winner;
    const pnl = won ? pos.paperShares * (1 - pos.avgFillPrice) : -pos.paperCost;
    pos.settled = true;
    pos.actualWinner = winner;
    pos.realizedPnl = pnl;
    pos.settleTs = now;
    append({ kind: 'exit', ts: now, slug, won, winner, pnl, betSide: pos.betSide, avgFillPrice: pos.avgFillPrice, observeBps: pos.observeBps, paperShares: pos.paperShares, paperCost: pos.paperCost });
    log(won ? 'WIN ' : 'LOSS', `${pos.betSide} → ${winner}  pnl=$${pnl.toFixed(2)}  ${slug.slice(-10)}`);
    dirty = true;
  }
  if (dirty) saveState(state);
}

async function tick(state) {
  const now = Math.floor(Date.now() / 1000);
  const cur15m = now - (now % 900);
  const minuteInWin = (now - cur15m) / 60;
  if (minuteInWin >= OBSERVE_MIN && minuteInWin < OBSERVE_MIN + 1) {
    await makeDecision(cur15m, state);
  }
  await settleOpenPositions(state);
  // GC
  for (const slug of Object.keys(state.positions)) {
    if (state.positions[slug].settled && state.positions[slug].settleTs + 3600 < now) delete state.positions[slug];
  }
  for (const slug of Object.keys(state.decisions)) {
    const ep = parseInt(slug.replace('btc-updown-15m-', ''));
    if (ep && ep + 7200 < now) delete state.decisions[slug];
  }
  saveState(state);
}

async function main() {
  log('info', `strategy bot starting | observe=${OBSERVE_MIN} thresh=${THRESH_BPS}bps maxObs=${MAX_OBS_BPS}bps size=$${POSITION_USD} maxFill=${MAX_FILL_PRICE} runtime=${MAX_HOURS}h`);
  log('info', `ledger=${LEDGER}`);
  const state = loadState();
  while (Date.now() < STOP_AT) {
    try { await tick(state); } catch (e) { log('err', e.message); }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  log('info', 'runtime cap reached, exiting');
}

main();
