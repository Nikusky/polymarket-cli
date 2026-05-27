const assert = require('assert');
const path = require('path');
const { parseServiceFile, listVariants, classifyMode, readLedger, readState, readJournal, parseJournalOutput } = require('./readers');

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
  assert.deepStrictEqual(labels, ['d', 'malformed', 'mastercopy', 'mc-scaled', 'mc-sells']);
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

await test('mastercopy-scaled variant gets label mc-scaled with SCALED env', () => {
  const v = listVariants(path.join(FIX, 'deploy'));
  const mcSc = v.find(x => x.label === 'mc-scaled');
  assert.ok(mcSc, 'expected mc-scaled label');
  assert.strictEqual(mcSc.service, 'polybot-mastercopy-scaled');
  assert.strictEqual(mcSc.dataDir, 'scripts/mastercopy/data-mc-scaled');
  assert.strictEqual(mcSc.env.MIRROR_MODE, 'SCALED');
  assert.strictEqual(mcSc.env.MIRROR_SIDES, 'BUY,SELL');
});

await test('every fixture variant is classified mode=paper', () => {
  const v = listVariants(path.join(FIX, 'deploy'));
  for (const variant of v) {
    assert.strictEqual(variant.mode, 'paper', `${variant.label}: expected paper, got ${variant.mode}`);
  }
});

console.log('\n== classifyMode ==');

await test('live.js in ExecStart -> live', () => {
  const parsed = { execStart: ['/usr/bin/node', '/opt/polybot/polymarket-cli/scripts/mastercopy/live.js', '168'] };
  assert.strictEqual(classifyMode(parsed, 'polybot-strategy-d'), 'live');
});

await test('-live service-name suffix -> live (with or without .service)', () => {
  const parsed = { execStart: ['/usr/bin/node', '/opt/polybot/scripts/strategy/main.js'] };
  assert.strictEqual(classifyMode(parsed, 'polybot-mastercopy-live'), 'live');
  assert.strictEqual(classifyMode(parsed, 'polybot-mastercopy-live.service'), 'live');
});

await test('paper unit running main.js -> paper', () => {
  const parsed = { execStart: ['/usr/bin/node', '/opt/polybot/scripts/strategy/main.js', '11', '6', '100', '168'] };
  assert.strictEqual(classifyMode(parsed, 'polybot-strategy-d'), 'paper');
});

await test('null/empty inputs default to paper', () => {
  assert.strictEqual(classifyMode(null, 'polybot-strategy-d'), 'paper');
  assert.strictEqual(classifyMode({}, ''), 'paper');
  assert.strictEqual(classifyMode({ execStart: [] }, 'foo'), 'paper');
});

await test('a path with "live" only in a folder name does NOT trigger live (script must end in live*.js)', () => {
  const parsed = { execStart: ['/usr/bin/node', '/opt/live-data/main.js'] };
  assert.strictEqual(classifyMode(parsed, 'polybot-strategy-d'), 'paper');
});

await test('live-something.js variants (e.g. live-lib.js) are classified live', () => {
  const parsed = { execStart: ['/usr/bin/node', '/opt/polybot/scripts/mastercopy/live-runner.js'] };
  assert.strictEqual(classifyMode(parsed, 'polybot-strategy-d'), 'live');
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

await test('live ledger: entry.realCost feeds deployed total', () => {
  // Live executor V2 entry shape has realCost / realShares / realFillPrice
  // (no paperCost). Before the fix, deployed stayed at $0 because the
  // ?? chain bottomed out. realCost must take priority over paper fields.
  const tmp = path.join(require('os').tmpdir(), `polybot-ui-test-${Date.now()}-live`);
  require('fs').mkdirSync(tmp, { recursive: true });
  require('fs').writeFileSync(path.join(tmp, 'strategy-ledger.jsonl'),
    '{"kind":"entry","ts":1,"realCost":70.84,"realShares":144.9,"realFillPrice":0.489,"paperFillPrice":0.47}\n'
  );
  const r = readLedger(tmp);
  assert.strictEqual(r.totals.entries, 1);
  assert.ok(Math.abs(r.totals.deployed - 70.84) < 0.01, `deployed was ${r.totals.deployed}`);
});

await test('live ledger: exit.realizedPnl feeds PnL total + cumulativePnl', () => {
  // V2 stop-loss exit shape uses realizedPnl (not pnl). Cumulative chart
  // also reads exitPnl helper now — both must agree.
  const tmp = path.join(require('os').tmpdir(), `polybot-ui-test-${Date.now()}-exit`);
  require('fs').mkdirSync(tmp, { recursive: true });
  require('fs').writeFileSync(path.join(tmp, 'strategy-ledger.jsonl'),
    '{"kind":"entry","ts":1,"realCost":70.84}\n' +
    '{"kind":"exit","ts":2,"won":false,"stoppedOut":true,"realizedPnl":-70.84,"paperPnl":-15}\n'
  );
  const r = readLedger(tmp);
  assert.strictEqual(r.totals.exits, 1);
  assert.strictEqual(r.totals.losses, 1);
  assert.strictEqual(r.totals.stopExits, 1);
  assert.ok(Math.abs(r.totals.pnl - (-70.84)) < 0.01, `pnl was ${r.totals.pnl}`);
  assert.strictEqual(r.cumulativePnl.length, 1);
  assert.ok(Math.abs(r.cumulativePnl[0][1] - (-70.84)) < 0.01, `cumPnl was ${r.cumulativePnl[0][1]}`);
});

await test('paper-only exit still sums pnl correctly (no regression)', () => {
  // Paper variants emit { won, pnl } — must keep working when realizedPnl absent.
  const tmp = path.join(require('os').tmpdir(), `polybot-ui-test-${Date.now()}-paper`);
  require('fs').mkdirSync(tmp, { recursive: true });
  require('fs').writeFileSync(path.join(tmp, 'strategy-ledger.jsonl'),
    '{"kind":"exit","ts":1,"won":true,"pnl":12.34}\n' +
    '{"kind":"exit","ts":2,"won":false,"pnl":-5}\n'
  );
  const r = readLedger(tmp);
  assert.strictEqual(r.totals.exits, 2);
  assert.ok(Math.abs(r.totals.pnl - 7.34) < 0.01, `pnl was ${r.totals.pnl}`);
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
