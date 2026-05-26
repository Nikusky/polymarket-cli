// Pure helpers for the live executor. No I/O. Testable.
//
// The live executor (./live.js) wires these to the polymarket Rust CLI and
// data-api polling. Keep this file dependency-free so test_live.js can run
// without a network or a built binary.

// Compute the marketable-limit price cap for a BUY: masterPrice × capMultiplier,
// rounded UP to the nearest tick so the limit lands on a valid Polymarket price.
// Polymarket binary tick size is 0.001 for most markets and 0.01 for spread markets;
// 0.001 is the conservative default — orders at finer ticks are silently rejected.
function priceCap(masterPrice, capMultiplier, tickSize = 0.001) {
  if (!Number.isFinite(masterPrice) || masterPrice <= 0) return null;
  if (!Number.isFinite(capMultiplier) || capMultiplier <= 1) return null;
  const raw = masterPrice * capMultiplier;
  // 1e-9 epsilon absorbs IEEE-754 drift before the ceil — e.g. 0.45 * 1.10
  // evaluates to 0.49500000000000005, and `Math.ceil(495.000…6)` would
  // otherwise bump to 496 (one tick high), giving us worse-than-intended fills.
  const ticks = Math.ceil(raw / tickSize - 1e-9);
  const px = Math.min(0.999, ticks * tickSize);
  return Math.round(px * 10000) / 10000;
}

// Decide whether to enter on a master trade, given the current ask side of the book.
// Returns { ok:true, limitPrice, shares } on go, { ok:false, reason, cap } on skip.
function decideFill(masterPrice, bestAsk, sizeUsd, capMultiplier) {
  const cap = priceCap(masterPrice, capMultiplier);
  if (cap === null) return { ok: false, reason: 'bad_master_price' };
  if (!Number.isFinite(bestAsk) || bestAsk <= 0 || bestAsk >= 1) {
    return { ok: false, reason: 'no_book', cap };
  }
  if (bestAsk > cap) return { ok: false, reason: 'cap_exceeded', cap };
  const limitPrice = cap;
  const shares = sizeUsd / limitPrice;
  return { ok: true, limitPrice, shares };
}

// Evaluate the risk-gate ladder. Order matters: kill-switch first (cheapest),
// then drawdown (already-committed loss is most urgent), then balance, then
// concurrency. Returns { ok:true } or { ok:false, reason }.
function checkRiskGates(ctx) {
  const { balanceUsd, dailyPnl, openCount, killFileExists, gates } = ctx;
  if (killFileExists) return { ok: false, reason: 'kill_file' };
  if (dailyPnl <= -Math.abs(gates.maxDailyLossUsd)) return { ok: false, reason: 'drawdown_kill' };
  if (!Number.isFinite(balanceUsd) || balanceUsd < gates.minBalanceUsd) return { ok: false, reason: 'low_balance' };
  if (openCount >= gates.maxConcurrent) return { ok: false, reason: 'max_concurrent' };
  return { ok: true };
}

// Sum realized PnL from exit records within the last windowSec seconds.
// Used by the daily-drawdown kill switch — pure function so tests don't
// need to manipulate a real ledger file.
function rollingPnl(records, nowTs, windowSec) {
  if (!Array.isArray(records)) return 0;
  const since = nowTs - windowSec;
  let pnl = 0;
  for (const r of records) {
    if (!r || r.kind !== 'exit') continue;
    if (typeof r.ts !== 'number' || r.ts < since) continue;
    const v = Number(r.pnl);
    if (Number.isFinite(v)) pnl += v;
  }
  return pnl;
}

// Parse the best ask from a CLOB book response. Polymarket's `clob book --output json`
// returns { asks: [{price, size}, ...], bids: [...] } with asks sorted ascending.
function bestAskFromBook(book) {
  if (!book || !Array.isArray(book.asks) || book.asks.length === 0) return null;
  const a = book.asks[0];
  const px = parseFloat(a.price ?? a[0]);
  if (!Number.isFinite(px) || px <= 0 || px >= 1) return null;
  return px;
}

module.exports = { priceCap, decideFill, checkRiskGates, rollingPnl, bestAskFromBook };
