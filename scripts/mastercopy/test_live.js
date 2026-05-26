// Tests for the live executor's pure helpers (./live-lib.js).
// Run: node scripts/mastercopy/test_live.js
//
// Does not network. Does not exercise the daemon's CLI shell-outs or
// settlement loop — those depend on a built Rust binary and the data-api.

const assert = require('assert');
const { priceCap, decideFill, checkRiskGates, rollingPnl, bestAskFromBook } = require('./live-lib');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n    ${e.message}`); }
}

console.log('== priceCap ==');
test('rounds up to nearest 0.001 tick', () => {
  // 0.45 * 1.10 = 0.495 exactly
  assert.strictEqual(priceCap(0.45, 1.10), 0.495);
});
test('rounds non-tick-aligned product UP', () => {
  // 0.44 * 1.10 = 0.484 — already on tick
  assert.strictEqual(priceCap(0.44, 1.10), 0.484);
  // 0.443 * 1.10 = 0.4873 -> ceil to 0.488
  assert.strictEqual(priceCap(0.443, 1.10), 0.488);
});
test('caps at 0.999 (no $1 fills)', () => {
  assert.strictEqual(priceCap(0.95, 1.10), 0.999);
});
test('rejects bad masterPrice', () => {
  assert.strictEqual(priceCap(0, 1.10), null);
  assert.strictEqual(priceCap(-0.5, 1.10), null);
  assert.strictEqual(priceCap(NaN, 1.10), null);
});
test('rejects capMultiplier <= 1 (would not cross spread)', () => {
  assert.strictEqual(priceCap(0.5, 1.0), null);
  assert.strictEqual(priceCap(0.5, 0.9), null);
});

console.log('== decideFill ==');
test('go when ask below cap', () => {
  const r = decideFill(0.45, 0.43, 5, 1.10);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.limitPrice, 0.495);
  assert.ok(Math.abs(r.shares - 5 / 0.495) < 1e-9, `shares ${r.shares}`);
});
test('go when ask exactly at cap', () => {
  const r = decideFill(0.45, 0.495, 5, 1.10);
  assert.strictEqual(r.ok, true);
});
test('skip when ask above cap', () => {
  const r = decideFill(0.45, 0.55, 5, 1.10);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'cap_exceeded');
  assert.strictEqual(r.cap, 0.495);
});
test('skip when book empty', () => {
  const r = decideFill(0.45, null, 5, 1.10);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no_book');
});
test('skip when ask is non-positive', () => {
  assert.strictEqual(decideFill(0.45, 0, 5, 1.10).reason, 'no_book');
  assert.strictEqual(decideFill(0.45, -0.1, 5, 1.10).reason, 'no_book');
});
test('skip when ask is >= 1 (no edge)', () => {
  assert.strictEqual(decideFill(0.45, 1.0, 5, 1.10).reason, 'no_book');
  assert.strictEqual(decideFill(0.45, 1.5, 5, 1.10).reason, 'no_book');
});

console.log('== checkRiskGates ==');
const baseGates = { minBalanceUsd: 200, maxDailyLossUsd: 300, maxConcurrent: 150 };
const baseCtx = { balanceUsd: 1500, dailyPnl: 0, openCount: 10, killFileExists: false, gates: baseGates };

test('go when everything healthy', () => {
  assert.deepStrictEqual(checkRiskGates(baseCtx), { ok: true });
});
test('kill file beats everything else', () => {
  const r = checkRiskGates({ ...baseCtx, killFileExists: true, balanceUsd: 1, dailyPnl: -9999, openCount: 9999 });
  assert.strictEqual(r.reason, 'kill_file');
});
test('drawdown_kill triggers at exact threshold', () => {
  assert.strictEqual(checkRiskGates({ ...baseCtx, dailyPnl: -300 }).reason, 'drawdown_kill');
  assert.strictEqual(checkRiskGates({ ...baseCtx, dailyPnl: -299.99 }).ok, true);
});
test('drawdown also triggers if user passed positive maxDailyLossUsd', () => {
  // Defensive: someone setting MAX_DAILY_LOSS_USD=300 (positive) should still trigger at pnl=-300.
  assert.strictEqual(checkRiskGates({ ...baseCtx, dailyPnl: -301 }).reason, 'drawdown_kill');
});
test('low_balance when below min', () => {
  assert.strictEqual(checkRiskGates({ ...baseCtx, balanceUsd: 199.99 }).reason, 'low_balance');
});
test('low_balance when balance is NaN (read failure)', () => {
  assert.strictEqual(checkRiskGates({ ...baseCtx, balanceUsd: NaN }).reason, 'low_balance');
});
test('max_concurrent at the boundary', () => {
  assert.strictEqual(checkRiskGates({ ...baseCtx, openCount: 150 }).reason, 'max_concurrent');
  assert.strictEqual(checkRiskGates({ ...baseCtx, openCount: 149 }).ok, true);
});

console.log('== rollingPnl ==');
test('returns 0 on empty / non-array input', () => {
  assert.strictEqual(rollingPnl([], 1000, 86400), 0);
  assert.strictEqual(rollingPnl(null, 1000, 86400), 0);
});
test('sums only exit records inside the window', () => {
  const recs = [
    { kind: 'live',   ts: 900, pnl: 5 },          // ignored — not exit
    { kind: 'exit',   ts: 500, pnl: 5 },          // outside window
    { kind: 'exit',   ts: 950, pnl: 3 },          // inside
    { kind: 'exit',   ts: 960, pnl: -1.5 },       // inside
    { kind: 'skip_live', ts: 970, pnl: 100 },     // ignored — not exit
    { kind: 'exit',   ts: 980, pnl: NaN },        // skipped, not summed
  ];
  // Now=1000, window=100 → since=900
  assert.strictEqual(rollingPnl(recs, 1000, 100), 1.5);
});
test('ignores entries with malformed ts', () => {
  const recs = [{ kind: 'exit', ts: 'oops', pnl: 100 }, { kind: 'exit', ts: 950, pnl: 5 }];
  assert.strictEqual(rollingPnl(recs, 1000, 100), 5);
});

console.log('== bestAskFromBook ==');
test('returns first ask price for object-form rows', () => {
  const book = { asks: [{ price: '0.43', size: '100' }, { price: '0.44', size: '50' }] };
  assert.strictEqual(bestAskFromBook(book), 0.43);
});
test('returns first ask price for tuple-form rows', () => {
  const book = { asks: [[0.43, 100], [0.44, 50]] };
  assert.strictEqual(bestAskFromBook(book), 0.43);
});
test('null when book is missing or empty', () => {
  assert.strictEqual(bestAskFromBook(null), null);
  assert.strictEqual(bestAskFromBook({}), null);
  assert.strictEqual(bestAskFromBook({ asks: [] }), null);
});
test('null when ask price is invalid', () => {
  assert.strictEqual(bestAskFromBook({ asks: [{ price: '0' }] }), null);
  assert.strictEqual(bestAskFromBook({ asks: [{ price: '1.5' }] }), null);
  assert.strictEqual(bestAskFromBook({ asks: [{ price: 'oops' }] }), null);
});

if (failed === 0) console.log(`\nPASS — all assertions in ${process.argv[1].split(/[\\/]/).pop()}`);
else { console.log(`\nFAIL — ${failed} assertion(s)`); process.exit(1); }
