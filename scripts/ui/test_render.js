const assert = require('assert');
const render = require('./public/render');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n    ${e.message}`); failed++; }
}

console.log('== render.parseHash ==');
test('default empty hash is overview', () => {
  assert.deepStrictEqual(render.parseHash(''), { view: 'overview' });
});
test('"#/" is overview', () => {
  assert.deepStrictEqual(render.parseHash('#/'), { view: 'overview' });
});
test('"#/variant/d" parses', () => {
  assert.deepStrictEqual(render.parseHash('#/variant/d'), { view: 'variant', label: 'd' });
});
test('"#/logs/k" parses', () => {
  assert.deepStrictEqual(render.parseHash('#/logs/k'), { view: 'logs', label: 'k' });
});
test('invalid hash falls back to overview', () => {
  assert.deepStrictEqual(render.parseHash('#/garbage/path/here'), { view: 'overview' });
});

console.log('\n== render.formatPnl ==');
test('positive pnl gets + prefix', () => {
  assert.strictEqual(render.formatPnl(16.56), '+$16.56');
});
test('negative pnl gets - prefix without double-sign', () => {
  assert.strictEqual(render.formatPnl(-100), '-$100.00');
});
test('zero pnl is $0.00', () => {
  assert.strictEqual(render.formatPnl(0), '$0.00');
});

console.log('\n== render.buildOverviewRow ==');
test('returns a tr string with WR and PnL', () => {
  const v = {
    label: 'd', description: 'BTC 15m', totals: { exits: 36, wins: 31, losses: 5, pnl: 16.56, deployed: 3600 },
    args: { observeMin: 11, threshBps: 6 }, env: { MAX_FILL_PRICE: '0.92' }, openCount: 0, error: null,
  };
  const row = render.buildOverviewRow(v);
  assert.ok(row.includes('<tr'), row);
  assert.ok(row.includes('D'));
  assert.ok(row.includes('86.1%'), `expected WR 86.1% in row: ${row}`);
  assert.ok(row.includes('+$16.56'));
});

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} - ${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);
