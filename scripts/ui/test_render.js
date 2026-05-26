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
test('live record renders side=BUY + filled shares (not reason=?)', () => {
  const records = [{
    kind: 'live', ts: 1779757039, slug: 'btc-updown-15m-1779756300',
    outcome: 'Up', avgFillPrice: 0.42, filledShares: 2.38, filledUsd: 1,
  }];
  const html = render.buildLedgerTable(records, 'all');
  assert.ok(html.includes('<td>live</td>'), 'kind cell missing');
  assert.ok(html.includes('>BUY<'), `side should be BUY, got: ${html}`);
  assert.ok(html.includes('@0.420'), `price not formatted: ${html}`);
  assert.ok(html.includes('2.38sh'), `filled shares not formatted: ${html}`);
  assert.ok(!html.includes('reason=?'), `should NOT fall through: ${html}`);
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
test('live positions show BUY + filled shares + filled usd', () => {
  const positions = [{
    slug: 'btc-updown-15m-1779756300', outcome: 'Up',
    avgFillPrice: 0.42, filledShares: 2.38, filledUsd: 1.00,
    openTs: 1779756300, resolveTs: 1779757200,
  }];
  const html = render.buildPositionsTable(positions);
  assert.ok(html.includes('>BUY<'), `side should be BUY, not outcome: ${html}`);
  assert.ok(html.includes('0.420'), `price col missing: ${html}`);
  assert.ok(html.includes('2.38'), `shares col missing (filledShares): ${html}`);
  assert.ok(html.includes('$1.00'), `cost col missing (filledUsd): ${html}`);
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

console.log('\n== render.resolveSince ==');
test('null/empty/all resolve to null (lifetime)', () => {
  assert.strictEqual(render.resolveSince(null), null);
  assert.strictEqual(render.resolveSince(''), null);
  assert.strictEqual(render.resolveSince('all'), null);
});
test('"24h" returns now - 86400 with explicit now', () => {
  const nowMs = 1748275200000;
  assert.strictEqual(render.resolveSince('24h', nowMs), Math.floor(nowMs / 1000) - 86400);
});
test('"7d" returns now - 7*86400', () => {
  const nowMs = 1748275200000;
  assert.strictEqual(render.resolveSince('7d', nowMs), Math.floor(nowMs / 1000) - 7 * 86400);
});
test('custom ISO string is parsed to unix seconds', () => {
  const ts = render.resolveSince('2026-05-25T14:00:00Z');
  assert.strictEqual(ts, Math.floor(Date.parse('2026-05-25T14:00:00Z') / 1000));
});
test('unparseable custom string returns null', () => {
  assert.strictEqual(render.resolveSince('not-a-date'), null);
});

console.log('\n== render.windowTotals ==');
const sampleRecords = [
  { kind: 'entry', ts: 100, paperCost: 1.0 },
  { kind: 'exit',  ts: 110, pnl:  0.50, won: true,  stoppedOut: false },
  { kind: 'entry', ts: 200, paperCost: 1.0 },
  { kind: 'exit',  ts: 210, pnl: -0.30, won: false, stoppedOut: true  },
  { kind: 'entry', ts: 300, paperCost: 2.0 },
  { kind: 'exit',  ts: 310, pnl:  0.40, won: true,  stoppedOut: false },
  { kind: 'skip',  ts: 305 },
];
test('null sinceTs walks every record (lifetime)', () => {
  const w = render.windowTotals(sampleRecords, null);
  assert.strictEqual(w.totals.entries, 3);
  assert.strictEqual(w.totals.exits, 3);
  assert.strictEqual(w.totals.wins, 2);
  assert.strictEqual(w.totals.losses, 1);
  assert.strictEqual(w.totals.stopExits, 1);
  assert.strictEqual(w.totals.pnl, 0.60);
  assert.strictEqual(w.totals.deployed, 4.0);
  assert.deepStrictEqual(w.cumulativePnl, [[110, 0.5], [210, 0.2], [310, 0.6]]);
});
test('sinceTs drops earlier records and re-zeros cumulativePnl', () => {
  const w = render.windowTotals(sampleRecords, 200);
  assert.strictEqual(w.totals.entries, 2);
  assert.strictEqual(w.totals.exits, 2);
  assert.strictEqual(w.totals.wins, 1);
  assert.strictEqual(w.totals.losses, 1);
  assert.strictEqual(w.totals.stopExits, 1);
  assert.strictEqual(w.totals.pnl, 0.10);
  assert.strictEqual(w.totals.deployed, 3.0);
  assert.deepStrictEqual(w.cumulativePnl, [[210, -0.3], [310, 0.1]]);
});
test('sinceTs past all records yields empty totals', () => {
  const w = render.windowTotals(sampleRecords, 999);
  assert.strictEqual(w.totals.entries, 0);
  assert.strictEqual(w.totals.exits, 0);
  assert.strictEqual(w.totals.pnl, 0);
  assert.deepStrictEqual(w.cumulativePnl, []);
});
test('undefined records returns zeroed totals', () => {
  const w = render.windowTotals(undefined, null);
  assert.strictEqual(w.totals.entries, 0);
  assert.strictEqual(w.totals.exits, 0);
  assert.deepStrictEqual(w.cumulativePnl, []);
});
test('mirror and live kinds count as entries with cost fallback', () => {
  const recs = [
    { kind: 'mirror', ts: 1, masterPrice: 0.5, paperShares: 2 },
    { kind: 'live',   ts: 2, filledUsd: 2.5 },
  ];
  const w = render.windowTotals(recs, null);
  assert.strictEqual(w.totals.entries, 2);
  assert.strictEqual(w.totals.deployed, 3.5);
});

console.log('\n== render.buildRangePicker ==');
test('default ("all") marks the All button active', () => {
  const html = render.buildRangePicker('all');
  assert.ok(/class="range-btn active" data-since="all"/.test(html), html);
  assert.ok(html.includes('data-since="24h"'), html);
  assert.ok(html.includes('data-since="7d"'), html);
  assert.ok(html.includes('data-since="30d"'), html);
});
test('"7d" preset marks only the 7d button active', () => {
  const html = render.buildRangePicker('7d');
  assert.ok(/class="range-btn active" data-since="7d"/.test(html), html);
  assert.ok(!/class="range-btn active" data-since="all"/.test(html), html);
});
test('custom datetime spec marks Apply button active and prefills input', () => {
  const html = render.buildRangePicker('2026-05-25T14:00');
  assert.ok(html.includes('value="2026-05-25T14:00"'), html);
  assert.ok(/class="range-btn active" id="range-apply"/.test(html), html);
});
test('buildRangeLabel reads "all-time" for null', () => {
  assert.strictEqual(render.buildRangeLabel(null), 'all-time');
});
test('buildRangeLabel formats timestamp as "since YYYY-MM-DD HH:MMZ"', () => {
  const ts = Math.floor(Date.parse('2026-05-25T14:00:00Z') / 1000);
  assert.strictEqual(render.buildRangeLabel(ts), 'since 2026-05-25 14:00Z');
});

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} - ${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);
