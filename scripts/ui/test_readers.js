const assert = require('assert');
const path = require('path');
const { parseServiceFile, listVariants } = require('./readers');

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
  assert.deepStrictEqual(labels, ['d', 'malformed', 'mastercopy']);
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

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} - ${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);
