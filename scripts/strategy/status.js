// Reads strategy-ledger.jsonl and prints a summary: entries, exits, win rate,
// realized PnL, open positions, today's stats.
//
// Usage: node scripts/strategy/status.js

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.STRATEGY_DATA_DIR
  ? path.resolve(process.env.STRATEGY_DATA_DIR)
  : path.join(__dirname, 'data');
const LEDGER = path.join(DATA_DIR, 'strategy-ledger.jsonl');
const STATE = path.join(DATA_DIR, 'strategy-state.json');

if (!fs.existsSync(LEDGER)) { console.log('No ledger yet:', LEDGER); process.exit(0); }

const lines = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean);
const records = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const today = new Date().toISOString().slice(0, 10);
const stats = {
  entries: 0, exits: 0, wins: 0, losses: 0, skips: 0,
  realizedPnl: 0, paperCostDeployed: 0,
  todayEntries: 0, todayExits: 0, todayWins: 0, todayPnl: 0,
  skipReasons: {},
};
const byObserveBucket = { '5-10': { entries: 0, wins: 0 }, '10-20': { entries: 0, wins: 0 }, '20-50': { entries: 0, wins: 0 }, '50+': { entries: 0, wins: 0 } };

for (const r of records) {
  const day = new Date(r.ts * 1000).toISOString().slice(0, 10);
  const isToday = day === today;
  if (r.kind === 'entry') {
    stats.entries++;
    stats.paperCostDeployed += r.paperCost;
    if (isToday) stats.todayEntries++;
    const ob = Math.abs(r.observeBps || 0);
    const b = ob < 10 ? '5-10' : ob < 20 ? '10-20' : ob < 50 ? '20-50' : '50+';
    byObserveBucket[b].entries++;
  } else if (r.kind === 'exit') {
    stats.exits++;
    if (isToday) { stats.todayExits++; stats.todayPnl += r.pnl; }
    if (r.won) { stats.wins++; if (isToday) stats.todayWins++; }
    else stats.losses++;
    stats.realizedPnl += r.pnl;
    const ob = Math.abs(r.observeBps || 0);
    const b = ob < 10 ? '5-10' : ob < 20 ? '10-20' : ob < 50 ? '20-50' : '50+';
    if (r.won) byObserveBucket[b].wins++;
  } else if (r.kind === 'skip') {
    stats.skips++;
    stats.skipReasons[r.reason] = (stats.skipReasons[r.reason] || 0) + 1;
  }
}

let state = { positions: {} };
try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}
const openCount = Object.values(state.positions || {}).filter(p => !p.settled).length;

const winRate = (stats.wins + stats.losses) ? stats.wins / (stats.wins + stats.losses) * 100 : 0;
console.log('Strategy bot status');
console.log(`  Open positions:    ${openCount}`);
console.log(`  Entries (all):     ${stats.entries}`);
console.log(`  Exits (all):       ${stats.exits}    (W:${stats.wins} L:${stats.losses}, ${winRate.toFixed(1)}% win)`);
console.log(`  Realized PnL:      $${stats.realizedPnl.toFixed(2)}`);
console.log(`  Capital deployed:  $${stats.paperCostDeployed.toFixed(2)}  (gross paper buys)`);
console.log(`  ROI on deployed:   ${stats.paperCostDeployed > 0 ? (stats.realizedPnl / stats.paperCostDeployed * 100).toFixed(2) + '%' : '-'}`);
console.log(`  Skips:             ${stats.skips}`);
for (const [k, v] of Object.entries(stats.skipReasons).sort((a,b)=>b[1]-a[1])) {
  console.log(`    ${k.padEnd(22)} ${v}`);
}
console.log('');
console.log(`  Today:`);
console.log(`    entries:${stats.todayEntries}  exits:${stats.todayExits}  W:${stats.todayWins}  pnl=$${stats.todayPnl.toFixed(2)}`);

console.log('\n  Win rate by observed-move bucket:');
for (const [b, c] of Object.entries(byObserveBucket)) {
  const wr = c.entries > 0 ? (c.wins / c.entries * 100).toFixed(1) : '-';
  console.log(`    ${b.padEnd(8)} entries=${c.entries.toString().padEnd(5)} wins=${c.wins.toString().padEnd(5)} win%=${wr}`);
}

if (openCount > 0) {
  console.log('\n  Open positions:');
  for (const p of Object.values(state.positions || {})) {
    if (p.settled) continue;
    const ageMin = ((Date.now()/1000) - p.decideTs) / 60;
    const resolveIn = (p.resolveTs - Date.now()/1000) / 60;
    console.log(`    ${p.slug.slice(-10)}  ${p.betSide} @ ${p.avgFillPrice.toFixed(3)} × ${p.paperShares.toFixed(1)}sh  obsBps=${p.observeBps.toFixed(1)}  age=${ageMin.toFixed(1)}m resolves_in=${resolveIn.toFixed(1)}m`);
  }
}
