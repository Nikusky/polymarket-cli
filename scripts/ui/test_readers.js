const assert = require('assert');
const path = require('path');
const { parseServiceFile, listVariants, readLedger, readState, readJournal, parseJournalOutput } = require('./readers');

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n    ${e.message}`); failed++; }
}

const FIX = path.join(__dirname, '__fixtures__');

(async () => {
console.log('== parseServiceFile ==');

await test('parses Environment vars into env object', () => {
  const src = [
    '[Unit]',
    'Description=test bot',
    '[Service]',
    'Environment=MAX_FILL_PRICE=0.85',
    'Environment=STRATEGY_BLACKOUT_HOURS=13,17,22',
    'ExecStart=/usr/bin/node /opt/polybot/polymarket-cli/scripts/strategy/main.js 9 6 100 168',
    '[Install]',
    'WantedBy=multi-user.target',
  ].join('\n');
  const r = parseServiceFile(src);
  assert.strictEqual(r.description, 'test bot');
  assert.deepStrictEqual(r.env, { MAX_FILL_PRICE: '0.85', STRATEGY_BLACKOUT_HOURS: '13,17,22' });
  assert.deepStrictEqual(r.execStart, ['/usr/bin/node', '/opt/polybot/polymarket-cli/scripts/strategy/main.js', '9', '6', '100', '168']);
  assert.deepStrictEqual(r.args, { observeMin: 9, threshBps: 6, positionUsd: 100, runtimeHours: 168 });
});

await test('returns {error} when ExecStart missing', () => {
  const r = parseServiceFile('[Unit]\nDescription=x\n[Service]\n');
  assert.ok(r.error, 'expected error field');
  assert.match(r.error, /ExecStart/);
});

await test('returns partial args {runtimeHours} for short ExecStart (mastercopy shape)', () => {
  const src = '[Service]\nExecStart=/usr/bin/node /main.js 168\n';
  const r = parseServiceFile(src);
  assert.ok(r.args, 'expected args object');
  assert.strictEqual(r.args.runtimeHours, 168);
  assert.strictEqual(r.error, undefined, 'no error for short but parseable ExecStart');
});

await test('returns args=null when ExecStart has no trailing numeric token', () => {
  const src = '[Service]\nExecStart=/usr/bin/node /main.js a b c d\n';
  const r = parseServiceFile(src);
  assert.strictEqual(r.args, null);
  assert.strictEqual(r.error, undefined, 'no error: ExecStart exists, just unparseable');
});

console.log('\n== listVariants ==');

await test('discovers all .service files under deployDir', () => {
  const v = listVariants(path.join(FIX, 'deploy'));
  const labels = v.map(x => x.label).sort();
  assert.deepStrictEqual(labels, ['d', 'malformed', 'mastercopy', 'mc-sells']);
});

await test('parses ok variant correctly', () => {
  const v = listVariants(path.join(FIX, 'deploy'));
  const d = v.find(x => x.label === 'd');
  assert.strictEqual(d.service, 'polybot-strategy-d');
  assert.strictEqual(d.env.MAX_FILL_PRICE, '0.92');
  assert.deepStrictEqual(d.args, { observeMin: 11, threshBps: 6, positionUsd: 100, runtimeHours: 168 });
  assert.strictEqual(d.dataDir, 'scripts/strategy/data-d');
});

await test('flags malformed variant with error but does not throw', () => {
  const v = listVariants(path.join(FIX, 'deploy'));
  const m = v.find(x => x.label === 'malformed');
  assert.ok(m.error, 'expected error field on malformed variant');
});

await test('parses mastercopy variant data dir', () => {
  const v = listVariants(path.join(FIX, 'deploy'));
  const mc = v.find(x => x.label === 'mastercopy');
  assert.strictEqual(mc.dataDir, 'scripts/mastercopy/data-mc');
});

await test('excludes non-variant unit files (polybot-snapshot)', () => {
  const v = listVariants(path.join(FIX, 'deploy'));
  const labels = v.map(x => x.label);
  assert.ok(!labels.includes('snapshot'), 'snapshot should not be in variants');
});

await test('mastercopy-sells variant gets label mc-sells', () => {
  const v = listVariants(path.join(FIX, 'deploy'));
  const mcs = v.find(x => x.label === 'mc-sells');
  assert.ok(mcs, 'expected mc-sells label');
  assert.strictEqual(mcs.service, 'polybot-mastercopy-sells');
  assert.strictEqual(mcs.dataDir, 'scripts/mastercopy/data-mc-sells');
});

console.log('\n== readLedger ==');

await test('reads ledger and parses every line', () => {
  const r = readLedger(path.join(FIX, 'scripts/strategy/data-d'));
  assert.strictEqual(r.records.length, 12, `got ${r.records.length}`);
});

await test('derives totals correctly', () => {
  const r = readLedger(path.join(FIX, 'scripts/strategy/data-d'));
  assert.strictEqual(r.totals.entries, 5);
  assert.strictEqual(r.totals.exits, 5);
  assert.strictEqual(r.totals.wins, 3);
  assert.strictEqual(r.totals.losses, 2);
  assert.strictEqual(r.totals.stopExits, 1);
  assert.strictEqual(r.totals.deployed, 500);
  assert.ok(Math.abs(r.totals.pnl - (-115.67)) < 0.01, `pnl was ${r.totals.pnl}`);
});

await test('cumulativePnl is array of [ts, runningTotal]', () => {
  const r = readLedger(path.join(FIX, 'scripts/strategy/data-d'));
  assert.ok(Array.isArray(r.cumulativePnl));
  assert.strictEqual(r.cumulativePnl.length, 5);
  assert.strictEqual(r.cumulativePnl[0][0], 1779000900);
  assert.ok(Math.abs(r.cumulativePnl[0][1] - 16.28) < 0.01);
  assert.ok(Math.abs(r.cumulativePnl[4][1] - (-115.67)) < 0.01);
});

await test('returns empty record set when dir missing', () => {
  const r = readLedger(path.join(FIX, 'scripts/strategy/does-not-exist'));
  assert.deepStrictEqual(r.records, []);
  assert.strictEqual(r.totals.exits, 0);
  assert.strictEqual(r.error, 'no ledger yet');
});

await test('parseErrors is 0 on clean fixture', () => {
  const r = readLedger(path.join(FIX, 'scripts/strategy/data-d'));
  assert.strictEqual(r.parseErrors, 0);
});

await test('parseErrors counts malformed JSON lines without throwing', () => {
  // Build a synthetic ledger with one good + one bad + one good line.
  const tmp = path.join(require('os').tmpdir(), `polybot-ui-test-${Date.now()}`);
  require('fs').mkdirSync(tmp, { recursive: true });
  require('fs').writeFileSync(path.join(tmp, 'strategy-ledger.jsonl'),
    '{"kind":"entry","ts":1,"paperCost":100}\n' +
    'this is not json\n' +
    '{"kind":"exit","ts":2,"won":true,"pnl":10}\n'
  );
  const r = readLedger(tmp);
  assert.strictEqual(r.records.length, 2, `expected 2 good records, got ${r.records.length}`);
  assert.strictEqual(r.parseErrors, 1, `expected 1 parseError, got ${r.parseErrors}`);
});

console.log('\n== readState ==');

await test('filters to open positions only', () => {
  const s = readState(path.join(FIX, 'scripts/strategy/data-d'));
  assert.strictEqual(s.positions.length, 1);
  assert.strictEqual(s.positions[0].slug, 'btc-updown-15m-1779999000');
});

await test('aggregates decision counts by reason', () => {
  const s = readState(path.join(FIX, 'scripts/strategy/data-d'));
  assert.strictEqual(s.decisionCounts.below_threshold, 1);
  assert.strictEqual(s.decisionCounts.entered, 1);
});

await test('returns empty shape when missing', () => {
  const s = readState(path.join(FIX, 'scripts/strategy/does-not-exist'));
  assert.deepStrictEqual(s.positions, []);
  assert.deepStrictEqual(s.decisionCounts, {});
});

console.log('\n== readJournal ==');

await test('parseJournalOutput extracts ts and message', () => {
  const out = '2026-05-24T16:00:00+0000 host pol[1]: [16:00:00] info  tick';
  const r = parseJournalOutput(out);
  assert.strictEqual(r.length, 1);
  assert.ok(r[0].ts > 1779000000, `ts not parsed: ${r[0].ts}`);
  assert.ok(r[0].message.includes('tick'));
});

await test('readJournal via fake binary returns lines', async () => {
  const fakeBin = path.join(FIX, 'fake-journalctl.js');
  const r = await readJournal('polybot-strategy-d', { bin: 'node', extraArgs: [fakeBin], lines: 200 });
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.lines.length, 2);
  assert.ok(r.lines[0].message.includes('tick'));
});

await test('readJournal returns error field on failure', async () => {
  const r = await readJournal('polybot-strategy-d', { bin: '/path/does/not/exist', lines: 200 });
  assert.strictEqual(r.lines.length, 0);
  assert.ok(r.error, 'expected error field');
});

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} - ${failed} failure(s)`);
  process.exit(failed === 0 ? 0 : 1);
})();
