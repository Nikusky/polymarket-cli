// Master-hunt: find candidate directional traders on btc-updown-15m.
// Sample-based methodology. Read-only; writes a JSON report to /tmp.
//
// Method:
//   1. Enumerate all 15m slots in last 7d.
//   2. Random-sample 100 of them.
//   3. For each sampled slot, resolve slug -> conditionId via gamma,
//      then fetch all BUY trades via data-api.
//   4. Aggregate by proxyWallet (excluding the 3 known masters).
//   5. Score: trades/slot, single-sided %, avg fill, late-window %, win rate.
//   6. Filter for directional signature; rank by win_rate * sqrt(decided).
//
// Usage:  node scripts/research/master_hunt.js

const fs = require('fs');

const HEADERS = { 'User-Agent': 'polybot-research/1.0', 'Accept': 'application/json' };
const SLOT_SECS = 900;
const WINDOW_DAYS = 7;
const SAMPLE_SLOTS = 100;
const MIN_SLOTS = 3;
const SLEEP_MS = 50;

const EXCLUDE = new Set([
  '0xce25e214d5cfe4f459cf67f08df581885aae7fdc',
  '0xb55fa1296e6ec55d0ce53d93b9237389f11764d4',
  '0x89b5cdaaa4866c1e738406712012a630b4078beb',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(10000), headers: HEADERS });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i === retries) throw e;
      await sleep(1000 * (i + 1));
    }
  }
}

async function resolveMarket(slug) {
  const data = await getJson(`https://gamma-api.polymarket.com/markets?slug=${slug}&closed=true`);
  if (!Array.isArray(data) || data.length === 0) return null;
  const m = data[0];
  let winner = null;
  if (m.closed && m.outcomePrices) {
    try {
      const prices = JSON.parse(m.outcomePrices);
      if (prices.length >= 2) winner = parseFloat(prices[0]) > 0.5 ? 'Up' : 'Down';
    } catch {}
  }
  return { conditionId: m.conditionId, winner };
}

async function fetchSlotTrades(conditionId) {
  return await getJson(
    `https://data-api.polymarket.com/trades?market=${conditionId}&limit=500`
  );
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

(async () => {
  const NOW = Math.floor(Date.now() / 1000);
  const startSlot = Math.floor((NOW - WINDOW_DAYS * 86400) / SLOT_SECS) * SLOT_SECS;
  const endSlot = Math.floor(NOW / SLOT_SECS) * SLOT_SECS - SLOT_SECS;

  const allSlots = [];
  for (let t = startSlot; t <= endSlot; t += SLOT_SECS) allSlots.push(t);
  console.log(`enumerated ${allSlots.length} slots in last ${WINDOW_DAYS}d; sampling ${SAMPLE_SLOTS}`);

  shuffle(allSlots);
  const sample = allSlots.slice(0, SAMPLE_SLOTS);

  const wallets = new Map();
  const winnerBySlug = new Map();
  let resolved = 0, fetched = 0, errors = 0;

  for (const openTs of sample) {
    const slug = `btc-updown-15m-${openTs}`;
    try {
      const res = await resolveMarket(slug);
      if (!res || !res.conditionId) { errors++; continue; }
      resolved++;
      if (res.winner) winnerBySlug.set(slug, res.winner);

      const trades = await fetchSlotTrades(res.conditionId);
      fetched++;
      for (const t of trades) {
        if (t.side !== 'BUY') continue;
        const w = (t.proxyWallet || '').toLowerCase();
        if (!w || EXCLUDE.has(w)) continue;
        if (!wallets.has(w)) wallets.set(w, { slots: new Set(), trades: [], pseudonym: null });
        const e = wallets.get(w);
        e.slots.add(slug);
        e.pseudonym = e.pseudonym || t.pseudonym || null;
        e.trades.push({ slug, price: t.price, ts: t.timestamp, outcome: t.outcome, openTs });
      }
    } catch (e) {
      errors++;
    }
    if ((resolved + errors) % 10 === 0) {
      console.log(`  progress: ${resolved}/${sample.length} resolved, ${fetched} fetched, ${errors} err, ${wallets.size} wallets`);
    }
    await sleep(SLEEP_MS);
  }
  console.log(`done sampling: ${wallets.size} candidate wallets discovered`);

  const candidates = [...wallets.entries()]
    .filter(([, v]) => v.slots.size >= MIN_SLOTS);
  console.log(`${candidates.length} wallets appear in >=${MIN_SLOTS} sampled slots`);

  const scored = candidates.map(([addr, info]) => {
    const slotMap = new Map();
    for (const t of info.trades) {
      if (!slotMap.has(t.slug)) slotMap.set(t.slug, []);
      slotMap.get(t.slug).push(t);
    }
    const slotsArr = [...slotMap.values()];
    const total_trades = info.trades.length;
    const slots_covered = slotMap.size;
    const trades_per_slot = total_trades / slots_covered;
    const single_sided_slots = slotsArr.filter((arr) => new Set(arr.map((x) => x.outcome)).size === 1).length;
    const slot_single_sided = single_sided_slots / slots_covered;
    const avg_fill = info.trades.reduce((s, t) => s + (t.price || 0), 0) / total_trades;
    const late_window = info.trades.filter((t) => (t.ts - t.openTs) >= 600).length / total_trades;

    let wins = 0, decided = 0;
    for (const [slug, arr] of slotMap.entries()) {
      const winner = winnerBySlug.get(slug);
      if (!winner) continue;
      const sides = new Set(arr.map((x) => x.outcome));
      if (sides.size !== 1) continue;
      decided++;
      if ([...sides][0] === winner) wins++;
    }
    const win_rate = decided > 0 ? wins / decided : null;

    return {
      addr,
      pseudonym: info.pseudonym,
      total_trades,
      slots_covered,
      trades_per_slot: +trades_per_slot.toFixed(2),
      slot_single_sided: +slot_single_sided.toFixed(3),
      avg_fill: +avg_fill.toFixed(3),
      late_window: +late_window.toFixed(3),
      win_rate: win_rate === null ? null : +win_rate.toFixed(3),
      wins,
      decided,
    };
  });

  const passed = scored.filter((s) =>
    s.trades_per_slot <= 3 &&
    s.slot_single_sided >= 0.8 &&
    s.avg_fill >= 0.55 &&
    s.decided >= 5
  );
  passed.sort((a, b) => (b.win_rate || 0) * Math.sqrt(b.decided) - (a.win_rate || 0) * Math.sqrt(a.decided));

  const fmt = (s) =>
    `${s.addr.slice(0, 10)} ${(s.pseudonym || '').slice(0, 14).padEnd(14)} n=${String(s.total_trades).padStart(3)} ` +
    `slots=${String(s.slots_covered).padStart(2)} tps=${String(s.trades_per_slot).padStart(5)} ` +
    `1side=${String(s.slot_single_sided).padStart(5)} avgPx=${String(s.avg_fill).padStart(5)} ` +
    `late=${String(s.late_window).padStart(5)} win=${s.win_rate === null ? '  -  ' : String(s.win_rate).padStart(5)} ` +
    `dec=${s.decided}`;

  console.log('\n=== PASSED FILTER (directional signature, ranked by win_rate * sqrt(decided)) ===');
  if (passed.length === 0) console.log('  (none passed)');
  for (const s of passed.slice(0, 20)) console.log('  ' + fmt(s));

  console.log('\n=== TOP 30 BY ACTIVITY (all candidates, for context) ===');
  scored.sort((a, b) => b.total_trades - a.total_trades);
  for (const s of scored.slice(0, 30)) console.log('  ' + fmt(s));

  const outPath = '/tmp/master-hunt.json';
  fs.writeFileSync(outPath, JSON.stringify({
    samplingTs: NOW,
    samplingDate: new Date(NOW * 1000).toISOString(),
    windowDays: WINDOW_DAYS,
    sampleSize: SAMPLE_SLOTS,
    resolved, fetched, errors,
    walletsDiscovered: wallets.size,
    candidatesAtMinSlots: candidates.length,
    passedFilter: passed.length,
    passed,
    scored,
  }, null, 2));
  console.log(`\nfull results -> ${outPath}`);
})();
