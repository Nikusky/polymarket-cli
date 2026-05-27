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

// Marks a variant as real-money 'live' vs paper. Two independent signals: a
// `live.js`/`live-*.js` script in ExecStart (the executor itself) and a
// `-live.service` unit-name suffix (the deploy convention). Either is enough.
function classifyMode(parsed, serviceName) {
  if (parsed && Array.isArray(parsed.execStart)) {
    const hit = parsed.execStart.find(arg => typeof arg === 'string' && /(^|[\/\\])live[A-Za-z0-9_-]*\.js$/.test(arg));
    if (hit) return 'live';
  }
  // `-live` is the legacy real-money mc executor; `-live-<variant>` is the new
  // convention where the suffix names the paper-bot the live mirror tails
  // (e.g. polybot-strategy-live-s mirrors variant S).
  if (typeof serviceName === 'string' && /-live(-[a-z]+)?(\.service)?$/.test(serviceName)) return 'live';
  return 'paper';
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
    // Strategy labels are lowercase letters with optional internal hyphens to
    // support the live-mirror convention (`strategy-live-s` → label `live-s`).
    const m = name.match(/^polybot-(strategy-([a-z][a-z-]*)|mastercopy(-sells|-live|-scaled)?)\.service$/);
    if (!m) continue;

    let label;
    const service = name.replace('.service', '');
    if (m[2])                    label = m[2];           // strategy-d -> d
    else if (m[3] === '-sells')  label = 'mc-sells';     // mastercopy-sells  -> mc-sells
    else if (m[3] === '-live')   label = 'mc-live';      // mastercopy-live   -> mc-live
    else if (m[3] === '-scaled') label = 'mc-scaled';    // mastercopy-scaled -> mc-scaled
    else                         label = 'mastercopy';   // mastercopy alone  -> mastercopy

    const src = fs.readFileSync(path.join(deployDir, name), 'utf8');
    const parsed = parseServiceFile(src);

    let dataDir = null;
    if (parsed.env) {
      dataDir = stripRootPrefix(parsed.env.STRATEGY_DATA_DIR) || stripRootPrefix(parsed.env.MASTERCOPY_DATA_DIR);
    }

    out.push({
      label,
      service,
      mode: classifyMode(parsed, service),
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

  // Field priority — `real*` wins because live ledgers carry the on-chain
  // truth; paper fields are the fallback for paper-twin ledgers and mc-mirror
  // records. Without this, live-s totals stayed at $0 because the entry shape
  // (`realCost` / `realizedPnl`) doesn't match the paper shape (`paperCost`
  // / `pnl`) that the paper variants emit.
  function entryCost(r) {
    return Number(
      r.realCost                                                 // live executor V1/V2
      ?? r.paperCost                                             // paper variants
      ?? r.paperSize                                             // legacy paper field
      ?? r.filledUsd                                             // mc-live shape
      ?? (r.masterPrice != null && r.paperShares != null ? r.masterPrice * r.paperShares : 0)
    );
  }
  function exitPnl(r) {
    return Number(r.realizedPnl ?? r.pnl ?? r.paperPnl ?? 0);
  }

  const totals = emptyTotals();
  const errorRecords = [];
  for (const r of records) {
    if (r.kind === 'entry' || r.kind === 'mirror' || r.kind === 'live') {
      totals.entries++;
      totals.deployed += entryCost(r);
    } else if (r.kind === 'exit') {
      totals.exits++;
      if (r.won === true) totals.wins++;
      else totals.losses++;
      if (r.stoppedOut === true) totals.stopExits++;
      totals.pnl += exitPnl(r);
    } else if (r.kind === 'error') {
      totals.errors++;
      errorRecords.push(r);
    } else if (r.kind === 'paper_skip') {
      totals.paperSkips++;
    }
  }

  const cumulativePnl = [];
  let running = 0;
  for (const r of records) {
    if (r.kind !== 'exit') continue;
    running += exitPnl(r);
    cumulativePnl.push([r.ts, Math.round(running * 100) / 100]);
  }

  // Round pnl to 2 decimals to absorb fp noise.
  totals.pnl = Math.round(totals.pnl * 100) / 100;

  // Most recent first, capped so consumers don't have to slice/reverse.
  const recentErrors = errorRecords.slice(-5).reverse();

  return { records, totals, cumulativePnl, parseErrors, recentErrors };
}

function emptyTotals() {
  return { entries: 0, exits: 0, wins: 0, losses: 0, stopExits: 0, pnl: 0, deployed: 0, errors: 0, paperSkips: 0 };
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

const _serviceActiveCache = new Map(); // unitName -> { value, ts }
const SERVICE_ACTIVE_TTL_MS = 5000;

async function getServiceActive(unitName) {
  if (!unitName) return null;
  const now = Date.now();
  const cached = _serviceActiveCache.get(unitName);
  if (cached && (now - cached.ts) < SERVICE_ACTIVE_TTL_MS) return cached.value;
  let value;
  try {
    const { stdout } = await execFileP('systemctl', ['is-active', unitName], { timeout: 1500 });
    value = stdout.trim();
  } catch (e) {
    value = e && e.stdout ? String(e.stdout).trim() : 'unknown';
  }
  _serviceActiveCache.set(unitName, { value, ts: now });
  return value;
}

module.exports = { parseServiceFile, listVariants, classifyMode, readLedger, readState, readJournal, parseJournalOutput, getServiceActive };
