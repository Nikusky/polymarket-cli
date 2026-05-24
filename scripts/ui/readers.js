// Pure parsers for polyBOT UI. No global state, no I/O assumptions —
// every function takes its root path or data buffer as an argument.

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

const fs = require('fs');
const path = require('path');

function listVariants(deployDir) {
  let entries;
  try { entries = fs.readdirSync(deployDir); }
  catch { return []; }

  const out = [];
  for (const name of entries) {
    if (!name.endsWith('.service')) continue;
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
    if (parsed.env && parsed.env.STRATEGY_DATA_DIR) {
      dataDir = parsed.env.STRATEGY_DATA_DIR.replace('/opt/polybot/polymarket-cli/', '');
    } else if (parsed.env && parsed.env.MASTERCOPY_DATA_DIR) {
      dataDir = parsed.env.MASTERCOPY_DATA_DIR.replace('/opt/polybot/polymarket-cli/', '');
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

module.exports = { parseServiceFile, listVariants };
