// Pure parsers for polyBOT UI. No global state, no I/O assumptions —
// every function takes its root path or data buffer as an argument.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

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

  // Try strategy shape first: 4 trailing numeric tokens -> full args.
  if (tokens.length >= 6) {
    const tail = tokens.slice(-4);
    const nums = tail.map(t => Number(t));
    if (nums.every(Number.isFinite)) {
      return {
        description, env, execStart: tokens,
        args: { observeMin: parseInt(tail[0], 10), threshBps: parseFloat(tail[1]), positionUsd: parseFloat(tail[2]), runtimeHours: parseFloat(tail[3]) },
      };
    }
  }
  // Fallback: try mastercopy shape: last token = runtimeHours.
  const last = tokens[tokens.length - 1];
  const lastNum = parseFloat(last);
  if (Number.isFinite(lastNum)) {
    return { description, env, execStart: tokens, args: { runtimeHours: lastNum } };
  }
  // Nothing usable — args = null, no error (ExecStart exists, just unparseable).
  return { description, env, execStart: tokens, args: null };
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
    const m = name.match(/^polybot-(strategy-([a-z]+)|mastercopy(-sells|-live)?)\.service$/);
    if (!m) continue;

    let label;
    const service = name.replace('.service', '');
    if (m[2])              label = m[2];                 // strategy-d -> d
    else if (m[3] === '-sells') label = 'mc-sells';      // mastercopy-sells -> mc-sells
    else if (m[3] === '-live')  label = 'mc-live';       // mastercopy-live  -> mc-live
    else                   label = 'mastercopy';         // mastercopy alone -> mastercopy

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
    if (r.kind === 'entry' || r.kind === 'mirror') {
      totals.entries++;
      const cost = Number(
        r.paperCost
        ?? r.paperSize
        ?? (r.masterPrice != null && r.paperShares != null ? r.masterPrice * r.paperShares : 0)
      );
      totals.deployed += cost;
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

function parseJournalOutput(stdout) {
  return stdout.split('\n').filter(Boolean).map(line => {
    // short-iso: "2026-05-24T16:00:00+0000 host unit[pid]: message..."
    const m = line.match(/^(\S+)\s+\S+\s+\S+\s+(.+)$/);
    if (!m) return { ts: 0, message: line };
    const d = new Date(m[1]);
    const ts = isNaN(d.getTime()) ? 0 : Math.floor(d.getTime() / 1000);
    return { ts, message: m[2] };
  });
}

async function readJournal(unitName, opts = {}) {
  const {
    lines = 200,
    bin = process.env.JOURNALCTL_BIN || 'journalctl',
    extraArgs = [],
    timeoutMs = 3000,
  } = opts;
  const args = extraArgs.length
    ? [...extraArgs, '-u', unitName, '-n', String(lines), '--no-pager', '--output=short-iso']
    : ['-u', unitName, '-n', String(lines), '--no-pager', '--output=short-iso'];
  try {
    const { stdout } = await execFileP(bin, args, { timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024 });
    return { lines: parseJournalOutput(stdout), error: null };
  } catch (e) {
    return { lines: [], error: e.signal === 'SIGTERM' ? 'timeout' : (e.stderr || e.message || 'spawn failed') };
  }
}

module.exports = { parseServiceFile, listVariants, readLedger, readState, readJournal, parseJournalOutput };
