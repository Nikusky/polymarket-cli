// Tests for main.js env parsing and slot/slug generalization.
// Run: node scripts/strategy/test_config.js

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const HERE = __dirname;

function runMain(env, args = ['11', '5', '100', '0.001']) {
  const fullEnv = { ...process.env, ...env, STRATEGY_DATA_DIR: '/tmp/polybot-test-' + Date.now() };
  const r = spawnSync('node', [path.join(HERE, 'main.js'), ...args], {
    env: fullEnv,
    encoding: 'utf8',
    timeout: 10000,
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok ${name}`);
  } catch (e) {
    console.log(`  FAIL ${name}\n    ${e.message}`);
    failed++;
  }
}

console.log('== Syntax check ==');
const synCheck = spawnSync('node', ['-c', path.join(HERE, 'main.js')], { encoding: 'utf8' });
test('main.js parses', () => assert.strictEqual(synCheck.status, 0, synCheck.stderr));

const synEth = spawnSync('node', ['-c', path.join(HERE, 'eth_price.js')], { encoding: 'utf8' });
test('eth_price.js parses', () => assert.strictEqual(synEth.status, 0, synEth.stderr));

const synBtc = spawnSync('node', ['-c', path.join(HERE, 'btc_price.js')], { encoding: 'utf8' });
test('btc_price.js parses', () => assert.strictEqual(synBtc.status, 0, synBtc.stderr));

console.log('\n== Module exports ==');
const btc = require('./btc_price');
const eth = require('./eth_price');
test('btc_price exports price (alias)',  () => assert.strictEqual(typeof btc.price, 'function'));
test('btc_price exports btcPrice',       () => assert.strictEqual(typeof btc.btcPrice, 'function'));
test('btc_price.price === btc_price.btcPrice', () => assert.strictEqual(btc.price, btc.btcPrice));
test('eth_price exports price',          () => assert.strictEqual(typeof eth.price, 'function'));
test('eth_price exports ethPrice',       () => assert.strictEqual(typeof eth.ethPrice, 'function'));
test('eth_price.price === eth_price.ethPrice', () => assert.strictEqual(eth.price, eth.ethPrice));
test('eth_price has median utility',     () => assert.strictEqual(typeof eth.median, 'function'));
test('eth median([1,2,3]) = 2',          () => assert.strictEqual(eth.median([1, 2, 3]), 2));
test('eth median([1,2,3,4]) = 2.5',      () => assert.strictEqual(eth.median([1, 2, 3, 4]), 2.5));
test('eth median([]) = null',            () => assert.strictEqual(eth.median([]), null));
test('eth median drops NaN/0',           () => assert.strictEqual(eth.median([NaN, 0, 5, 7]), 6));

console.log('\n== main.js startup log (no network) ==');

// Default 15m BTC (current production behavior)
{
  const r = runMain({});
  test('default startup shows market=btc-updown-15m-*', () => {
    assert.ok(r.stdout.includes('market=btc-updown-15m-*'), r.stdout || r.stderr);
  });
  test('default startup shows slot=900s', () => {
    assert.ok(r.stdout.includes('slot=900s'));
  });
  test('default startup shows price=./btc_price', () => {
    assert.ok(r.stdout.includes('price=./btc_price'));
  });
  test('default startup shows sides=both', () => {
    assert.ok(r.stdout.includes('sides=both'));
  });
  test('default startup shows stopLoss=off', () => {
    assert.ok(r.stdout.includes('stopLoss=off'), r.stdout);
  });
}

// Stop-loss enabled
{
  const r = runMain({ STOP_LOSS_RETBPS_REVERSAL: '10' });
  test('STOP_LOSS_RETBPS_REVERSAL=10 startup shows stopLoss=10bps', () => {
    assert.ok(r.stdout.includes('stopLoss=10bps'), r.stdout || r.stderr);
  });
}

// 5m BTC variant
{
  const r = runMain({
    STRATEGY_SLOT_SECS: '300',
    STRATEGY_SLUG_PREFIX: 'btc-updown-5m-',
  }, ['3', '3', '100', '0.001']);
  test('5m startup shows market=btc-updown-5m-*', () => {
    assert.ok(r.stdout.includes('market=btc-updown-5m-*'), r.stdout || r.stderr);
  });
  test('5m startup shows slot=300s', () => {
    assert.ok(r.stdout.includes('slot=300s'));
  });
  test('5m startup shows observe=3', () => {
    assert.ok(r.stdout.includes('observe=3 '));
  });
}

// ETH 15m variant
{
  const r = runMain({
    STRATEGY_SLUG_PREFIX: 'eth-updown-15m-',
    STRATEGY_PRICE_MODULE: './eth_price',
  }, ['11', '8', '100', '0.001']);
  test('ETH startup shows market=eth-updown-15m-*', () => {
    assert.ok(r.stdout.includes('market=eth-updown-15m-*'), r.stdout || r.stderr);
  });
  test('ETH startup shows price=./eth_price', () => {
    assert.ok(r.stdout.includes('price=./eth_price'));
  });
}

// Combined: 5m ETH theoretical
{
  const r = runMain({
    STRATEGY_SLOT_SECS: '300',
    STRATEGY_SLUG_PREFIX: 'eth-updown-5m-',
    STRATEGY_PRICE_MODULE: './eth_price',
    STRATEGY_BLACKOUT_HOURS: '13,17,22',
    STRATEGY_SIDES: 'up',
    MAX_OBS_BPS: '7',
    MAX_FILL_PRICE: '0.92',
  }, ['3', '3', '100', '0.001']);
  test('combined startup shows all envs together', () => {
    const want = [
      'market=eth-updown-5m-*',
      'slot=300s',
      'price=./eth_price',
      'sides=up',
      'blackout=13,17,22',
      'maxObs=7',
      'maxFill=0.92',
    ];
    for (const w of want) assert.ok(r.stdout.includes(w), `missing: ${w}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  });
}

console.log('\n== Slot detection (logic-only) ==');

function curSlot(now, slotSecs) {
  return now - (now % slotSecs);
}
function resolveHour(openTs, slotSecs) {
  return new Date((openTs + slotSecs) * 1000).getUTCHours();
}

test('15m slot at 21:47:33 -> opens at 21:45:00', () => {
  const ts = Date.UTC(2026, 4, 21, 21, 47, 33) / 1000;
  const slot = curSlot(ts, 900);
  assert.strictEqual(new Date(slot * 1000).toISOString(), '2026-05-21T21:45:00.000Z');
});
test('5m slot at 21:47:33 -> opens at 21:45:00', () => {
  const ts = Date.UTC(2026, 4, 21, 21, 47, 33) / 1000;
  const slot = curSlot(ts, 300);
  assert.strictEqual(new Date(slot * 1000).toISOString(), '2026-05-21T21:45:00.000Z');
});
test('5m slot at 21:43:10 -> opens at 21:40:00', () => {
  const ts = Date.UTC(2026, 4, 21, 21, 43, 10) / 1000;
  const slot = curSlot(ts, 300);
  assert.strictEqual(new Date(slot * 1000).toISOString(), '2026-05-21T21:40:00.000Z');
});
test('15m slot 21:45 resolves at 22:00 -> resolveHour=22', () => {
  const openTs = Date.UTC(2026, 4, 21, 21, 45, 0) / 1000;
  assert.strictEqual(resolveHour(openTs, 900), 22);
});
test('5m slot 21:45 resolves at 21:50 -> resolveHour=21', () => {
  const openTs = Date.UTC(2026, 4, 21, 21, 45, 0) / 1000;
  assert.strictEqual(resolveHour(openTs, 300), 21);
});
test('5m slot 21:55 resolves at 22:00 -> resolveHour=22 (boundary)', () => {
  const openTs = Date.UTC(2026, 4, 21, 21, 55, 0) / 1000;
  assert.strictEqual(resolveHour(openTs, 300), 22);
});

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} - ${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);
