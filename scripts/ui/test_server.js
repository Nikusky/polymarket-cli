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

  console.log('\n== server: /api/variant/:label ==');

  await test('/api/variant/d returns full data', async () => {
    const r = await fetch(srv.url + '/api/variant/d');
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.strictEqual(j.spec.label, 'd');
    assert.ok(j.ledger.length > 0, 'expected non-empty ledger');
    assert.strictEqual(j.totals.entries, 5);
    assert.strictEqual(j.positions.length, 1);
  });

  await test('/api/variant/unknown returns 404 with error JSON', async () => {
    const r = await fetch(srv.url + '/api/variant/unknown');
    assert.strictEqual(r.status, 404);
    const j = await r.json();
    assert.ok(j.error);
  });

  await test('/api/variant/<<bad>> rejects invalid label', async () => {
    const r = await fetch(srv.url + '/api/variant/' + encodeURIComponent('../etc'));
    assert.strictEqual(r.status, 400);
  });

  console.log('\n== server: /api/logs/:label ==');

  await test('/api/logs/d returns parsed lines via fake journalctl', async () => {
    const r = await fetch(srv.url + '/api/logs/d');
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.strictEqual(j.error, null);
    assert.strictEqual(j.lines.length, 2);
    assert.ok(j.lines[0].message.includes('tick'));
  });

  await test('/api/logs/<<bad>> rejects invalid label', async () => {
    const r = await fetch(srv.url + '/api/logs/' + encodeURIComponent('../oops'));
    assert.strictEqual(r.status, 400);
  });

  console.log('\n== server: static files ==');

  await test('GET / returns index.html', async () => {
    const r = await fetch(srv.url + '/');
    assert.strictEqual(r.status, 200);
    assert.ok((r.headers.get('content-type') || '').includes('html'));
    const body = await r.text();
    assert.ok(body.includes('<div id="root">'));
  });

  await test('GET /static/styles.css returns css', async () => {
    const r = await fetch(srv.url + '/static/styles.css');
    assert.strictEqual(r.status, 200);
    assert.ok((r.headers.get('content-type') || '').includes('css'));
  });

  await test('GET /static/../etc/passwd is rejected', async () => {
    const r = await fetch(srv.url + '/static/' + encodeURIComponent('../../../etc/passwd'));
    assert.strictEqual(r.status, 400);
  });

  if (srv) srv.proc.kill();
  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} - ${failed} failure(s)`);
  process.exit(failed === 0 ? 0 : 1);
})();
