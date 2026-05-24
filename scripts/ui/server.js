// polyBOT UI server. Read-only HTTP API + static file server on 127.0.0.1.
// Spec: docs/superpowers/specs/2026-05-24-polybot-ui-design.md

const http = require('http');
const path = require('path');
const fs = require('fs');
const readers = require('./readers');

const ROOT = path.resolve(process.env.POLYBOT_UI_ROOT || path.join(__dirname, '..', '..'));
const PORT = parseInt(process.env.POLYBOT_UI_PORT || '8080', 10);
const HOST = process.env.POLYBOT_UI_HOST || '127.0.0.1';
const START_TS = Date.now();

function json(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': buf.length });
  res.end(buf);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/api/health') return json(res, 200, {
      ok: true,
      uptime: Math.floor((Date.now() - START_TS) / 1000),
      memoryUsage: process.memoryUsage(),
      root: ROOT,
    });
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    process.stderr.write(`handler error: ${e.stack}\n`);
    return json(res, 500, { error: e.message });
  }
}

const server = http.createServer((req, res) => { handle(req, res); });
server.listen(PORT, HOST, () => {
  const addr = server.address();
  process.stdout.write(`listening on http://${HOST}:${addr.port}\n`);
});
