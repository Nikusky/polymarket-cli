// Aggregator for mastercopy paper ledgers. Reads `data-mc/` (flat $1) AND
// `data-mc-scaled/` (master-size) in one pass, then prints PnL broken down by
//   unit x master x tradeSide x mode
// across time windows 2h / 6h / 24h / all.
//
// Usage:  node scripts/mastercopy/status.js
//
// Env (override only if running against a non-standard layout):
//   STATUS_FLAT_DIR    default ./data-mc
//   STATUS_SCALED_DIR  default ./data-mc-scaled

const fs = require('fs');
const path = require('path');

const FLAT_DIR   = process.env.STATUS_FLAT_DIR   || path.join(__dirname, 'data-mc');
const SCALED_DIR = process.env.STATUS_SCALED_DIR || path.join(__dirname, 'data-mc-scaled');

const UNITS = [
  { label: 'flat',   dir: FLAT_DIR,   fallbackMode: 'FLAT' },
  { label: 'scaled', dir: SCALED_DIR, fallbackMode: 'SCALED' },
];

const WINDOWS = [
  { name: '2h',  secs: 2  * 3600 },
  { name: '6h',  secs: 6  * 3600 },
  { name: '24h', secs: 24 * 3600 },
  { name: 'all', secs: Number.POSITIVE_INFINITY },
];

const MASTER_LABEL = {
  '0xce25e214d5cfe4f459cf67f08df581885aae7fdc': 'cE25',
  '0xb55fa1296e6ec55d0ce53d93b9237389f11764d4': 'b55fa',
  '0xa9239c0ca3dee2d03232481212474e1d781b6704': 'a923',
};
function mTag(addr) { return MASTER_LABEL[(addr || '').toLowerCase()] || (addr || '?').slice(0, 8); }

function loadExits(dir) {
  const ledger = path.join(dir, 'strategy-ledger.jsonl');
  if (!fs.existsSync(ledger)) return { exits: [], present: false, path: ledger };
  const exits = [];
  for (const line of fs.readFileSync(ledger, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (r.kind === 'exit') exits.push(r);
    } catch { /* skip malformed */ }
  }
  return { exits, present: true, path: ledger };
}

function blank() { return { n: 0, w: 0, pnl: 0, vol: 0 }; }

function summarise(exits, windowSecs, nowTs, fallbackMode) {
  const out = {
    totals: blank(),
    byMaster: {},
    bySide:   { BUY: blank(), SELL: blank() },
    byMode:   { FLAT: blank(), SCALED: blank(), absent: blank() },
    byMasterSide: {},
  };
  for (const r of exits) {
    if (nowTs - r.ts > windowSecs) continue;
    const tag  = mTag(r.master);
    const side = r.tradeSide || 'BUY';
    // Legacy exits (pre-2026-05-26) lack `mode`. Fall back to the nominal mode
    // of the unit being aggregated — the dir name is the source of truth.
    const mode = r.mode || fallbackMode || 'absent';
    const notional = (r.paperShares != null && r.masterPrice != null)
      ? Math.abs(r.paperShares * r.masterPrice) : 0;
    for (const bucket of [out.totals, out.bySide[side], out.byMode[mode]]) {
      bucket.n++; if (r.won) bucket.w++; bucket.pnl += r.pnl; bucket.vol += notional;
    }
    if (!out.byMaster[tag]) out.byMaster[tag] = blank();
    const bm = out.byMaster[tag];
    bm.n++; if (r.won) bm.w++; bm.pnl += r.pnl; bm.vol += notional;
    if (!out.byMasterSide[tag]) out.byMasterSide[tag] = { BUY: blank(), SELL: blank() };
    const bms = out.byMasterSide[tag][side];
    bms.n++; if (r.won) bms.w++; bms.pnl += r.pnl; bms.vol += notional;
  }
  return out;
}

function fmtRow(label, b, padLabel = 18) {
  const wr = b.n ? (100 * b.w / b.n).toFixed(1) : '0.0';
  const pnlStr = (b.pnl >= 0 ? '+' : '') + b.pnl.toFixed(2);
  const volStr = b.vol > 0 ? `vol=$${b.vol.toFixed(0).padStart(6)}` : '';
  return `   ${label.padEnd(padLabel)} n=${String(b.n).padStart(4)}  wr=${wr.padStart(5)}%  pnl=$${pnlStr.padStart(9)}  ${volStr}`;
}

function printUnit(unit, exits, nowTs) {
  console.log(`\n========== ${unit.label.toUpperCase()}  (${exits.length} exits in ledger) ==========`);
  console.log(`  ledger: ${unit.dir}`);
  for (const win of WINDOWS) {
    const s = summarise(exits, win.secs, nowTs, unit.fallbackMode);
    if (s.totals.n === 0) {
      console.log(`\n  --- window=${win.name} ---  (no exits)`);
      continue;
    }
    console.log(`\n  --- window=${win.name} ---`);
    console.log(fmtRow('TOTAL', s.totals));
    for (const side of ['BUY', 'SELL']) {
      if (s.bySide[side].n > 0) console.log(fmtRow(`  side=${side}`, s.bySide[side]));
    }
    for (const mode of ['FLAT', 'SCALED', 'absent']) {
      if (s.byMode[mode].n > 0) console.log(fmtRow(`  mode=${mode}`, s.byMode[mode]));
    }
    for (const tag of Object.keys(s.byMaster).sort()) {
      console.log(fmtRow(`  ${tag}`, s.byMaster[tag]));
      const sides = s.byMasterSide[tag];
      for (const side of ['BUY', 'SELL']) {
        if (sides[side].n > 0) console.log(fmtRow(`    ${tag} ${side}`, sides[side]));
      }
    }
  }
}

function main() {
  const nowTs = Math.floor(Date.now() / 1000);
  console.log(`mastercopy status -- ${new Date(nowTs * 1000).toISOString()}`);
  for (const unit of UNITS) {
    const r = loadExits(unit.dir);
    if (!r.present) {
      console.log(`\n========== ${unit.label.toUpperCase()} ==========`);
      console.log(`  ledger missing: ${r.path}`);
      continue;
    }
    printUnit(unit, r.exits, nowTs);
  }
  console.log();
}

if (require.main === module) main();

module.exports = { loadExits, summarise, mTag };
