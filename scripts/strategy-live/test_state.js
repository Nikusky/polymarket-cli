const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadState, saveState, recordOrder, hasOrderFor, addRealizedPnl, dailyPnlForToday, defaultState } = require('./state');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n    ${e.message}`); failed++; }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'polybot-state-test-'));
}

console.log('== defaultState shape ==');
test('contains positions, orderHistory, dailyPnl, killSwitch', () => {
  const s = defaultState();
  assert.deepStrictEqual(s.positions, {});
  assert.deepStrictEqual(s.orderHistory, {});
  assert.deepStrictEqual(s.dailyPnl, {});
  assert.deepStrictEqual(s.killSwitch, { active: false, reason: null });
});

console.log('\n== loadState / saveState round-trip ==');
test('saves and reloads identical state', () => {
  const dir = tmpDir();
  const s = defaultState();
  s.positions['btc-updown-15m-123'] = { clobOrderId: '0xabc', shares: 100.5, betSide: 'Up' };
  s.killSwitch = { active: true, reason: 'daily_loss_kill' };
  saveState(dir, s);
  const back = loadState(dir);
  assert.deepStrictEqual(back, s);
});
test('loadState returns defaultState when file missing', () => {
  const dir = tmpDir();
  assert.deepStrictEqual(loadState(dir), defaultState());
});

console.log('\n== idempotency: recordOrder / hasOrderFor ==');
test('hasOrderFor returns false for unseen slug', () => {
  const s = defaultState();
  assert.strictEqual(hasOrderFor(s, 'btc-updown-15m-999'), false);
});
test('recordOrder registers slug -> clobOrderId mapping', () => {
  const s = defaultState();
  recordOrder(s, 'btc-updown-15m-999', '0xdeadbeef');
  assert.strictEqual(hasOrderFor(s, 'btc-updown-15m-999'), true);
  assert.strictEqual(s.orderHistory['btc-updown-15m-999'], '0xdeadbeef');
});

console.log('\n== addRealizedPnl / dailyPnlForToday ==');
test('addRealizedPnl accumulates under the UTC day key', () => {
  const s = defaultState();
  const ts = Date.UTC(2026, 4, 27, 12, 0, 0) / 1000;
  addRealizedPnl(s, ts, 5.50);
  addRealizedPnl(s, ts + 60, -2.25);
  assert.strictEqual(s.dailyPnl['2026-05-27'], 3.25);
});
test('addRealizedPnl with crossed UTC day uses correct bucket', () => {
  const s = defaultState();
  const tsDay1 = Date.UTC(2026, 4, 27, 23, 50, 0) / 1000;
  const tsDay2 = Date.UTC(2026, 4, 28, 0, 10, 0) / 1000;
  addRealizedPnl(s, tsDay1, 10);
  addRealizedPnl(s, tsDay2, -3);
  assert.strictEqual(s.dailyPnl['2026-05-27'], 10);
  assert.strictEqual(s.dailyPnl['2026-05-28'], -3);
});
test('dailyPnlForToday returns 0 when no entries for today', () => {
  const s = defaultState();
  const ts = Date.UTC(2026, 4, 27, 12, 0, 0) / 1000;
  assert.strictEqual(dailyPnlForToday(s, ts), 0);
});

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} - ${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);
