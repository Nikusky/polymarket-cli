// Pulls a master wallet's closed positions via the polymarket CLI (paged).
// Tags each by category + parses Chainlink market open/resolve epochs.
// Writes JSON per master to scripts/research/data/positions_<name>.json.
//
// Usage:
//   node scripts/research/pull_closed_positions.js <name> <wallet> [maxPages]

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

function parseResolveTs(slug) {
  const s = (slug || '').toLowerCase();
  for (const [pfx, dur] of [['btc-updown-5m-', 300], ['btc-updown-15m-', 900], ['btc-updown-1h-', 3600]]) {
    if (s.startsWith(pfx)) {
      const rest = s.slice(pfx.length).split('-')[0];
      const n = parseInt(rest);
      if (n > 1_000_000_000) return { openTs: n, resolveTs: n + dur };
    }
  }
  return null;
}

function pull(wallet, maxPages) {
  const all = [];
  for (let off = 0; off < maxPages * PAGE_SIZE; off += PAGE_SIZE) {
    const r = spawnSync(CLI, [
      'data', 'closed-positions', wallet,
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
  const positions = pull(wallet, maxPages);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  const tagged = positions.map(p => {
    const r = parseResolveTs(p.slug || p.event_slug);
    return { ...p, _category: classify(p.slug || p.event_slug), _openTs: r?.openTs ?? null, _resolveTs: r?.resolveTs ?? null };
  });

  const buckets = {};
  for (const t of tagged) {
    const c = t._category || 'other';
    buckets[c] = (buckets[c] || 0) + 1;
  }

  const outDir = path.join(__dirname, 'data');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `positions_${name}.json`);
  fs.writeFileSync(file, JSON.stringify(tagged));

  const tss = tagged.map(p => parseInt(p.timestamp || 0)).filter(x => x > 0);
  const spanDays = tss.length ? (Math.max(...tss) - Math.min(...tss)) / 86400 : 0;

  console.log(`[${name}] pulled ${positions.length} positions in ${elapsed}s; span ${spanDays.toFixed(1)}d`);
  for (const [k, v] of Object.entries(buckets).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(10)} ${v}`);
  }
  console.log(`  saved → ${file}`);
}

main();
