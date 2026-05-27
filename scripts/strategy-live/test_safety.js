const assert = require('assert');
const { checkPerTradeSize, checkDailyLossKill, checkConcurrentCap, allClear, RAILS } = require('./safety');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n    ${e.message}`); failed++; }
}

console.log('== RAILS constants ==');
test('PER_TRADE_USD = 100', () => assert.strictEqual(RAILS.PER_TRADE_USD, 100));
test('DAILY_LOSS_USD = -150', () => assert.strictEqual(RAILS.DAILY_LOSS_USD, -150));
test('MAX_CONCURRENT = 3', () => assert.strictEqual(RAILS.MAX_CONCURRENT, 3));

console.log('\n== checkPerTradeSize ==');
test('passes when <= 100', () => {
  assert.deepStrictEqual(checkPerTradeSize(100), { ok: true });
});
test('fails when > 100', () => {
  const r = checkPerTradeSize(100.01);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /size_exceeds/);
});

console.log('\n== checkDailyLossKill ==');
test('passes when daily PnL >= -150', () => {
  assert.deepStrictEqual(checkDailyLossKill(-149.99), { ok: true });
});
test('fails when daily PnL < -150', () => {
  const r = checkDailyLossKill(-150.01);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /daily_loss_kill/);
});
test('passes at exactly -150 (inclusive boundary)', () => {
  assert.deepStrictEqual(checkDailyLossKill(-150), { ok: true });
});

console.log('\n== checkConcurrentCap ==');
test('passes when open positions < 3', () => {
  assert.deepStrictEqual(checkConcurrentCap(2), { ok: true });
});
test('fails when open positions >= 3', () => {
  const r = checkConcurrentCap(3);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /concurrent_cap/);
});

console.log('\n== allClear composite ==');
test('returns ok when all three pass', () => {
  assert.deepStrictEqual(allClear({ sizeUsd: 100, dailyPnl: -100, openCount: 1 }), { ok: true });
});
test('returns first failing reason', () => {
  const r = allClear({ sizeUsd: 200, dailyPnl: -100, openCount: 1 });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /size_exceeds/);
});
test('returns daily_loss_kill when size ok but pnl bad', () => {
  const r = allClear({ sizeUsd: 100, dailyPnl: -400, openCount: 1 });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /daily_loss_kill/);
});

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} - ${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);
