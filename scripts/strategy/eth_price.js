// ETH/USD price source for the strategy bot.
//
// Mirrors btc_price.js shape. Used by main.js when STRATEGY_PRICE_MODULE=./eth_price.
// Same rationale: median of Coinbase + Kraken (Binance excluded — HTTP 451 from AWS US IPs).

const TIMEOUT_MS = 5000;
const HEADERS = { 'User-Agent': 'polybot-strategy/1.0', 'Accept': 'application/json' };

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: HEADERS });
  if (!r.ok) return null;
  return r.json();
}

async function coinbaseSpot() {
  try {
    const j = await getJson('https://api.coinbase.com/v2/prices/ETH-USD/spot');
    const px = parseFloat(j?.data?.amount);
    return Number.isFinite(px) && px > 0 ? px : null;
  } catch { return null; }
}

async function coinbaseHistorical(unixSec) {
  try {
    const start = new Date((unixSec - 60) * 1000).toISOString();
    const end = new Date((unixSec + 120) * 1000).toISOString();
    const url = `https://api.exchange.coinbase.com/products/ETH-USD/candles?granularity=60&start=${start}&end=${end}`;
    const arr = await getJson(url);
    if (!Array.isArray(arr) || arr.length === 0) return null;
    for (const bar of arr) {
      const t = bar[0];
      if (t <= unixSec && unixSec < t + 60) {
        const open = parseFloat(bar[3]);
        return Number.isFinite(open) && open > 0 ? open : null;
      }
    }
    return null;
  } catch { return null; }
}

async function krakenSpot() {
  try {
    const j = await getJson('https://api.kraken.com/0/public/Ticker?pair=ETHUSD');
    const pairKey = j?.result && Object.keys(j.result)[0];
    if (!pairKey) return null;
    const px = parseFloat(j.result[pairKey]?.c?.[0]);
    return Number.isFinite(px) && px > 0 ? px : null;
  } catch { return null; }
}

async function krakenHistorical(unixSec) {
  try {
    const since = unixSec - 120;
    const url = `https://api.kraken.com/0/public/OHLC?pair=ETHUSD&interval=1&since=${since}`;
    const j = await getJson(url);
    const pairKey = j?.result && Object.keys(j.result).find(k => k !== 'last');
    if (!pairKey) return null;
    const bars = j.result[pairKey];
    if (!Array.isArray(bars) || bars.length === 0) return null;
    for (const bar of bars) {
      const t = bar[0];
      if (t <= unixSec && unixSec < t + 60) {
        const open = parseFloat(bar[1]);
        return Number.isFinite(open) && open > 0 ? open : null;
      }
    }
    return null;
  } catch { return null; }
}

function median(values) {
  const xs = values.filter(v => Number.isFinite(v) && v > 0);
  if (xs.length === 0) return null;
  xs.sort((a, b) => a - b);
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 0 ? (xs[mid - 1] + xs[mid]) / 2 : xs[mid];
}

async function ethPrice(unixSec = null) {
  const calls = unixSec === null
    ? [coinbaseSpot(), krakenSpot()]
    : [coinbaseHistorical(unixSec), krakenHistorical(unixSec)];
  const results = await Promise.all(calls);
  return median(results);
}

module.exports = { ethPrice, price: ethPrice, coinbaseSpot, coinbaseHistorical, krakenSpot, krakenHistorical, median };
