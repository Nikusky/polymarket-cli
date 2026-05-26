// Mastercopy LIVE executor — places real CLOB orders mirroring master BUYs.
//
// ⚠️ CRITICAL: this places REAL ORDERS with REAL USDC. Disabled by default.
// The systemd unit `polybot-mastercopy-live.service` ships without an
// `[Install]` symlink in setup.sh's auto-enable list. Activation requires:
//   1. Wallet funded with >= MIN_BALANCE_USD (default $200) on the proxy
//   2. /etc/polybot/proxy-key.env populated with POLYMARKET_PRIVATE_KEY
//   3. Explicit `sudo systemctl enable --now polybot-mastercopy-live`
//
// Env:
//   STRATEGY_DATA_DIR    - data-mc-live (writes live-ledger.jsonl + state)
//   MASTER_ADDRESSES     - CSV of master proxy wallets (same as paper)
//   SLUG_PREFIXES        - CSV of slug prefixes (default btc-updown-15m-)
//   MIRROR_SIZE_USD      - $ per live order (default 5)
//   FILL_CAP_MULT        - max fill price as multiple of masterPrice (default 1.10)
//   POLL_INTERVAL_SEC    - master-feed poll cadence (default 30)
//   MAX_LAG_SEC          - skip trades older than this — live is time-sensitive (default 1800)
//   MIN_BALANCE_USD      - abort orders if cash below this (default 200)
//   MAX_DAILY_LOSS_USD   - kill all entries for the day at this drawdown (default 300)
//   MAX_CONCURRENT       - skip new entries if more than this open (default 150)
//   CLI_BIN              - path to polymarket Rust binary
//   POLYMARKET_PRIVATE_KEY (loaded via EnvironmentFile)
//
// Kill switch: `touch <STRATEGY_DATA_DIR>/bot-killed` — bot exits on next iter.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { selectNewTrades, parseSlot, advanceLastSeen, isFresh } = require('./lib');
const { decideFill, checkRiskGates, rollingPnl, bestAskFromBook } = require('./live-lib');

// ── Config ──────────────────────────────────────────────────────────────────
const DATA_DIR = process.env.STRATEGY_DATA_DIR
  ? path.resolve(process.env.STRATEGY_DATA_DIR)
  : path.join(__dirname, 'data-mc-live');
const LEDGER = path.join(DATA_DIR, 'live-ledger.jsonl');
const STATE  = path.join(DATA_DIR, 'live-state.json');
const KILL   = path.join(DATA_DIR, 'bot-killed');

const MASTERS = (process.env.MASTER_ADDRESSES || '0xce25e214d5cfe4f459cf67f08df581885aae7fdc,0xb55fa1296e6ec55d0ce53d93b9237389f11764d4,0xa9239c0ca3dee2d03232481212474e1d781b6704')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const SLUG_PREFIXES = (process.env.SLUG_PREFIXES || 'btc-updown-15m-')
  .split(',').map((s) => s.trim()).filter(Boolean);

const MIRROR_SIZE_USD    = parseFloat(process.env.MIRROR_SIZE_USD     || '5');
const FILL_CAP_MULT      = parseFloat(process.env.FILL_CAP_MULT       || '1.10');
const POLL_INTERVAL_SEC  = parseInt  (process.env.POLL_INTERVAL_SEC   || '30',   10);
const MAX_LAG_SEC        = parseInt  (process.env.MAX_LAG_SEC         || '1800', 10);
const MIN_BALANCE_USD    = parseFloat(process.env.MIN_BALANCE_USD     || '200');
const MAX_DAILY_LOSS_USD = parseFloat(process.env.MAX_DAILY_LOSS_USD  || '300');
const MAX_CONCURRENT     = parseInt  (process.env.MAX_CONCURRENT      || '150',  10);
const CLI_BIN            = process.env.CLI_BIN || path.resolve(__dirname, '..', '..', 'target', 'release', 'polymarket');
const MAX_HOURS          = parseFloat(process.argv[2] || '168');
const STOP_AT            = Date.now() + MAX_HOURS * 3600 * 1000;

const GATES = {
  minBalanceUsd:    MIN_BALANCE_USD,
  maxDailyLossUsd:  MAX_DAILY_LOSS_USD,
  maxConcurrent:    MAX_CONCURRENT,
};

fs.mkdirSync(DATA_DIR, { recursive: true });

// ── I/O helpers ─────────────────────────────────────────────────────────────
function log(level, msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts.slice(11, 19)}] ${level.padEnd(5)} ${msg}`);
}
function append(record) { fs.appendFileSync(LEDGER, JSON.stringify(record) + '\n'); }
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); }
  catch { return { lastSeenByMaster: {}, positions: {} }; }
}
function saveState(s) {
  const tmp = STATE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, STATE);
}
function readLedger() {
  try {
    return fs.readFileSync(LEDGER, 'utf8').trim().split('\n')
      .filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// ── CLI shell-out ───────────────────────────────────────────────────────────
function runCli(args, timeoutMs = 15000) {
  const r = spawnSync(CLI_BIN, args.concat(['--output', 'json']), {
    encoding: 'utf8', timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024,
  });
  if (r.status !== 0) {
    log('warn', `CLI ${args.slice(0, 3).join(' ')}… failed: ${(r.stderr || '').trim().slice(0, 200)}`);
    return null;
  }
  try { return JSON.parse(r.stdout); } catch { return null; }
}

function readBalance() {
  const r = runCli(['clob', 'balance', '--asset-type', 'collateral']);
  if (!r) return null;
  const raw = r.balance ?? r.collateral ?? r;
  const n = parseFloat(typeof raw === 'object' ? (raw.balance ?? 0) : raw);
  return Number.isFinite(n) ? n : null;
}

// ── HTTP helpers ────────────────────────────────────────────────────────────
const HEADERS = { 'User-Agent': 'polybot-mastercopy-live/1.0', 'Accept': 'application/json' };
async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: HEADERS });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function fetchMasterTrades(addr, limit = 50) {
  try { return await getJson(`https://data-api.polymarket.com/trades?user=${addr}&limit=${limit}`); }
  catch (e) { log('warn', `fetch trades failed for ${addr.slice(0, 8)}: ${e.message}`); return []; }
}
async function tokenIdFor(slug, outcome) {
  try {
    const data = await getJson(`https://gamma-api.polymarket.com/markets?slug=${slug}`);
    if (!data || !data[0]) return null;
    const tokenIds = JSON.parse(data[0].clobTokenIds || '[]');
    const outcomes = JSON.parse(data[0].outcomes || '[]');
    const idx = outcomes.indexOf(outcome);
    if (idx < 0 || !tokenIds[idx]) return null;
    return tokenIds[idx];
  } catch { return null; }
}
async function gammaWinner(slug) {
  try {
    const data = await getJson(`https://gamma-api.polymarket.com/markets?slug=${slug}&closed=true`);
    if (!data || !data.length || !data[0].closed) return null;
    const prices = JSON.parse(data[0].outcomePrices || '["0","0"]');
    return parseFloat(prices[0]) > 0.5 ? 'Up' : 'Down';
  } catch { return null; }
}

// ── Settle resolved positions ───────────────────────────────────────────────
// We do NOT actively sell — Polymarket auto-credits the winning side at
// resolution on binary markets, matching the masters' own strategy of holding
// to resolution (see memory: masters-zero-sell-flow-2026-05-24).
// We just RECORD the realized outcome for PnL accounting.
async function settleOpenPositions(state, now) {
  let settled = 0;
  for (const [key, pos] of Object.entries(state.positions)) {
    if (pos.settled) continue;
    if (pos.resolveTs + 60 > now) continue;
    const winner = await gammaWinner(pos.slug);
    if (!winner) continue;
    const won = pos.outcome === winner;
    const payout = won ? pos.filledShares : 0;
    const pnl = payout - pos.filledUsd;
    pos.settled = true;
    pos.actualWinner = winner;
    pos.realizedPnl = pnl;
    pos.settleTs = now;
    append({
      kind: 'exit', ts: now, slug: pos.slug, master: pos.master, winner,
      outcome: pos.outcome, won, pnl,
      filledShares: pos.filledShares, filledUsd: pos.filledUsd, avgFillPrice: pos.avgFillPrice,
    });
    log(won ? 'WIN  ' : 'LOSS ', `${pos.outcome}->${winner} pnl=$${pnl.toFixed(4)} ${pos.slug.slice(-10)}`);
    settled++;
  }
  // Trim resolved positions older than an hour to keep state small.
  for (const k of Object.keys(state.positions)) {
    const p = state.positions[k];
    if (p.settled && p.settleTs + 3600 < now) delete state.positions[k];
  }
  return settled;
}

// ── Main loop ───────────────────────────────────────────────────────────────
async function pollOnce(state) {
  // Kill switch first — cheapest check, exits process immediately.
  if (fs.existsSync(KILL)) { log('KILL ', `kill-file present at ${KILL}, exiting`); process.exit(0); }

  const now = Math.floor(Date.now() / 1000);
  const settledCount = await settleOpenPositions(state, now);
  const openCount = Object.values(state.positions).filter((p) => !p.settled).length;
  const dailyPnl  = rollingPnl(readLedger(), now, 86400);

  let entered = 0, skipped = 0;
  for (const addr of MASTERS) {
    const trades = await fetchMasterTrades(addr);
    const candidates = selectNewTrades(trades, {
      slugPrefixes: SLUG_PREFIXES,
      lastSeenByMaster: state.lastSeenByMaster,
    });

    for (const t of candidates) {
      if (!isFresh(t, now, MAX_LAG_SEC)) { skipped++; continue; }
      const slot = parseSlot(t.slug);
      if (!slot) { skipped++; continue; }
      const key = `${t.proxyWallet}|${t.slug}|${t.transactionHash}`;
      if (state.positions[key]) { skipped++; continue; }

      // Per-trade balance read (fresh — orders settle quickly).
      const balance = readBalance();
      const gate = checkRiskGates({
        balanceUsd: balance, dailyPnl, openCount: openCount + entered,
        killFileExists: fs.existsSync(KILL), gates: GATES,
      });
      if (!gate.ok) {
        append({ kind: 'skip_live', ts: now, slug: t.slug, master: t.proxyWallet,
                 masterPrice: t.price, reason: gate.reason,
                 balance, dailyPnl, openCount: openCount + entered });
        log('SKIP ', `${gate.reason} balance=$${(balance ?? -1).toFixed(2)} ` +
                    `dailyPnl=$${dailyPnl.toFixed(2)} open=${openCount + entered} ${t.slug.slice(-10)}`);
        skipped++;
        if (gate.reason === 'drawdown_kill' || gate.reason === 'kill_file') return { entered, skipped, settled: settledCount };
        continue;
      }

      // Resolve token, read book, check price cap.
      const tokenId = await tokenIdFor(t.slug, t.outcome);
      if (!tokenId) {
        append({ kind: 'skip_live', ts: now, slug: t.slug, master: t.proxyWallet,
                 masterPrice: t.price, reason: 'no_token_id' });
        skipped++; continue;
      }
      const book = runCli(['clob', 'book', tokenId]);
      const ask  = bestAskFromBook(book);
      const fill = decideFill(t.price, ask, MIRROR_SIZE_USD, FILL_CAP_MULT);
      if (!fill.ok) {
        append({ kind: 'skip_live', ts: now, slug: t.slug, master: t.proxyWallet,
                 masterPrice: t.price, reason: fill.reason,
                 bestAsk: ask, priceLimit: fill.cap });
        log('SKIP ', `${fill.reason} master=$${t.price.toFixed(3)} ask=${(ask ?? 0).toFixed(3)} ` +
                    `cap=$${(fill.cap || 0).toFixed(3)} ${t.slug.slice(-10)}`);
        skipped++;
        continue;
      }

      // Place the order: FAK (Fill-And-Kill) = marketable limit, takes
      // available liquidity up to limitPrice, cancels the rest. This is
      // what gives us the masterPrice × 1.10 price cap.
      const sizeShares = fill.shares.toFixed(2);
      const order = runCli([
        'clob', 'create-order',
        '--token', tokenId,
        '--side',  'buy',
        '--price', fill.limitPrice.toFixed(3),
        '--size',  sizeShares,
        '--order-type', 'FAK',
      ], 20000);
      if (!order || order.error) {
        append({ kind: 'skip_live', ts: now, slug: t.slug, master: t.proxyWallet,
                 masterPrice: t.price, reason: 'order_failed',
                 detail: order?.error || 'no response', priceLimit: fill.limitPrice });
        log('FAIL ', `order rejected for ${t.slug.slice(-10)}: ${order?.error || 'no response'}`);
        skipped++; continue;
      }

      // Extract realized fill. Polymarket order responses commonly include
      // matchedAmount (shares) and avgPrice for FAK fills; fall back to
      // submitted values if the response shape varies.
      const filledShares = parseFloat(order.matchedAmount ?? order.takingAmount ?? sizeShares);
      const avgFillPrice = parseFloat(order.avgPrice ?? fill.limitPrice);
      const filledUsd    = filledShares * avgFillPrice;

      const entry = {
        kind: 'live', ts: now, slug: t.slug, master: t.proxyWallet,
        masterPrice: t.price, masterTradeTs: t.timestamp, masterTxHash: t.transactionHash,
        outcome: t.outcome, tokenId,
        bestAskAtCheck: ask, priceLimit: fill.limitPrice,
        orderId: order.orderId ?? order.id ?? null,
        filledShares, filledUsd, avgFillPrice,
        openTs: slot.openTs, resolveTs: slot.resolveTs,
      };
      state.positions[key] = { ...entry, settled: false };
      append(entry);
      log('LIVE ', `${t.outcome} ${filledShares.toFixed(2)}sh @ $${avgFillPrice.toFixed(3)} ` +
                  `(master $${t.price.toFixed(3)}) ${t.slug.slice(-10)}`);
      entered++;
    }
    advanceLastSeen(state.lastSeenByMaster, candidates);
  }

  saveState(state);
  return { entered, skipped, settled: settledCount };
}

async function main() {
  log('info ', `mastercopy LIVE starting | masters=${MASTERS.length} ` +
              `size=$${MIRROR_SIZE_USD} cap=${FILL_CAP_MULT}× ` +
              `gates: minBal=$${MIN_BALANCE_USD} maxLoss=$${MAX_DAILY_LOSS_USD}/24h ` +
              `maxOpen=${MAX_CONCURRENT}`);
  log('info ', `ledger=${LEDGER}`);
  log('info ', `kill=${KILL} (touch to stop)`);
  log('info ', `CLI=${CLI_BIN}`);

  // Boot gate: refuse to start if balance is unreadable or below MIN.
  const bootBalance = readBalance();
  if (bootBalance === null) {
    log('err  ', 'cannot read balance at boot — check POLYMARKET_PRIVATE_KEY and CLI_BIN');
    process.exit(2);
  }
  if (bootBalance < MIN_BALANCE_USD) {
    log('err  ', `boot balance $${bootBalance.toFixed(2)} below MIN_BALANCE_USD $${MIN_BALANCE_USD} — refusing to start`);
    process.exit(2);
  }
  log('info ', `boot balance: $${bootBalance.toFixed(2)} — gates clear, entering main loop`);

  const state = loadState();
  while (Date.now() < STOP_AT) {
    try {
      const r = await pollOnce(state);
      if (r.entered || r.skipped || r.settled) {
        log('tick ', `entered=${r.entered} skipped=${r.skipped} settled=${r.settled}`);
      }
    } catch (e) {
      log('err  ', `pollOnce: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_SEC * 1000));
  }
  log('info ', 'runtime cap reached, exiting');
}

if (require.main === module) main();

module.exports = { pollOnce, loadState, saveState, readLedger };
