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

  const a = execStart;
  const args = a.length >= 6 ? {
    observeMin: parseInt(a[a.length - 4], 10),
    threshBps: parseFloat(a[a.length - 3]),
    positionUsd: parseFloat(a[a.length - 2]),
    runtimeHours: parseFloat(a[a.length - 1]),
  } : null;

  return { description, env, execStart, args };
}

module.exports = { parseServiceFile };
