#!/usr/bin/env node
// Reconcile stuck unsettled positions in mc-live (or mc) state.
// Used when a smoke test (or any non-restarting run) ends before a position
// has been confirmed as closed by gamma. Loads state.json, retries
// gammaWinner for every position past resolveTs+grace, marks settled,
// appends an exit record to the ledger. Idempotent.
//
// Usage:
//   node scripts/mastercopy/reconcile.js [data-dir]
// Default data-dir: ./data-mc-live
//
// Exit code 0 always; prints a summary.

const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.resolve(process.argv[2] || path.join(__dirname, 'data-mc-live'));
const STATE  = path.join(DATA_DIR, 'strategy-state.json');
const LEDGER = path.join(DATA_DIR, 'strategy-ledger.jsonl');
const GRACE_SEC = 60;

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function gammaWinner(slug) {
  try {
    const data = await getJson(`https://gamma-api.polymarket.com/markets?slug=${slug}&closed=true`);
    if (!data || !data.length || !data[0].closed) return null;
    const prices = JSON.parse(data[0].outcomePrices || '["0","0"]');
    return parseFloat(prices[0]) > 0.5 ? 'Up' : 'Down';
  } catch { return null; }
}

function appendLedger(rec) {
  fs.appendFileSync(LEDGER, JSON.stringify(rec) + '\n');
}

function saveState(s) {
  const tmp = STATE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, STATE);
}

(async () => {
  if (!fs.existsSync(STATE)) {
    console.error(`no state at ${STATE}`); process.exit(0);
  }
  const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  let reconciled = 0, pending = 0, scanned = 0;

  for (const [key, pos] of Object.entries(state.positions || {})) {
    if (pos.settled) continue;
    scanned++;
    if (pos.resolveTs + GRACE_SEC > now) { pending++; continue; }
    const winner = await gammaWinner(pos.slug);
    if (!winner) {
      console.log(`PEND  ${pos.slug.slice(-10)} gamma not closed yet`);
      pending++;
      continue;
    }
    const won = pos.outcome === winner;
    const payout = won ? pos.filledShares : 0;
    const pnl = payout - pos.filledUsd;
    pos.settled = true;
    pos.actualWinner = winner;
    pos.realizedPnl = pnl;
    pos.settleTs = now;
    appendLedger({
      kind: 'exit', ts: now, slug: pos.slug, master: pos.master, winner,
      outcome: pos.outcome, won, pnl,
      filledShares: pos.filledShares, filledUsd: pos.filledUsd, avgFillPrice: pos.avgFillPrice,
      reconciled: true,
    });
    console.log(`${won ? 'WIN ' : 'LOSS'}  ${pos.slug.slice(-10)} ${pos.outcome}->${winner} pnl=$${pnl.toFixed(4)}`);
    reconciled++;
  }

  if (reconciled > 0) saveState(state);
  console.log(`\nscanned=${scanned} reconciled=${reconciled} still_pending=${pending}`);
})();
