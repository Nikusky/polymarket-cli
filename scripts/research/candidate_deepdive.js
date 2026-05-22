// Deep-dive top master-hunt candidates: pull last 500 trades per wallet,
// inspect activity span, market concentration, btc-updown-15m fraction.
// Read-only.

const CANDIDATES = [
  '0x5e2b9261b0c4f697b55bf921ff2bc227183d9101',
  '0x75cc3b63a2f2423085e10706c78b494017b93ce1',
  '0xa9239c0ca3dee2d03232481212474e1d781b6704',
  '0x1917d3e94eca2716e5d11025455630976eec138b',
  '0x6e273613771e30a90bbc2e502fa72fc3aebf70bb',
  '0x0079c31913ed195a00d17c23562e78d46a3154d8',
  '0x20d2309cd92b797ae7ca175ed828ed8a27fbe29d',
  '0xdafdc8cedb3258edbb44fe4d36c88fc2098855eb',
];

const HEADERS = { 'User-Agent': 'polybot-research/1.0', 'Accept': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10000), headers: HEADERS });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function prefixOf(slug) {
  return (slug || '').split('-').slice(0, 3).join('-');
}

(async () => {
  console.log('addr | pseudonym | n | span_d | per_day | %15m | %5m | %sports | avg_15m_px | n_15m_buys');
  for (const addr of CANDIDATES) {
    try {
      const trades = await getJson(`https://data-api.polymarket.com/trades?user=${addr}&limit=500`);
      if (!Array.isArray(trades) || trades.length === 0) {
        console.log(`${addr.slice(0, 10)} | (no trades)`);
        continue;
      }
      const n = trades.length;
      const span_d = (trades[0].timestamp - trades[trades.length - 1].timestamp) / 86400;
      const per_day = span_d > 0 ? n / span_d : null;
      const pseudonym = trades[0].pseudonym || '';
      const byPrefix = new Map();
      for (const t of trades) {
        const p = prefixOf(t.slug);
        byPrefix.set(p, (byPrefix.get(p) || 0) + 1);
      }
      let n15m = 0, n5m = 0, nSports = 0;
      let sum15mPx = 0, cnt15mBuys = 0;
      for (const t of trades) {
        const p = prefixOf(t.slug);
        if (p === 'btc-updown-15m' || p === 'eth-updown-15m' || p === 'sol-updown-15m') n15m++;
        if (p === 'btc-updown-5m' || p === 'eth-updown-5m' || p === 'sol-updown-5m') n5m++;
        if (p.startsWith('mlb-') || p.startsWith('nba-') || p.startsWith('nfl-') ||
            p.startsWith('nhl-') || p.startsWith('soccer-') || p.startsWith('will-')) nSports++;
        if (p === 'btc-updown-15m' && t.side === 'BUY') {
          sum15mPx += t.price; cnt15mBuys++;
        }
      }
      const pct15m = (n15m / n * 100).toFixed(0);
      const pct5m = (n5m / n * 100).toFixed(0);
      const pctSports = (nSports / n * 100).toFixed(0);
      const avg15mPx = cnt15mBuys > 0 ? (sum15mPx / cnt15mBuys).toFixed(3) : '-';
      console.log(
        `${addr.slice(0, 10)} | ${pseudonym.slice(0, 16).padEnd(16)} | n=${String(n).padStart(3)} | ` +
        `span=${span_d.toFixed(1).padStart(5)}d | ${(per_day || 0).toFixed(0).padStart(5)}/d | ` +
        `15m=${pct15m.padStart(3)}% | 5m=${pct5m.padStart(3)}% | sports=${pctSports.padStart(3)}% | ` +
        `15m_px=${String(avg15mPx).padStart(5)} | 15m_buys=${cnt15mBuys}`
      );
      await sleep(100);
    } catch (e) {
      console.log(`${addr.slice(0, 10)} | error: ${e.message}`);
    }
  }
})();
