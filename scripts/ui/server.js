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

function buildStateAggregate() {
  const variants = readers.listVariants(path.join(ROOT, 'deploy'));
  const out = [];
  for (const v of variants) {
    const dataDir = v.dataDir ? path.join(ROOT, v.dataDir) : null;
    const ledger = dataDir
      ? readers.readLedger(dataDir)
      : { records: [], totals: { entries:0, exits:0, wins:0, losses:0, stopExits:0, pnl:0, deployed:0 }, cumulativePnl: [], error: 'no dataDir' };
    const state = dataDir ? readers.readState(dataDir) : { positions: [], decisionCounts: {} };
    const latestExit = (ledger.records || []).slice().reverse().find(r => r.kind === 'exit');
    out.push({
      label: v.label,
      service: v.service,
      description: v.description,
      env: v.env,
      args: v.args,
      dataDir: v.dataDir,
      totals: ledger.totals,
      openCount: state.positions.length,
      latestExit: latestExit ? { ts: latestExit.ts, pnl: latestExit.pnl, betSide: latestExit.betSide, won: latestExit.won } : null,
      cumulativePnl: ledger.cumulativePnl || [],
      error: v.error || ledger.error || state.error || null,
    });
  }
  return { generatedAt: Math.floor(Date.now() / 1000), variants: out };
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    const variantMatch = p.match(/^\/api\/variant\/([^/]+)$/);
    if (variantMatch) {
      const label = decodeURIComponent(variantMatch[1]);
      if (!/^[a-z]{1,12}(-[a-z]+)?$/.test(label)) return json(res, 400, { error: 'invalid label' });
      const variants = readers.listVariants(path.join(ROOT, 'deploy'));
      const v = variants.find(x => x.label === label);
      if (!v) return json(res, 404, { error: 'unknown variant' });
      const dataDir = v.dataDir ? path.join(ROOT, v.dataDir) : null;
      const ledger = dataDir ? readers.readLedger(dataDir) : { records: [], totals: {}, error: 'no dataDir' };
      const state = dataDir ? readers.readState(dataDir) : { positions: [], decisionCounts: {} };
      return json(res, 200, {
        spec: v,
        totals: ledger.totals,
        ledger: (ledger.records || []).slice(-200),
        positions: state.positions,
        decisionCounts: state.decisionCounts,
        parseErrors: ledger.parseErrors || 0,
        error: ledger.error || null,
      });
    }
    if (p === '/api/state') return json(res, 200, buildStateAggregate());
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
