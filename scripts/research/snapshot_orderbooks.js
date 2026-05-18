// Snapshots 15-min BTC up/down market order books at observe-minute 11.
// Long-lived loop. Appends JSON-per-line to data/orderbook_snapshots.jsonl.
//
// Usage:
//   node scripts/research/snapshot_orderbooks.js [observeMin] [maxRuntimeHours]
// Defaults: observeMin=11, runtime=168 (1 week).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = (() => {
  const base = path.join(__dirname, '..', '..', 'target');
  const candidates = [
    path.join(base, 'release', 'polymarket'),
    path.join(base, 'release', 'polymarket.exe'),
    path.join(base, 'debug', 'polymarket'),
    path.join(base, 'debug', 'polymarket.exe'),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error(`polymarket binary not found; checked: ${candidates.join(', ')}`);
})();
const OUT = path.join(__dirname, 'data', 'orderbook_snapshots.jsonl');
const SCHED = path.join(__dirname, 'data', 'snapshot_schedule.json');

const OBSERVE_MIN = parseInt(process.argv[2] || '11');
const MAX_HOURS = parseFloat(process.argv[3] || '168');
const STOP_AT = Date.now() + MAX_HOURS * 3600 * 1000;

function appendLine(obj) { fs.appendFileSync(OUT, JSON.stringify(obj) + '\n'); }
function loadSchedule() { try { return JSON.parse(fs.readFileSync(SCHED, 'utf8')); } catch { return {}; } }
function saveSchedule(s) { fs.writeFileSync(SCHED, JSON.stringify(s)); }

function runCli(args, timeoutMs = 15000) {
  const r = spawnSync(CLI, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function fetchMarketBySlug(slug) {
  const r = runCli(['markets', 'get', slug, '--output', 'json']);
  if (r.code !== 0) return null;
  let m = null; try { m = JSON.parse(r.stdout); } catch { return null; }
  if (!m || !m.slug) return null;
  // Parse the JSON-string fields
  try { m._tokens = JSON.parse(m.clobTokenIds || '[]'); } catch { m._tokens = []; }
  try { m._outcomes = JSON.parse(m.outcomes || '[]'); } catch { m._outcomes = []; }
  return m;
}

function parseEpoch(slug) {
  const rest = (slug || '').replace('btc-updown-15m-', '').split('-')[0];
  const n = parseInt(rest);
  return n > 1_000_000_000 ? n : null;
}

function enumerateCurrentWindowSlugs() {
  // Returns slugs for the current and next 15-minute boundaries (so we never miss one)
  const now = Math.floor(Date.now() / 1000);
  const cur = now - (now % 900);
  return [cur, cur + 900].map(e => `btc-updown-15m-${e}`);
}

function snapshotMarket(market) {
  const result = {
    ts: Math.floor(Date.now() / 1000),
    slug: market.slug,
    condition_id: market.conditionId,
    open_ts: parseEpoch(market.slug),
    observe_min_offset: OBSERVE_MIN,
    outcomes: market._outcomes,
    tokens: [],
  };
  for (let i = 0; i < market._tokens.length; i++) {
    const id = market._tokens[i];
    const outcome = market._outcomes[i] || null;
    const book = runCli(['clob', 'book', id, '--output', 'json'], 10000);
    let parsed = null; try { parsed = JSON.parse(book.stdout); } catch {}
    result.tokens.push({ token_id: id, outcome, book: parsed });
  }
  appendLine(result);
}

async function loop() {
  console.log(`[snapshot] starting, observeMin=${OBSERVE_MIN}, runtime=${MAX_HOURS}h`);
  console.log(`[snapshot] output → ${OUT}`);
  let schedule = loadSchedule();
  while (Date.now() < STOP_AT) {
    const nowSec = Math.floor(Date.now() / 1000);
    try {
      const slugs = enumerateCurrentWindowSlugs();
      for (const slug of slugs) {
        const open = parseEpoch(slug);
        if (!open) continue;
        const fireAt = open + OBSERVE_MIN * 60;
        if (!schedule[slug]) schedule[slug] = { fireAt, fired: false, slug };
        if (!schedule[slug].fired && nowSec >= fireAt && nowSec < fireAt + 60) {
          const m = fetchMarketBySlug(slug);
          if (!m) { console.log(`[${new Date().toISOString().slice(11,19)}] ${slug} not yet listed`); continue; }
          console.log(`[${new Date().toISOString().slice(11,19)}] snapshot ${slug}`);
          snapshotMarket(m);
          schedule[slug].fired = true;
          saveSchedule(schedule);
        }
      }
      for (const k of Object.keys(schedule)) {
        if (schedule[k].fireAt + 3600 < nowSec) delete schedule[k];
      }
      saveSchedule(schedule);
    } catch (e) {
      console.error(`[loop] ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 15000));
  }
  console.log('[snapshot] runtime cap reached, exiting');
}

loop();
