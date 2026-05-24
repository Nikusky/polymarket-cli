// Pure parsers for polyBOT UI. No global state, no I/O assumptions —
// every function takes its root path or data buffer as an argument.

const fs = require('fs');
const path = require('path');

const ROOT_PREFIX = '/opt/polybot/polymarket-cli/';
function stripRootPrefix(absPath) {
  if (!absPath) return null;
  if (absPath.startsWith(ROOT_PREFIX)) return absPath.slice(ROOT_PREFIX.length);
  return null;  // outside our root — caller can decide what to do
}

function parseServiceFile(src) {
  const lines = src.split('\n').map(l => l.trim()).filter(Boolean);
  const env = {};
  let description = '';
  let execStart = null;

  for (const line of lines) {
    if (line.startsWith('Description=')) {
      description = line.slice('Description='.length);
    } else if (line.startsWith('Environment=')) {
      const kv = line.slice('Environment='.length);
      const eq = kv.indexOf('=');
      if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (line.startsWith('ExecStart=')) {
      execStart = line.slice('ExecStart='.length).split(/\s+/);
    }
  }

  if (!execStart) return { description, env, error: 'ExecStart missing' };

  const tokens = execStart;

  if (tokens.length < 6) {
    return { description, env, execStart: tokens, args: null, error: 'ExecStart has fewer than 6 tokens' };
  }

  const argsRaw = {
    observeMin: parseInt(tokens[tokens.length - 4], 10),
    threshBps: parseFloat(tokens[tokens.length - 3]),
    positionUsd: parseFloat(tokens[tokens.length - 2]),
    runtimeHours: parseFloat(tokens[tokens.length - 1]),
  };
  if (!Object.values(argsRaw).every(Number.isFinite)) {
    return { description, env, execStart: tokens, args: null, error: 'ExecStart args not numeric' };
  }

  return { description, env, execStart: tokens, args: argsRaw };
}

function listVariants(deployDir) {
  let entries;
  try { entries = fs.readdirSync(deployDir); }
  catch { return []; }

  const out = [];
  for (const name of entries) {
    if (!name.endsWith('.service')) continue;
    // Discovers polyBOT variant units. The legacy `polybot-strategy.service` (no
    // letter suffix) is intentionally excluded — it predates the A/B/C/.../K split
    // and is now dead config; will be removed in a future cleanup.
    const m = name.match(/^polybot-(strategy-([a-z]+)|mastercopy(-sells)?)\.service$/);
    if (!m) continue;

    let label;
    const service = name.replace('.service', '');
    if (m[2]) label = m[2];                              // strategy-d -> d
    else if (m[3]) label = 'mc-sells';                   // mastercopy-sells -> mc-sells
    else label = 'mastercopy';                           // mastercopy alone -> mastercopy

    const src = fs.readFileSync(path.join(deployDir, name), 'utf8');
    const parsed = parseServiceFile(src);

    let dataDir = null;
    if (parsed.env) {
      dataDir = stripRootPrefix(parsed.env.STRATEGY_DATA_DIR) || stripRootPrefix(parsed.env.MASTERCOPY_DATA_DIR);
    }

    out.push({
      label,
      service,
      description: parsed.description,
      env: parsed.env || {},
      args: parsed.args || null,
      dataDir,
      error: parsed.error || null,
    });
  }
  return out;
}

function readLedger(dataDir, _opts = {}) {
  const ledgerPath = path.join(dataDir, 'strategy-ledger.jsonl');
  let raw;
  try { raw = fs.readFileSync(ledgerPath, 'utf8'); }
  catch { return { records: [], totals: emptyTotals(), cumulativePnl: [], parseErrors: 0, error: 'no ledger yet' }; }

  const records = [];
  let parseErrors = 0;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { records.push(JSON.parse(line)); }
    catch { parseErrors++; }
  }

  const totals = emptyTotals();
  for (const r of records) {
    if (r.kind === 'entry') {
      totals.entries++;
      totals.deployed += Number(r.paperCost ?? 0);
    } else if (r.kind === 'exit') {
      totals.exits++;
      if (r.won === true) totals.wins++;
      else totals.losses++;
      if (r.stoppedOut === true) totals.stopExits++;
      totals.pnl += Number(r.pnl ?? 0);
    }
  }

  const cumulativePnl = [];
  let running = 0;
  for (const r of records) {
    if (r.kind !== 'exit') continue;
    running += Number(r.pnl ?? 0);
    cumulativePnl.push([r.ts, Math.round(running * 100) / 100]);
  }

  // Round pnl to 2 decimals to absorb fp noise.
  totals.pnl = Math.round(totals.pnl * 100) / 100;

  return { records, totals, cumulativePnl, parseErrors };
}

function emptyTotals() {
  return { entries: 0, exits: 0, wins: 0, losses: 0, stopExits: 0, pnl: 0, deployed: 0 };
}

function readState(dataDir) {
  const statePath = path.join(dataDir, 'strategy-state.json');
  let raw;
  try { raw = fs.readFileSync(statePath, 'utf8'); }
  catch { return { positions: [], decisionCounts: {} }; }

  let st;
  try { st = JSON.parse(raw); }
  catch { return { positions: [], decisionCounts: {}, error: 'state parse failed' }; }

  const positions = Object.values(st.positions || {}).filter(p => !p.settled);
  const decisionCounts = {};
  for (const d of Object.values(st.decisions || {})) {
    const r = d.reason || 'unknown';
    decisionCounts[r] = (decisionCounts[r] || 0) + 1;
  }
  return { positions, decisionCounts };
}

module.exports = { parseServiceFile, listVariants, readLedger, readState };
