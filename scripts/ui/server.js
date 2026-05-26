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

// Compact projection of ledger records — only the fields the UI needs to
// recompute windowed totals/cumulativePnl client-side. Bounded by
// RANGE_CUTOFF_SEC (35 days) and to record kinds that affect totals.
const RANGE_CUTOFF_SEC = 35 * 86400;
const RANGE_KINDS = new Set(['entry', 'mirror', 'live', 'exit']);

function projectRangeRecords(records) {
  const cutoff = Math.floor(Date.now() / 1000) - RANGE_CUTOFF_SEC;
  const out = [];
  for (const r of (records || [])) {
    if (!RANGE_KINDS.has(r.kind)) continue;
    if (Number(r.ts || 0) < cutoff) continue;
    if (r.kind === 'exit') {
      out.push({
        kind: 'exit', ts: r.ts,
        pnl: r.pnl, won: r.won, stoppedOut: r.stoppedOut,
      });
    } else {
      out.push({
        kind: r.kind, ts: r.ts,
        paperCost: r.paperCost, paperSize: r.paperSize, filledUsd: r.filledUsd,
        masterPrice: r.masterPrice, paperShares: r.paperShares,
      });
    }
  }
  return out;
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
      mode: v.mode || 'paper',
      description: v.description,
      env: v.env,
      args: v.args,
      dataDir: v.dataDir,
      totals: ledger.totals,
      openCount: state.positions.length,
      latestExit: latestExit ? { ts: latestExit.ts, pnl: latestExit.pnl, betSide: latestExit.betSide, won: latestExit.won } : null,
      cumulativePnl: ledger.cumulativePnl || [],
      rangeRecords: projectRangeRecords(ledger.records),
      error: v.error || ledger.error || state.error || null,
    });
  }
  return { generatedAt: Math.floor(Date.now() / 1000), variants: out };
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/' || p === '/index.html') {
      const buf = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': buf.length });
      return res.end(buf);
    }
    if (p.startsWith('/static/')) {
      const staticMatch = p.match(/^\/static\/([A-Za-z0-9._-]+)$/);
      if (!staticMatch) return json(res, 400, { error: 'invalid path' });
      const name = staticMatch[1];
      const file = path.join(__dirname, 'public', name);
      const publicDir = path.join(__dirname, 'public');
      if (!file.startsWith(publicDir + path.sep) && file !== publicDir) {
        return json(res, 400, { error: 'invalid path' });
      }
      let buf;
      try { buf = fs.readFileSync(file); } catch { return json(res, 404, { error: 'not found' }); }
      const ct = name.endsWith('.css') ? 'text/css' :
                 name.endsWith('.js')  ? 'application/javascript' :
                 name.endsWith('.html') ? 'text/html; charset=utf-8' :
                 'application/octet-stream';
      res.writeHead(200, { 'content-type': ct, 'content-length': buf.length });
      return res.end(buf);
    }
    const logsMatch = p.match(/^\/api\/logs\/([^/]+)$/);
    if (logsMatch) {
      const label = decodeURIComponent(logsMatch[1]);
      if (!/^[a-z]{1,12}(-[a-z]+)?$/.test(label)) return json(res, 400, { error: 'invalid label' });
      const variants = readers.listVariants(path.join(ROOT, 'deploy'));
      const v = variants.find(x => x.label === label);
      if (!v) return json(res, 404, { error: 'unknown variant' });
      const lines = parseInt(url.searchParams.get('lines') || '200', 10);
      const extraArgs = process.env.POLYBOT_UI_JOURNALCTL_ARGS
        ? [process.env.POLYBOT_UI_JOURNALCTL_ARGS]
        : [];
      const result = await readers.readJournal(v.service, { lines, extraArgs });
      return json(res, 200, result);
    }
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
