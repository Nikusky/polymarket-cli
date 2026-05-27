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
test('"#/compare" is the compare view', () => {
  assert.deepStrictEqual(render.parseHash('#/compare'), { view: 'compare' });
});
test('"#/compare/" trailing slash also parses as compare', () => {
  assert.deepStrictEqual(render.parseHash('#/compare/'), { view: 'compare' });
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

console.log('\n== render.liveArmState ==');
test('returns null for paper variants', () => {
  assert.strictEqual(render.liveArmState({ mode: 'paper', serviceActive: 'active' }), null);
});
test('returns "armed" when live + active + DRY_RUN missing', () => {
  assert.strictEqual(render.liveArmState({ mode: 'live', serviceActive: 'active', env: {} }), 'armed');
});
test('returns "armed" when DRY_RUN explicitly false', () => {
  assert.strictEqual(render.liveArmState({ mode: 'live', serviceActive: 'active', env: { DRY_RUN: 'false' } }), 'armed');
});
test('returns "dry_run" when DRY_RUN=true (lowercase)', () => {
  assert.strictEqual(render.liveArmState({ mode: 'live', serviceActive: 'active', env: { DRY_RUN: 'true' } }), 'dry_run');
});
test('returns "dry_run" when DRY_RUN=TRUE (uppercase tolerated)', () => {
  assert.strictEqual(render.liveArmState({ mode: 'live', serviceActive: 'active', env: { DRY_RUN: 'TRUE' } }), 'dry_run');
});
test('returns "disarmed" when serviceActive=inactive regardless of DRY_RUN', () => {
  assert.strictEqual(render.liveArmState({ mode: 'live', serviceActive: 'inactive', env: { DRY_RUN: 'true' } }), 'disarmed');
  assert.strictEqual(render.liveArmState({ mode: 'live', serviceActive: 'failed',   env: { DRY_RUN: 'false' } }), 'disarmed');
});
test('returns "disarmed" when serviceActive is missing', () => {
  assert.strictEqual(render.liveArmState({ mode: 'live', env: { DRY_RUN: 'false' } }), 'disarmed');
});

console.log('\n== render.liveArmBadge ==');
test('renders green ARMED badge when armed', () => {
  const html = render.liveArmBadge({ mode: 'live', serviceActive: 'active', env: { DRY_RUN: 'false' } });
  assert.ok(html.includes('mode-armed'), html);
  assert.ok(html.includes('>ARMED<'), html);
});
test('renders yellow DRY RUN badge when in dry-run', () => {
  const html = render.liveArmBadge({ mode: 'live', serviceActive: 'active', env: { DRY_RUN: 'true' } });
  assert.ok(html.includes('mode-dry-run'), html);
  assert.ok(html.includes('>DRY RUN<'), html);
});
test('renders DISARMED badge when inactive', () => {
  const html = render.liveArmBadge({ mode: 'live', serviceActive: 'inactive', env: { DRY_RUN: 'true' } });
  assert.ok(html.includes('mode-disarmed'), html);
  assert.ok(html.includes('>DISARMED<'), html);
});
test('returns empty string for paper variants', () => {
  assert.strictEqual(render.liveArmBadge({ mode: 'paper', serviceActive: 'active' }), '');
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

console.log('\n== render.buildOverviewSection ==');
const sampleVariants = [
  { label: 'mc-live', mode: 'live', totals: { exits: 4, wins: 2, losses: 2, pnl: -0.24, deployed: 12 }, openCount: 1, description: 'real money' },
  { label: 'd',       mode: 'paper', totals: { exits: 12, wins: 8, losses: 4, pnl: 86.82, deployed: 24 }, openCount: 0, description: 'paper d' },
];
test('empty variants list returns empty string (no header)', () => {
  assert.strictEqual(render.buildOverviewSection('Live (real money)', []), '');
  assert.strictEqual(render.buildOverviewSection('Live (real money)', null), '');
});
test('builds a section with title, optional note, and overview table', () => {
  const html = render.buildOverviewSection('Live (real money)', [sampleVariants[0]], { note: 'on-chain CLOB orders', cls: 'live' });
  assert.ok(html.includes('class="overview-section live"'), html);
  assert.ok(html.includes('Live (real money)'), html);
  assert.ok(html.includes('section-note'), html);
  assert.ok(html.includes('on-chain CLOB orders'), html);
  assert.ok(html.includes('MC-LIVE'), html);
  assert.ok(!html.includes('>D<'), 'paper variant should not leak in: ' + html);
});
test('paper section does not include live variant', () => {
  const html = render.buildOverviewSection('Paper', [sampleVariants[1]], { cls: 'paper' });
  assert.ok(html.includes('overview-section paper'), html);
  assert.ok(html.includes('>D '), html);
  assert.ok(!html.includes('MC-LIVE'), html);
});

console.log('\n== render.buildVariantSpec mode badge ==');
test('live variant gets operational badge, no redundant LIVE label', () => {
  // Disarmed by default (no serviceActive) → DISARMED badge, no separate LIVE.
  const html = render.buildVariantSpec({ label: 'mc-live', mode: 'live', service: 'polybot-mastercopy-live', env: {}, args: {} });
  assert.ok(html.includes('mode-disarmed'), html);
  assert.ok(html.includes('DISARMED'), html);
  assert.ok(!html.includes('mode-live'), `should not show redundant LIVE badge: ${html}`);
  assert.ok(!html.includes('mode-paper'), html);
});
test('live + active + DRY_RUN=true → only DRY RUN badge', () => {
  const html = render.buildVariantSpec({
    label: 'live-s', mode: 'live', service: 'polybot-strategy-live-s',
    serviceActive: 'active', env: { DRY_RUN: 'true' }, args: {},
  });
  assert.ok(html.includes('mode-dry-run'), html);
  assert.ok(html.includes('DRY RUN'), html);
  assert.ok(!html.includes('mode-live'), `should not show redundant LIVE badge: ${html}`);
});
test('paper variant gets a PAPER badge', () => {
  const html = render.buildVariantSpec({ label: 'd', mode: 'paper', service: 'polybot-strategy-d', env: {}, args: {} });
  assert.ok(html.includes('badge mode-paper'), html);
  assert.ok(html.includes('PAPER'), html);
  assert.ok(!html.includes('mode-live'), html);
});
test('missing mode defaults to PAPER badge', () => {
  const html = render.buildVariantSpec({ label: 'd', service: 'polybot-strategy-d', env: {}, args: {} });
  assert.ok(html.includes('badge mode-paper'), html);
});

console.log('\n== render.computeRiskMetrics ==');
test('empty inputs return zeroed metrics with null sharpe', () => {
  const m = render.computeRiskMetrics([], []);
  assert.strictEqual(m.maxDrawdown, 0);
  assert.strictEqual(m.days, 0);
  assert.strictEqual(m.bestDay, 0);
  assert.strictEqual(m.worstDay, 0);
  assert.strictEqual(m.sharpe, null);
});
test('maxDrawdown is peak-to-trough $ decline', () => {
  // running pnl: 0 -> +5 -> +2 -> +8 -> +1. Peak=8, trough-after-peak=1, DD=7.
  const cum = [[1, 5], [2, 2], [3, 8], [4, 1]];
  const m = render.computeRiskMetrics(cum, []);
  assert.strictEqual(m.maxDrawdown, 7);
});
test('monotonically rising series has zero drawdown', () => {
  const cum = [[1, 1], [2, 2], [3, 3], [4, 4]];
  const m = render.computeRiskMetrics(cum, []);
  assert.strictEqual(m.maxDrawdown, 0);
});
test('dailyPnlStats buckets exits by UTC day', () => {
  // Two exits on 2026-05-26 (+5 and -1), one on 2026-05-27 (+2). Best=4, worst=2.
  const records = [
    { kind: 'exit', ts: Math.floor(Date.parse('2026-05-26T01:00:00Z') / 1000), pnl: 5, won: true },
    { kind: 'exit', ts: Math.floor(Date.parse('2026-05-26T23:00:00Z') / 1000), pnl: -1, won: false },
    { kind: 'exit', ts: Math.floor(Date.parse('2026-05-27T05:00:00Z') / 1000), pnl: 2, won: true },
  ];
  const m = render.computeRiskMetrics([], records);
  assert.strictEqual(m.days, 2);
  assert.strictEqual(m.bestDay, 4);   // +5 + -1
  assert.strictEqual(m.worstDay, 2);  // +2
  assert.ok(m.sharpe != null);
});

console.log('\n== render.computePerTradeMetrics ==');
test('avg PnL/exit and avg cost/entry from totals', () => {
  const totals = { entries: 4, exits: 4, wins: 3, losses: 1, stopExits: 0, pnl: 12.0, deployed: 40.0 };
  const records = [
    { kind: 'exit', ts: 1, won: true,  pnl: 5 },
    { kind: 'exit', ts: 2, won: true,  pnl: 4 },
    { kind: 'exit', ts: 3, won: true,  pnl: 6 },
    { kind: 'exit', ts: 4, won: false, pnl: -3 },
  ];
  const m = render.computePerTradeMetrics(totals, records);
  assert.strictEqual(m.avgPnlPerExit, 3);     // 12/4
  assert.strictEqual(m.avgCostPerEntry, 10);  // 40/4
  assert.strictEqual(m.avgWin, 5);            // (5+4+6)/3
  assert.strictEqual(m.avgLoss, -3);          // -3/1
  assert.strictEqual(m.payoffRatio, 1.67);    // |5/-3|
  assert.strictEqual(m.streak, '1L');
});
test('streak detects consecutive wins from the end', () => {
  const records = [
    { kind: 'exit', ts: 1, won: false, pnl: -1 },
    { kind: 'exit', ts: 2, won: true,  pnl: 2 },
    { kind: 'exit', ts: 3, won: true,  pnl: 3 },
    { kind: 'exit', ts: 4, won: true,  pnl: 4 },
  ];
  const m = render.computePerTradeMetrics({ entries: 4, exits: 4, pnl: 8, deployed: 0 }, records);
  assert.strictEqual(m.streak, '3W');
});
test('no exits yields safe zeros and "-" streak', () => {
  const m = render.computePerTradeMetrics({ entries: 0, exits: 0, pnl: 0, deployed: 0 }, []);
  assert.strictEqual(m.avgPnlPerExit, 0);
  assert.strictEqual(m.avgWin, 0);
  assert.strictEqual(m.avgLoss, 0);
  assert.strictEqual(m.payoffRatio, null);
  assert.strictEqual(m.streak, '-');
});

console.log('\n== render.buildCompareView ==');
const compareVariants = [
  { label: 'd', mode: 'paper', openCount: 0,
    totals: { entries: 4, exits: 4, wins: 3, losses: 1, stopExits: 0, pnl: 12, deployed: 40 },
    cumulativePnl: [[1, 5], [2, 8], [3, 12]],
    rangeRecords: [
      { kind: 'entry', ts: 1, paperCost: 10 },
      { kind: 'exit', ts: 2, pnl: 5, won: true  },
      { kind: 'exit', ts: 3, pnl: 4, won: true  },
      { kind: 'exit', ts: 4, pnl: 6, won: true  },
      { kind: 'exit', ts: 5, pnl: -3, won: false },
    ] },
  { label: 'j', mode: 'paper', openCount: 1,
    totals: { entries: 2, exits: 2, wins: 0, losses: 2, stopExits: 1, pnl: -4, deployed: 20 },
    cumulativePnl: [[1, -1], [2, -4]],
    rangeRecords: [
      { kind: 'exit', ts: 1, pnl: -1, won: false },
      { kind: 'exit', ts: 2, pnl: -3, won: false, stoppedOut: true },
    ] },
];
test('selector renders checked state for selected labels only', () => {
  const html = render.buildCompareSelector(compareVariants, new Set(['d']));
  assert.ok(/data-label="d"\s+checked/.test(html), html);
  assert.ok(/data-label="j"(?!\s+checked)/.test(html), html);
  assert.ok(html.includes('Select all'), html);
  assert.ok(html.includes('Paper only'), html);
});
test('table shows a prompt when nothing is selected', () => {
  const html = render.buildCompareTable(compareVariants, new Set());
  assert.ok(html.includes('Select at least one variant'), html);
});
test('table renders one row per selected variant with core + risk + per-trade columns', () => {
  const html = render.buildCompareTable(compareVariants, new Set(['d', 'j']));
  assert.ok(html.includes('class="compare-table"'), html);
  assert.ok(html.includes('>D '), html);
  assert.ok(html.includes('>J '), html);
  assert.ok(html.includes('+$12.00'), html);   // D PnL
  assert.ok(html.includes('-$4.00'), html);    // J PnL
  assert.ok(html.includes('30.0%'),  html);    // D ROI = 12/40 = 30%
  assert.ok(html.includes('75.0%'),  html);    // D WR = 3/4
  assert.ok(html.includes('50.0%'),  html);    // J stop-rate = 1/2
  // Headers for all three metric groups.
  assert.ok(html.includes('MaxDD'), html);
  assert.ok(html.includes('Sharpe-ish'), html);
  assert.ok(html.includes('Payoff'), html);
  assert.ok(html.includes('Streak'), html);
});
test('full compare view includes range picker, controls, table, and chart canvas', () => {
  const html = render.buildCompareView(
    { variants: compareVariants },
    new Set(['d']),
    '7d'
  );
  assert.ok(html.includes('data-role="range"'), html);              // range picker present
  assert.ok(html.includes('data-role="compare-controls"'), html);   // selector present
  assert.ok(html.includes('class="compare-table"'), html);          // table present
  assert.ok(html.includes('<canvas id="chart"'), html);             // chart canvas present
});

console.log('\n== render.buildCompareSpecs ==');
const specsVariants = [
  { label: 'k', args: { observeMin: 11, threshBps: 6, positionUsd: 100 },
    env: { MAX_FILL_PRICE: '0.92', STRATEGY_BLACKOUT_HOURS: '13,17,22', STOP_LOSS_RETBPS_REVERSAL: '10' } },
  { label: 'p', args: { observeMin: 11, threshBps: 6, positionUsd: 100 },
    env: { MAX_FILL_PRICE: '0.92', MAX_OBS_BPS: '12', STOP_LOSS_RETBPS_REVERSAL: '10' } },
  { label: 'q', args: { observeMin: 11, threshBps: 6, positionUsd: 100 },
    env: { MAX_FILL_PRICE: '0.92', MAX_OBS_BPS_UP: 'Infinity', MAX_OBS_BPS_DOWN: '10', STOP_LOSS_RETBPS_REVERSAL: '10' } },
  { label: 'r', args: { observeMin: 11, threshBps: 6, positionUsd: 100 },
    env: { MAX_FILL_PRICE: '0.92', SIZE_BUCKETS_USD: '6:150,7:100,10:50,12:0', STOP_LOSS_RETBPS_REVERSAL: '10' } },
];
test('empty selection returns empty string', () => {
  assert.strictEqual(render.buildCompareSpecs(specsVariants, new Set()), '');
});
test('specs table renders one row per selected variant with spec columns', () => {
  const html = render.buildCompareSpecs(specsVariants, new Set(['k', 'p', 'q', 'r']));
  assert.ok(html.includes('class="compare-table compare-specs"'), html);
  assert.ok(html.includes('<th>K</th>'), html);
  assert.ok(html.includes('<th>P</th>'), html);
  assert.ok(html.includes('<th>Q</th>'), html);
  assert.ok(html.includes('<th>R</th>'), html);
  assert.ok(html.includes('13,17,22'), html);
  assert.ok(html.includes('Up=Infinity / Down=10'), html);
  assert.ok(html.includes('buckets[6:150,7:100,10:50,12:0]'), html);
  assert.ok(html.includes('>12<'), html);
  assert.ok(/<td>none<\/td>/.test(html), html);
  assert.ok(html.includes('thresh (bps)'), html);
  assert.ok(html.includes('maxObs (bps)'), html);
  assert.ok(html.includes('blackout'), html);
});
test('size cell falls back to fixed $positionUsd when no sizer env is set', () => {
  const html = render.buildCompareSpecs(specsVariants, new Set(['k']));
  assert.ok(html.includes('$100'), html);
});
test('full compare view now includes the specs table', () => {
  const html = render.buildCompareView(
    { variants: specsVariants },
    new Set(['k', 'p']),
    '7d'
  );
  assert.ok(html.includes('class="compare-table compare-specs"'), html);
  assert.ok(html.includes('class="compare-table"'), html);
});

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} - ${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);
