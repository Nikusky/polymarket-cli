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
const PRICE_MODULE = process.env.STRATEGY_PRICE_MODULE || './btc_price';
const { price: getPrice } = require(PRICE_MODULE);

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
const SLOT_SECS = parseInt(process.env.STRATEGY_SLOT_SECS || '900', 10);
const SLUG_PREFIX = process.env.STRATEGY_SLUG_PREFIX || 'btc-updown-15m-';
const BLACKOUT_HOURS = new Set(
  (process.env.STRATEGY_BLACKOUT_HOURS || '')
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n >= 0 && n < 24)
);
const RAW_SIDES = (process.env.STRATEGY_SIDES || 'both').toLowerCase();
const ALLOWED_SIDES = RAW_SIDES === 'up'
  ? new Set(['Up'])
  : RAW_SIDES === 'down'
    ? new Set(['Down'])
    : new Set(['Up', 'Down']);
const STOP_LOSS_RETBPS_REVERSAL = parseFloat(process.env.STOP_LOSS_RETBPS_REVERSAL || 'Infinity');
// Multi-entry / certainty-sized aggressive variant (default off = legacy behavior).
// MAX_ENTRIES_PER_SLOT=1 keeps single-entry semantics. >1 enables pyramiding while
// the signal keeps confirming. CERTAINTY_SIZING=true scales each entry's $-size by
// a [0,1] confidence score: signal in sweet spot + bps-continuation + fill cheapness.
// Each pyramid entry emits its own kind:"entry" ledger record with this-entry paperCost,
// so status.js/compare.js/readers.js sum deployed capital correctly. The final kind:"exit"
// still records aggregate paperCost (sum of all entries) for accurate PnL.
const MAX_ENTRIES_PER_SLOT = Math.max(1, parseInt(process.env.MAX_ENTRIES_PER_SLOT || '1', 10));
const MAX_SLOT_USD = parseFloat(process.env.MAX_SLOT_USD || String(POSITION_USD));
const RE_OBSERVE_INTERVAL_SECS = Math.max(0, parseInt(process.env.RE_OBSERVE_INTERVAL_SECS || '0', 10));
const RE_OBSERVE_END_BUFFER_SECS = Math.max(0, parseInt(process.env.RE_OBSERVE_END_BUFFER_SECS || '60', 10));
const CERTAINTY_SIZING = String(process.env.CERTAINTY_SIZING || 'false').toLowerCase() === 'true';
const CERTAINTY_MIN_USD = parseFloat(process.env.CERTAINTY_MIN_USD || '10');
const CERTAINTY_MAX_USD = parseFloat(process.env.CERTAINTY_MAX_USD || '150');
const RE_ENTRY_MIN_BPS_DELTA = parseFloat(process.env.RE_ENTRY_MIN_BPS_DELTA || '1');
// Fade-the-exhaustion mode (variant O). When true:
//   - bypass the MAX_OBS_BPS upper cap (we WANT extreme moves)
//   - bet the OPPOSITE side of the move (Up move -> buy Down)
// Empirical hook: |retBps|>10 is net-negative for the trend side across J/K/L/M,
// which means the contra side at that moment is net-positive by construction.
// Use a high THRESH_BPS (e.g. 15) and a tight MAX_FILL_PRICE (e.g. 0.25) so we
// only fire when the contra side is genuinely cheap. Multi-entry pyramiding is
// disabled in fade mode for now (its "continuation" semantics invert).
const FADE_EXHAUSTION = String(process.env.FADE_EXHAUSTION || 'false').toLowerCase() === 'true';
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

// Returns conviction in [0, 1] used to size the next buy.
//   absRet:        |retBps| right now, already validated in [THRESH_BPS, MAX_OBS_BPS]
//   lastEntryAbs:  |retBps| at the previous entry on this slot, or null for the first entry
//   estPrice:      estimated avg fill price for the contemplated size (top-of-book is fine)
// Four components, each 0–0.30, plus a 0.05 floor so a borderline-but-valid signal still buys
// the minimum tranche rather than emitting noise:
//   signalScore       — peaked at the midpoint of the [THRESH_BPS, MAX_OBS_BPS] sweet spot
//   continuationScore — first entry gets 0.15 (neutral); re-entries reward each extra bps of
//                       continuation up to 3 bps further
//   fillScore         — cheaper ask means more upside; linear from 0.50 → MAX_FILL_PRICE
//   baseScore         — 0.05 floor
function computeCertainty(absRet, lastEntryAbs, estPrice) {
  const range = MAX_OBS_BPS - THRESH_BPS;
  const mid = THRESH_BPS + range / 2;
  const signalScore = (absRet >= THRESH_BPS && absRet <= MAX_OBS_BPS && range > 0)
    ? 0.30 * (1 - Math.abs(absRet - mid) / (range / 2))
    : 0;
  let continuationScore;
  if (lastEntryAbs == null) {
    continuationScore = 0.15;
  } else {
    const delta = absRet - lastEntryAbs;
    continuationScore = Math.max(0, Math.min(0.30, (delta / 3) * 0.30));
  }
  const fillFloor = 0.50;
  const fillScore = estPrice <= fillFloor
    ? 0.30
    : estPrice >= MAX_FILL_PRICE
      ? 0
      : 0.30 * (1 - (estPrice - fillFloor) / (MAX_FILL_PRICE - fillFloor));
  const certainty = 0.05 + signalScore + continuationScore + fillScore;
  return Math.max(0, Math.min(1, certainty));
}

// Translate certainty to a dollar size, then clamp to remaining slot headroom.
// Returns null if there's no meaningful size left to deploy.
function sizeFromCertainty(certainty, slotUsedUsd) {
  const raw = certainty * CERTAINTY_MAX_USD;
  const clamped = Math.max(CERTAINTY_MIN_USD, Math.min(CERTAINTY_MAX_USD, raw));
  const headroom = MAX_SLOT_USD - slotUsedUsd;
  if (headroom < CERTAINTY_MIN_USD) return null;
  return Math.min(clamped, headroom);
}

function topAskPrice(book) {
  const asks = (book?.asks || []).slice().sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
  return asks.length ? parseFloat(asks[0].price) : null;
}

async function makeDecision(openTs, state) {
  const slug = `${SLUG_PREFIX}${openTs}`;
  if (state.decisions[slug]) return;

  if (BLACKOUT_HOURS.size) {
    const resolveHour = new Date((openTs + SLOT_SECS) * 1000).getUTCHours();
    if (BLACKOUT_HOURS.has(resolveHour)) {
      log('skip', `${slug.slice(-10)}  blackout hour ${resolveHour} UTC`);
      state.decisions[slug] = { reason: 'blackout_hour', hour: resolveHour };
      append({ kind: 'skip', ts: Math.floor(Date.now()/1000), slug, reason: 'blackout_hour', hour: resolveHour });
      saveState(state);
      return;
    }
  }

  const market = fetchMarketBySlug(slug);
  if (!market) { log('warn', `${slug} not listed`); return; }
  if (market.closed) { state.decisions[slug] = { reason: 'closed' }; saveState(state); return; }

  const pxOpen = await getPrice(openTs);
  const pxNow = await getPrice();
  if (!pxOpen || !pxNow) { log('warn', 'price unavailable'); return; }
  const retBps = Math.log(pxNow / pxOpen) * 10000;

  if (Math.abs(retBps) < THRESH_BPS) {
    log('skip', `${slug.slice(-10)}  retBps=${retBps.toFixed(2)} <${THRESH_BPS}`);
    state.decisions[slug] = { reason: 'below_threshold', retBps };
    append({ kind: 'skip', ts: Math.floor(Date.now()/1000), slug, retBps, reason: 'below_threshold' });
    saveState(state);
    return;
  }

  // Exhaustion cap applies only to trend mode. Fade mode WANTS the big moves.
  if (!FADE_EXHAUSTION && Math.abs(retBps) > MAX_OBS_BPS) {
    log('skip', `${slug.slice(-10)}  retBps=${retBps.toFixed(2)} >${MAX_OBS_BPS} (exhaustion zone)`);
    state.decisions[slug] = { reason: 'obs_too_high', retBps };
    append({ kind: 'skip', ts: Math.floor(Date.now()/1000), slug, retBps, reason: 'obs_too_high' });
    saveState(state);
    return;
  }

  // Trend mode bets WITH the move; fade mode bets AGAINST it (loser side, cheap).
  const betSide = FADE_EXHAUSTION
    ? (retBps > 0 ? 'Down' : 'Up')
    : (retBps > 0 ? 'Up' : 'Down');

  if (!ALLOWED_SIDES.has(betSide)) {
    log('skip', `${slug.slice(-10)}  wrong side ${betSide}  retBps=${retBps.toFixed(2)}`);
    state.decisions[slug] = { reason: 'wrong_side', betSide, retBps };
    append({ kind: 'skip', ts: Math.floor(Date.now()/1000), slug, retBps, reason: 'wrong_side', betSide });
    saveState(state);
    return;
  }

  const sideIdx = market._outcomes.indexOf(betSide);
  if (sideIdx < 0) { log('warn', `no ${betSide} token`); return; }
  const tokenId = market._tokens[sideIdx];

  const book = fetchBook(tokenId);
  if (!book) { log('warn', 'book unavailable'); return; }

  // Decide $-size: certainty-sized (variant N) or fixed POSITION_USD (legacy).
  let entryUsd = POSITION_USD;
  let certainty = null;
  if (CERTAINTY_SIZING) {
    const estPrice = topAskPrice(book) ?? MAX_FILL_PRICE;
    certainty = computeCertainty(Math.abs(retBps), null, estPrice);
    const sized = sizeFromCertainty(certainty, 0);
    if (sized == null) {
      log('skip', `${slug.slice(-10)}  no slot headroom for initial entry`);
      state.decisions[slug] = { reason: 'no_headroom' };
      append({ kind: 'skip', ts: Math.floor(Date.now()/1000), slug, reason: 'no_headroom' });
      saveState(state);
      return;
    }
    entryUsd = sized;
  }

  const fill = simulateFill(book, entryUsd);
  if (!fill) { state.decisions[slug] = { reason: 'no_liquidity' }; saveState(state); return; }
  if (fill.avgPrice > MAX_FILL_PRICE) { log('skip', `avg fill ${fill.avgPrice.toFixed(3)} > ${MAX_FILL_PRICE} too high`); state.decisions[slug] = { reason: 'fill_too_high', avgPrice: fill.avgPrice }; append({ kind: 'skip', ts: Math.floor(Date.now()/1000), slug, reason: 'fill_too_high', avgPrice: fill.avgPrice }); saveState(state); return; }

  const decideTs = Math.floor(Date.now() / 1000);
  const firstEntry = {
    entryIdx: 0, ts: decideTs, retBps,
    shares: fill.shares, cost: fill.cost, fillPrice: fill.avgPrice,
    certainty,
  };
  const pos = {
    slug, openTs, resolveTs: openTs + SLOT_SECS,
    decideTs, observeBps: retBps,
    betSide, tokenId, conditionId: market.conditionId,
    btcAtOpen: pxOpen, btcAtDecision: pxNow,
    paperShares: fill.shares, paperCost: fill.cost, avgFillPrice: fill.avgPrice,
    unfilledUsd: fill.unfilled,
    settled: false,
    entries: [firstEntry],
  };
  state.positions[slug] = pos;
  state.decisions[slug] = { reason: 'entered', avgFillPrice: fill.avgPrice };
  // Per-entry ledger record: paperCost here is THIS entry's cost (not aggregate) so
  // status.js/compare.js/readers.js sum deployed-capital correctly across re-entries.
  append({
    kind: 'entry', ts: decideTs, slug, openTs, resolveTs: pos.resolveTs,
    decideTs, observeBps: retBps, entryRetBps: retBps,
    betSide, tokenId, conditionId: market.conditionId,
    btcAtOpen: pxOpen, btcAtDecision: pxNow,
    paperShares: fill.shares, paperCost: fill.cost, avgFillPrice: fill.avgPrice,
    unfilledUsd: fill.unfilled, settled: false,
    entryIdx: 0, certainty,
  });
  const certStr = certainty != null ? ` cert=${certainty.toFixed(2)}` : '';
  log('ENTER', `${betSide} @ ${fill.avgPrice.toFixed(3)} × ${fill.shares.toFixed(1)} sh ($${fill.cost.toFixed(0)})  retBps=${retBps.toFixed(1)}${certStr}  ${slug.slice(-10)}`);
  saveState(state);
}

// Pyramid re-entry: while the same slot is still open and the signal keeps confirming
// (same direction, |retBps| still in [THRESH_BPS, MAX_OBS_BPS], moved further by at
// least RE_ENTRY_MIN_BPS_DELTA since the last entry), add another tranche. Each tranche
// is certainty-sized within the remaining MAX_SLOT_USD budget. Disabled when
// MAX_ENTRIES_PER_SLOT === 1 (legacy variants A/B/D/J/K/L/M).
async function considerReEntry(curSlot, state) {
  if (MAX_ENTRIES_PER_SLOT <= 1) return;
  // Fade mode pyramid is conceptually different (continuation = move further AGAINST
  // our bet means the contra side gets cheaper, not more confirmed). Not implemented
  // here — fade variants run single-entry until a dedicated re-entry rule lands.
  if (FADE_EXHAUSTION) return;
  const slug = `${SLUG_PREFIX}${curSlot}`;
  const pos = state.positions[slug];
  if (!pos || pos.settled) return;
  if (!pos.entries || pos.entries.length === 0) return; // not initialized via new path
  if (pos.entries.length >= MAX_ENTRIES_PER_SLOT) return;
  if (pos.paperCost >= MAX_SLOT_USD - CERTAINTY_MIN_USD) return;

  const now = Math.floor(Date.now() / 1000);
  if (pos.resolveTs - now <= RE_OBSERVE_END_BUFFER_SECS) return; // too close to settle
  const lastEntry = pos.entries[pos.entries.length - 1];
  if (RE_OBSERVE_INTERVAL_SECS > 0 && now - lastEntry.ts < RE_OBSERVE_INTERVAL_SECS) return;

  const pxOpen = await getPrice(pos.openTs);
  const pxNow = await getPrice();
  if (!pxOpen || !pxNow) return;
  const retBps = Math.log(pxNow / pxOpen) * 10000;
  const absRet = Math.abs(retBps);

  if (absRet < THRESH_BPS) return;          // signal lost
  if (absRet > MAX_OBS_BPS) return;          // exhaustion cap (strict per user choice)
  const curSide = retBps > 0 ? 'Up' : 'Down';
  if (curSide !== pos.betSide) return;       // direction flipped; stop-loss handles unwind
  const lastAbs = Math.abs(lastEntry.retBps);
  if (absRet < lastAbs + RE_ENTRY_MIN_BPS_DELTA) return; // no meaningful continuation

  const book = fetchBook(pos.tokenId);
  if (!book) return;
  const estPrice = topAskPrice(book) ?? MAX_FILL_PRICE;
  const certainty = computeCertainty(absRet, lastAbs, estPrice);
  const entryUsd = sizeFromCertainty(certainty, pos.paperCost);
  if (entryUsd == null) return;

  const fill = simulateFill(book, entryUsd);
  if (!fill) return;
  if (fill.avgPrice > MAX_FILL_PRICE) {
    append({ kind: 'skip', ts: now, slug, reason: 'fill_too_high_addon', avgPrice: fill.avgPrice, entryIdx: pos.entries.length });
    return;
  }

  // Aggregate update.
  const newShares = pos.paperShares + fill.shares;
  const newCost = pos.paperCost + fill.cost;
  const newEntryIdx = pos.entries.length;
  pos.entries.push({
    entryIdx: newEntryIdx, ts: now, retBps,
    shares: fill.shares, cost: fill.cost, fillPrice: fill.avgPrice,
    certainty,
  });
  pos.paperShares = newShares;
  pos.paperCost = newCost;
  pos.avgFillPrice = newCost / newShares;
  pos.btcAtDecision = pxNow;
  pos.unfilledUsd = (pos.unfilledUsd || 0) + fill.unfilled;

  // Per-entry ledger record (this entry's paperCost, not aggregate).
  append({
    kind: 'entry', ts: now, slug, openTs: pos.openTs, resolveTs: pos.resolveTs,
    decideTs: now, observeBps: pos.observeBps, entryRetBps: retBps,
    betSide: pos.betSide, tokenId: pos.tokenId, conditionId: pos.conditionId,
    btcAtOpen: pos.btcAtOpen, btcAtDecision: pxNow,
    paperShares: fill.shares, paperCost: fill.cost, avgFillPrice: fill.avgPrice,
    unfilledUsd: fill.unfilled, settled: false,
    entryIdx: newEntryIdx, certainty,
  });
  log('ADD  ', `${pos.betSide} #${newEntryIdx} @ ${fill.avgPrice.toFixed(3)} × ${fill.shares.toFixed(1)} sh ($${fill.cost.toFixed(0)})  retBps=${retBps.toFixed(1)} (+${(absRet - lastAbs).toFixed(1)}) cert=${certainty.toFixed(2)} slotTotal=$${newCost.toFixed(0)}  ${slug.slice(-10)}`);
  saveState(state);
}

// Stop-loss: if STOP_LOSS_RETBPS_REVERSAL is finite, on each tick recompute the
// current return-from-open in bps. If the move has reversed against our position
// by >= threshold, paper-sell the position at the current best-bid and book the
// recovered cash (or loss) as a stop-exit. Records `kind:"exit"` with
// `stoppedOut: true` and `winner: "stopped"` so existing aggregators keep working.
async function checkStopLoss(state) {
  if (!Number.isFinite(STOP_LOSS_RETBPS_REVERSAL)) return;
  const now = Math.floor(Date.now() / 1000);
  const open = Object.values(state.positions).filter(p => !p.settled && p.resolveTs > now);
  if (!open.length) return;

  // One price fetch per tick, shared across positions.
  const pxNow = await getPrice();
  if (!pxNow) return;

  let dirty = false;
  for (const pos of open) {
    const curRetBps = Math.log(pxNow / pos.btcAtOpen) * 10000;
    const reversal = pos.betSide === 'Up'
      ? pos.observeBps - curRetBps
      : curRetBps - pos.observeBps;
    if (reversal < STOP_LOSS_RETBPS_REVERSAL) continue;

    const book = fetchBook(pos.tokenId);
    if (!book) continue;
    const bids = (book.bids || []).slice().sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
    if (!bids.length) continue;
    // Walk the bid ladder to fully unwind `paperShares`.
    let remainingShares = pos.paperShares;
    let recovered = 0;
    for (const lvl of bids) {
      const px = parseFloat(lvl.price);
      const sz = parseFloat(lvl.size);
      const take = Math.min(remainingShares, sz);
      recovered += take * px;
      remainingShares -= take;
      if (remainingShares <= 1e-6) break;
    }
    // If the book couldn't absorb all shares, mark the unsold remainder as worthless
    // (settlement will assign 0 if loser side, so this is the conservative path).
    const avgExitPrice = recovered / (pos.paperShares - remainingShares || 1);
    const pnl = recovered - pos.paperCost;

    pos.settled = true;
    pos.stopped = true;
    pos.stopExitTs = now;
    pos.stopExitPrice = avgExitPrice;
    pos.realizedPnl = pnl;

    append({
      kind: 'exit', ts: now, slug: pos.slug,
      won: false, winner: 'stopped', stoppedOut: true,
      pnl, betSide: pos.betSide,
      avgFillPrice: pos.avgFillPrice, observeBps: pos.observeBps,
      paperShares: pos.paperShares, paperCost: pos.paperCost,
      stopExitPrice: avgExitPrice, entryRetBps: pos.observeBps, stopRetBps: curRetBps,
      unsoldShares: remainingShares,
    });
    log('STOP ', `${pos.betSide} bid=${avgExitPrice.toFixed(3)} recovered=$${recovered.toFixed(2)} pnl=$${pnl.toFixed(2)} reversal=${reversal.toFixed(1)}bps  ${pos.slug.slice(-10)}`);
    dirty = true;
  }
  if (dirty) saveState(state);
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
  const curSlot = now - (now % SLOT_SECS);
  const minuteInWin = (now - curSlot) / 60;
  if (minuteInWin >= OBSERVE_MIN && minuteInWin < OBSERVE_MIN + 1) {
    await makeDecision(curSlot, state);
  }
  if (MAX_ENTRIES_PER_SLOT > 1) {
    await considerReEntry(curSlot, state);
  }
  await checkStopLoss(state);
  await settleOpenPositions(state);
  // GC
  for (const slug of Object.keys(state.positions)) {
    if (state.positions[slug].settled && state.positions[slug].settleTs + 3600 < now) delete state.positions[slug];
  }
  for (const slug of Object.keys(state.decisions)) {
    const ep = parseInt(slug.replace(SLUG_PREFIX, ''), 10);
    if (ep && ep + Math.max(7200, SLOT_SECS * 8) < now) delete state.decisions[slug];
  }
  saveState(state);
}

async function main() {
  const blackoutStr = BLACKOUT_HOURS.size ? [...BLACKOUT_HOURS].sort((a, b) => a - b).join(',') : 'none';
  const stopStr = Number.isFinite(STOP_LOSS_RETBPS_REVERSAL) ? `${STOP_LOSS_RETBPS_REVERSAL}bps` : 'off';
  const multiStr = MAX_ENTRIES_PER_SLOT > 1
    ? `maxEntries=${MAX_ENTRIES_PER_SLOT} slotCap=$${MAX_SLOT_USD} reObs=${RE_OBSERVE_INTERVAL_SECS}s reDelta=${RE_ENTRY_MIN_BPS_DELTA}bps`
    : 'multi=off';
  const certStr = CERTAINTY_SIZING ? `certainty=$${CERTAINTY_MIN_USD}-$${CERTAINTY_MAX_USD}` : 'certainty=off';
  const modeStr = FADE_EXHAUSTION ? 'mode=fade' : 'mode=trend';
  log('info', `strategy bot starting | ${modeStr} market=${SLUG_PREFIX}* slot=${SLOT_SECS}s price=${PRICE_MODULE} observe=${OBSERVE_MIN} thresh=${THRESH_BPS}bps maxObs=${MAX_OBS_BPS}bps size=$${POSITION_USD} maxFill=${MAX_FILL_PRICE} sides=${RAW_SIDES} blackout=${blackoutStr} stopLoss=${stopStr} ${multiStr} ${certStr} runtime=${MAX_HOURS}h`);
  log('info', `ledger=${LEDGER}`);
  const state = loadState();
  while (Date.now() < STOP_AT) {
    try { await tick(state); } catch (e) { log('err', e.message); }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  log('info', 'runtime cap reached, exiting');
}

main();
