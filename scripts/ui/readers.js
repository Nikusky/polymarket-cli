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

module.exports = { parseServiceFile };
