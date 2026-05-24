const assert = require('assert');
const path = require('path');
const { parseServiceFile, listVariants, readLedger } = require('./readers');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n    ${e.message}`); failed++; }
}

console.log('== parseServiceFile ==');

test('parses Environment vars into env object', () => {
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

test('returns {error} when ExecStart missing', () => {
  const r = parseServiceFile('[Unit]\nDescription=x\n[Service]\n');
  assert.ok(r.error, 'expected error field');
  assert.match(r.error, /ExecStart/);
});

test('returns {error} when ExecStart has fewer than 6 tokens', () => {
  const src = '[Service]\nExecStart=/usr/bin/node /main.js\n';
  const r = parseServiceFile(src);
  assert.strictEqual(r.args, null);
  assert.ok(r.error, 'expected error field');
  assert.match(r.error, /fewer than 6/);
});

test('returns {error} when ExecStart args are non-numeric', () => {
  const src = '[Service]\nExecStart=/usr/bin/node /main.js a b c d\n';
  const r = parseServiceFile(src);
  assert.strictEqual(r.args, null);
  assert.ok(r.error, 'expected error field');
  assert.match(r.error, /not numeric/);
});

console.log('\n== listVariants ==');

const FIX = path.join(__dirname, '__fixtures__');

test('discovers all .service files under deployDir', () => {
  const v = listVariants(path.join(FIX, 'deploy'));
  const labels = v.map(x => x.label).sort();
  assert.deepStrictEqual(labels, ['d', 'malformed', 'mastercopy', 'mc-sells']);
});

test('parses ok variant correctly', () => {
  const v = listVariants(path.join(FIX, 'deploy'));
  const d = v.find(x => x.label === 'd');
  assert.strictEqual(d.service, 'polybot-strategy-d');
  assert.strictEqual(d.env.MAX_FILL_PRICE, '0.92');
  assert.deepStrictEqual(d.args, { observeMin: 11, threshBps: 6, positionUsd: 100, runtimeHours: 168 });
  assert.strictEqual(d.dataDir, 'scripts/strategy/data-d');
});

test('flags malformed variant with error but does not throw', () => {
  const v = listVariants(path.join(FIX, 'deploy'));
  const m = v.find(x => x.label === 'malformed');
  assert.ok(m.error, 'expected error field on malformed variant');
});

test('parses mastercopy variant data dir', () => {
  const v = listVariants(path.join(FIX, 'deploy'));
  const mc = v.find(x => x.label === 'mastercopy');
  assert.strictEqual(mc.dataDir, 'scripts/mastercopy/data-mc');
});

test('excludes non-variant unit files (polybot-snapshot)', () => {
  const v = listVariants(path.join(FIX, 'deploy'));
  const labels = v.map(x => x.label);
  assert.ok(!labels.includes('snapshot'), 'snapshot should not be in variants');
});

test('mastercopy-sells variant gets label mc-sells', () => {
  const v = listVariants(path.join(FIX, 'deploy'));
  const mcs = v.find(x => x.label === 'mc-sells');
  assert.ok(mcs, 'expected mc-sells label');
  assert.strictEqual(mcs.service, 'polybot-mastercopy-sells');
  assert.strictEqual(mcs.dataDir, 'scripts/mastercopy/data-mc-sells');
});

console.log('\n== readLedger ==');

test('reads ledger and parses every line', () => {
  const r = readLedger(path.join(FIX, 'scripts/strategy/data-d'));
  assert.strictEqual(r.records.length, 12, `got ${r.records.length}`);
});

test('derives totals correctly', () => {
  const r = readLedger(path.join(FIX, 'scripts/strategy/data-d'));
  assert.strictEqual(r.totals.entries, 5);
  assert.strictEqual(r.totals.exits, 5);
  assert.strictEqual(r.totals.wins, 3);
  assert.strictEqual(r.totals.losses, 2);
  assert.strictEqual(r.totals.stopExits, 1);
  assert.strictEqual(r.totals.deployed, 500);
  assert.ok(Math.abs(r.totals.pnl - (-115.67)) < 0.01, `pnl was ${r.totals.pnl}`);
});

test('cumulativePnl is array of [ts, runningTotal]', () => {
  const r = readLedger(path.join(FIX, 'scripts/strategy/data-d'));
  assert.ok(Array.isArray(r.cumulativePnl));
  assert.strictEqual(r.cumulativePnl.length, 5);
  assert.strictEqual(r.cumulativePnl[0][0], 1779000900);
  assert.ok(Math.abs(r.cumulativePnl[0][1] - 16.28) < 0.01);
  assert.ok(Math.abs(r.cumulativePnl[4][1] - (-115.67)) < 0.01);
});

test('returns empty record set when dir missing', () => {
  const r = readLedger(path.join(FIX, 'scripts/strategy/does-not-exist'));
  assert.deepStrictEqual(r.records, []);
  assert.strictEqual(r.totals.exits, 0);
  assert.strictEqual(r.error, 'no ledger yet');
});

test('parseErrors is 0 on clean fixture', () => {
  const r = readLedger(path.join(FIX, 'scripts/strategy/data-d'));
  assert.strictEqual(r.parseErrors, 0);
});

test('parseErrors counts malformed JSON lines without throwing', () => {
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

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} - ${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);
