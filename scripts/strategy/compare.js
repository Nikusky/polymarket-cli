// Reads the ledgers of every active strategy variant and prints a
// side-by-side comparison.
//
// Variant discovery: derived from `deploy/polybot-strategy-<label>.service`
// files in the repo. Adding a service file → variant appears in the next
// run. Deleting it → variant drops off. Single source of truth is the
// deploy/ folder.
//
// Override with STRATEGY_COMPARE_DIRS="label1:path1,label2:path2,..."
//
// Usage: node scripts/strategy/compare.js

const fs = require('fs');
const path = require('path');

const BASE = __dirname;

function parseDirs() {
  const raw = process.env.STRATEGY_COMPARE_DIRS;
  if (raw) {
    return raw.split(',').map(s => s.trim()).filter(Boolean).map(spec => {
      const [label, p] = spec.split(':');
      return { label: label.trim(), dir: path.resolve(p.trim()) };
    });
  }
  const deployDir = path.join(BASE, '..', '..', 'deploy');
  let labels = [];
  try {
    labels = fs.readdirSync(deployDir)
      .map(f => f.match(/^polybot-strategy-([a-z]+)\.service$/))
      .filter(Boolean)
      .map(m => m[1])
      .sort();
  } catch {
    // deploy dir not found — fall back to data-* directories
    labels = fs.readdirSync(BASE)
      .map(f => f.match(/^data-([a-z]+)$/))
      .filter(Boolean)
      .map(m => m[1])
      .sort();
  }
  return labels.map(label => ({
    label,
    dir: path.join(BASE, `data-${label}`),
  }));
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function stats(dir) {
  const ledgerPath = path.join(dir, 'strategy-ledger.jsonl');
  const statePath = path.join(dir, 'strategy-state.json');
  if (!fs.existsSync(ledgerPath)) {
    return { missing: true, dir };
  }
  const records = fs.readFileSync(ledgerPath, 'utf8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

  const entries = records.filter(r => r.kind === 'entry');
  const exits = records.filter(r => r.kind === 'exit');
  const skips = records.filter(r => r.kind === 'skip');
  const wins = exits.filter(e => e.won).length;
  const losses = exits.length - wins;
  const pnl = exits.reduce((s, e) => s + (e.pnl || 0), 0);
  const deployed = entries.reduce((s, e) => s + (e.paperCost || 0), 0);
  const fills = entries.map(e => e.avgFillPrice).filter(Number.isFinite);
  const avgFill = fills.length ? fills.reduce((s, f) => s + f, 0) / fills.length : null;
  const medFill = median(fills);
  const skipReasons = {};
  for (const s of skips) skipReasons[s.reason] = (skipReasons[s.reason] || 0) + 1;

  let open = 0;
  try {
    const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    open = Object.values(st.positions || {}).filter(p => !p.settled).length;
  } catch {}

  return {
    entries: entries.length, exits: exits.length, wins, losses,
    winRate: exits.length ? (wins / exits.length) * 100 : null,
    pnl, deployed,
    roi: deployed > 0 ? (pnl / deployed) * 100 : null,
    avgFill, medFill,
    skips: skips.length, skipReasons,
    open,
    firstTs: records[0]?.ts,
    lastTs: records[records.length - 1]?.ts,
  };
}

function fmt(v, digits = 2, suffix = '') {
  if (v === null || v === undefined) return '-';
  return v.toFixed(digits) + suffix;
}
function pad(s, n) { return String(s).padEnd(n); }

const variants = parseDirs();
const results = variants.map(v => ({ ...v, ...stats(v.dir) }));

console.log('Strategy variants comparison\n');
console.log('  ' + pad('Metric', 22) + results.map(r => pad(r.label.toUpperCase(), 14)).join(''));
console.log('  ' + '-'.repeat(22 + 14 * results.length));

function row(label, fn) {
  console.log('  ' + pad(label, 22) + results.map(r => pad(r.missing ? 'n/a' : fn(r), 14)).join(''));
}

row('Entries',         r => r.entries);
row('Exits',           r => `${r.exits} (W:${r.wins} L:${r.losses})`);
row('Win rate',        r => fmt(r.winRate, 1, '%'));
row('Realized PnL',    r => '$' + fmt(r.pnl));
row('Capital deployed',r => '$' + fmt(r.deployed));
row('ROI on deployed', r => fmt(r.roi, 2, '%'));
row('Avg fill',        r => fmt(r.avgFill, 3));
row('Median fill',     r => fmt(r.medFill, 3));
row('Open positions',  r => r.open);
row('Skips total',     r => r.skips);

console.log('\n  Skip-reason breakdown:');
const allReasons = new Set();
for (const r of results) if (!r.missing) Object.keys(r.skipReasons).forEach(k => allReasons.add(k));
for (const reason of allReasons) {
  console.log('  ' + pad('  ' + reason, 22) + results.map(r => pad(r.missing ? 'n/a' : (r.skipReasons[reason] || 0), 14)).join(''));
}

console.log('');
for (const r of results) {
  if (r.missing) {
    console.log(`  ${r.label.toUpperCase()}: no ledger at ${r.dir}`);
  } else if (r.firstTs && r.lastTs) {
    const hrs = ((r.lastTs - r.firstTs) / 3600).toFixed(1);
    console.log(`  ${r.label.toUpperCase()}: ${r.dir}  spans ${hrs}h`);
  }
}
