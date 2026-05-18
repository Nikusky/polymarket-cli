// Fetches Binance 1-minute BTC/USDT klines covering a time range and writes
// a compact JSON keyed by minute-floored unix-second timestamp.
//
// Usage:
//   node scripts/research/fetch_btc_klines.js <startUnixSec> <endUnixSec> [outFile]

const fs = require('fs');
const path = require('path');

const URL = 'https://api.binance.com/api/v3/klines';

async function fetchPage(startMs, endMs) {
  const u = `${URL}?symbol=BTCUSDT&interval=1m&startTime=${startMs}&endTime=${endMs}&limit=1000`;
  const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}

async function fetchAll(startSec, endSec) {
  const klines = {};
  let cursor = startSec * 1000;
  const endMs = endSec * 1000;
  let pages = 0;
  while (cursor < endMs) {
    const data = await fetchPage(cursor, Math.min(cursor + 1000 * 60 * 1000, endMs));
    pages++;
    if (!data || data.length === 0) break;
    for (const k of data) {
      const minTs = Math.floor(k[0] / 1000);
      klines[minTs] = {
        o: parseFloat(k[1]),
        h: parseFloat(k[2]),
        l: parseFloat(k[3]),
        c: parseFloat(k[4]),
        v: parseFloat(k[5]),
      };
    }
    cursor = data[data.length - 1][0] + 60_000;
    if (pages % 50 === 0) console.error(`  ...${pages} pages, ${Object.keys(klines).length} klines so far`);
  }
  return klines;
}

async function main() {
  const [startStr, endStr, outArg] = process.argv.slice(2);
  if (!startStr || !endStr) { console.error('usage: <startUnixSec> <endUnixSec> [outFile]'); process.exit(2); }
  const startSec = parseInt(startStr);
  const endSec = parseInt(endStr);

  console.log(`Fetching BTC 1m klines from ${new Date(startSec * 1000).toISOString()} to ${new Date(endSec * 1000).toISOString()}`);
  const t0 = Date.now();
  const klines = await fetchAll(startSec, endSec);
  console.log(`Fetched ${Object.keys(klines).length} klines in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const outDir = path.join(__dirname, 'data');
  fs.mkdirSync(outDir, { recursive: true });
  const file = outArg || path.join(outDir, `btc_klines_${startSec}_${endSec}.json`);
  fs.writeFileSync(file, JSON.stringify(klines));
  console.log(`saved → ${file}`);
}

main().catch(e => { console.error(e); process.exit(1); });
