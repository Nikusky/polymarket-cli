// Pulls a master wallet's full trade tape via the polymarket CLI (paged).
// Filters and tags BTC up/down markets (5m, 15m, 1h, UMA) and writes one
// JSON per master to scripts/research/data/tape_<name>.json.
//
// Usage:
//   node scripts/research/pull_master_tape.js <name> <wallet> [maxPages]

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', '..', 'target', 'debug', 'polymarket.exe');
const PAGE_SIZE = 50;

function classify(slug) {
  const s = (slug || '').toLowerCase();
  if (s.startsWith('btc-updown-5m-')) return 'btc5m';
  if (s.startsWith('btc-updown-15m-')) return 'btc15m';
  if (s.startsWith('btc-updown-1h-')) return 'btc1h';
  if (s.startsWith('bitcoin-up-or-down-')) return 'btcUMA';
  if (s.startsWith('eth-updown-')) return 'eth';
  if (s.startsWith('sol-updown-')) return 'sol';
  if (s.startsWith('xrp-updown-')) return 'xrp';
  return null;
}

function pullTape(wallet, maxPages) {
  const all = [];
  for (let off = 0; off < maxPages * PAGE_SIZE; off += PAGE_SIZE) {
    const r = spawnSync(CLI, [
      'data', 'trades', wallet,
      '--limit', String(PAGE_SIZE),
      '--offset', String(off),
      '--output', 'json',
    ], { encoding: 'utf8', maxBuffer: 30 * 1024 * 1024 });
    if (r.status !== 0) break;
    let arr = [];
    try { arr = JSON.parse(r.stdout); } catch { break; }
    if (!Array.isArray(arr) || arr.length === 0) break;
    all.push(...arr);
    if (arr.length < PAGE_SIZE) break;
  }
  return all;
}

function main() {
  const [name, wallet, maxPagesArg] = process.argv.slice(2);
  if (!name || !wallet) { console.error('usage: <name> <wallet> [maxPages]'); process.exit(2); }
  const maxPages = maxPagesArg ? parseInt(maxPagesArg) : 200;

  const t0 = Date.now();
  const tape = pullTape(wallet, maxPages);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  const tagged = tape.map(t => ({ ...t, _category: classify(t.slug || t.market_slug) }));
  const buckets = {};
  for (const t of tagged) {
    const c = t._category || 'other';
    buckets[c] = (buckets[c] || 0) + 1;
  }

  const outDir = path.join(__dirname, 'data');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `tape_${name}.json`);
  fs.writeFileSync(file, JSON.stringify(tagged));

  const tss = tagged.map(t => parseInt(t.timestamp || t.ts || 0)).filter(x => x > 0);
  const spanDays = tss.length ? (Math.max(...tss) - Math.min(...tss)) / 86400 : 0;

  console.log(`[${name}] pulled ${tape.length} fills in ${elapsed}s; span ${spanDays.toFixed(1)}d`);
  for (const [k, v] of Object.entries(buckets).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(10)} ${v}`);
  }
  console.log(`  saved → ${file}`);
}

main();
