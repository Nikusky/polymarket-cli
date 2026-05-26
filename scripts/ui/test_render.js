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

console.log('\n== render.buildLedgerTable ==');
test('mirror record renders side + price + shares, not reason=?', () => {
  const records = [{
    kind: 'mirror', ts: 1779757039, slug: 'btc-updown-15m-1779756300',
    tradeSide: 'BUY', outcome: 'Up', masterPrice: 0.18, paperShares: 5.5555,
    openTs: 1779756300, resolveTs: 1779757200,
  }];
  const html = render.buildLedgerTable(records, 'all');
  assert.ok(html.includes('<td>mirror</td>'), 'kind cell missing');
  assert.ok(html.includes('>Up<') || html.includes('>BUY<'), `side cell missing: ${html}`);
  assert.ok(html.includes('@0.180'), `price not formatted: ${html}`);
  assert.ok(html.includes('5.6sh'), `shares not formatted: ${html}`);
  assert.ok(!html.includes('reason=?'), `should NOT fall through to reason=?: ${html}`);
});
test('skip record still shows reason', () => {
  const records = [{ kind: 'skip', ts: 1779757039, slug: 'x', reason: 'below_threshold' }];
  const html = render.buildLedgerTable(records, 'all');
  assert.ok(html.includes('reason=below_threshold'), html);
});
test('filter=mirror keeps only mirror rows', () => {
  const records = [
    { kind: 'entry', ts: 1, slug: 'a', avgFillPrice: 0.5, paperShares: 1 },
    { kind: 'mirror', ts: 2, slug: 'b', masterPrice: 0.3, paperShares: 2, tradeSide: 'BUY' },
  ];
  const html = render.buildLedgerTable(records, 'mirror');
  assert.ok(html.includes('<td>mirror</td>'));
  assert.ok(!html.includes('<td>entry</td>'));
});

console.log('\n== render.buildPositionsTable ==');
test('empty positions returns empty string', () => {
  assert.strictEqual(render.buildPositionsTable([]), '');
  assert.strictEqual(render.buildPositionsTable(null), '');
});
test('positions render as table, not JSON pre', () => {
  const positions = [{
    slug: 'btc-updown-15m-1779756300', tradeSide: 'BUY', outcome: 'Up',
    masterPrice: 0.18, paperShares: 5.5555, openTs: 1779756300, resolveTs: 1779757200,
  }];
  const html = render.buildPositionsTable(positions);
  assert.ok(html.includes('Open positions (1)'), html);
  assert.ok(html.includes('<table'), `should be a table: ${html}`);
  assert.ok(!html.includes('<pre>'), `should NOT be a JSON pre: ${html}`);
  assert.ok(html.includes('0.180'), `price col missing: ${html}`);
});

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} - ${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);
