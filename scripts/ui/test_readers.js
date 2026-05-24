const assert = require('assert');
const { parseServiceFile } = require('./readers');

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

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} - ${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);
