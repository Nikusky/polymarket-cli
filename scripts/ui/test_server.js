const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n    ${e.message}`); failed++; }
}

const FIX = path.join(__dirname, '__fixtures__');

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      env: {
        ...process.env,
        POLYBOT_UI_ROOT: FIX,
        POLYBOT_UI_PORT: '0',
        POLYBOT_UI_JOURNALCTL_ARGS: path.join(FIX, 'fake-journalctl.js'),
        JOURNALCTL_BIN: 'node',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', c => { stderr += c.toString(); });
    proc.stdout.on('data', chunk => {
      const m = chunk.toString().match(/listening on http:\/\/(\S+)/);
      if (m) resolve({ proc, url: 'http://' + m[1] });
    });
    proc.on('exit', code => reject(new Error(`server exited (${code}) stderr:\n${stderr}`)));
    setTimeout(() => reject(new Error(`server didn't start within 5s; stderr:\n${stderr}`)), 5000);
  });
}

(async () => {
  console.log('== server: /api/health ==');

  let srv;
  await test('server starts on ephemeral port', async () => {
    srv = await startServer();
    assert.ok(srv.url.startsWith('http://'));
  });

  await test('/api/health returns ok=true', async () => {
    const r = await fetch(srv.url + '/api/health');
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.strictEqual(j.ok, true);
    assert.ok(typeof j.uptime === 'number');
  });

  console.log('\n== server: /api/state ==');

  await test('/api/state returns aggregate with all fixture variants', async () => {
    const r = await fetch(srv.url + '/api/state');
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.ok(typeof j.generatedAt === 'number');
    const labels = j.variants.map(v => v.label).sort();
    // After Task 2's fix, fixtures include: d, malformed, mastercopy, mc-sells (snapshot is excluded by regex)
    assert.deepStrictEqual(labels, ['d', 'malformed', 'mastercopy', 'mc-sells']);
  });

  await test('/api/state d variant has correct totals', async () => {
    const r = await fetch(srv.url + '/api/state');
    const j = await r.json();
    const d = j.variants.find(v => v.label === 'd');
    assert.strictEqual(d.totals.entries, 5);
    assert.strictEqual(d.totals.exits, 5);
    assert.ok(Math.abs(d.totals.pnl - (-115.67)) < 0.01);
    assert.strictEqual(d.totals.stopExits, 1);
  });

  await test('/api/state malformed variant carries error, no crash', async () => {
    const r = await fetch(srv.url + '/api/state');
    const j = await r.json();
    const m = j.variants.find(v => v.label === 'malformed');
    assert.ok(m.error, 'expected error on malformed variant');
  });

  if (srv) srv.proc.kill();
  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} - ${failed} failure(s)`);
  process.exit(failed === 0 ? 0 : 1);
})();
