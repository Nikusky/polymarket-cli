// Pure logic helpers for the mastercopy daemon. Stateless, fully testable.
// The daemon (./main.js) wires these to HTTP polling + ledger I/O.

const ALLOWED_SIDES = new Set(['BUY']);

// Match an incoming master trade against the daemon's filter envelope.
// `opts.allowedSides` (a Set) overrides the default BUY-only behaviour;
// pass `new Set(['SELL'])` for the inverse-mirror experiment, or
// `new Set(['BUY','SELL'])` to mirror both halves of the master's flow.
function isCandidateTrade(trade, opts) {
  if (!trade || typeof trade !== 'object') return false;
  const allowed = opts.allowedSides || ALLOWED_SIDES;
  if (!allowed.has(trade.side)) return false;
  if (!opts.slugPrefixes.some((p) => (trade.slug || '').startsWith(p))) return false;
  if (typeof trade.timestamp !== 'number') return false;
  if (trade.timestamp <= opts.lastSeenTs) return false;
  if (!trade.price || trade.price <= 0 || trade.price >= 1) return false;
  return true;
}

// Stable unique key for a master trade — used to dedupe across polls.
function tradeKey(trade) {
  return `${trade.proxyWallet}|${trade.slug}|${trade.transactionHash}`;
}

// Derive openTs and resolveTs from a slug like "btc-updown-15m-1779399900".
// Returns {openTs, resolveTs} or null if the slug doesn't match a known schema.
function parseSlot(slug) {
  const m = /^(.*?)-(\d+)m-(\d+)$/.exec(slug);
  if (!m) return null;
  const minutes = parseInt(m[2], 10);
  const openTs = parseInt(m[3], 10);
  if (!Number.isFinite(minutes) || !Number.isFinite(openTs)) return null;
  return { openTs, resolveTs: openTs + minutes * 60, slotSecs: minutes * 60 };
}

// Returns true if the trade's slot is recent enough to be paper-mirrored.
// Trades whose slot already resolved past `maxLagSec` ago are dropped — we can't
// usefully simulate them (gamma may have pruned the market, and outcome is fixed).
function isFresh(trade, nowTs, maxLagSec) {
  const slot = parseSlot(trade.slug);
  if (!slot) return false;
  return slot.resolveTs + (maxLagSec || 0) >= nowTs;
}

// Build a mirror ledger record from a raw master trade. Pure.
// Records `tradeSide` so settleMirror can branch on BUY vs SELL paper math.
function buildMirror(trade, mirrorSizeUsd, nowTs) {
  const slot = parseSlot(trade.slug);
  if (!slot) return null;
  const paperShares = mirrorSizeUsd / trade.price;
  return {
    kind: 'mirror',
    ts: nowTs,
    slug: trade.slug,
    master: trade.proxyWallet,
    masterName: trade.name || trade.pseudonym || null,
    masterTradeTs: trade.timestamp,
    masterPrice: trade.price,
    masterTxHash: trade.transactionHash,
    tradeSide: trade.side,
    outcome: trade.outcome,
    paperSize: mirrorSizeUsd,
    paperShares,
    openTs: slot.openTs,
    resolveTs: slot.resolveTs,
    minuteInSlot: (trade.timestamp - slot.openTs) / 60,
  };
}

// Resolve a mirror position given the gamma winner. Returns an exit record.
// Branches on mirror.tradeSide for the inverse-mirror experiment:
//   BUY  + outcome wins  → +paperShares − paperSize   (long pays at $1 per share)
//   BUY  + outcome loses → −paperSize                  (long worth $0)
//   SELL + outcome wins  → +paperSize − paperShares   (short owes $1 per share)
//   SELL + outcome loses → +paperSize                  (short keeps the premium)
// Missing tradeSide is treated as BUY for backward compat with legacy records.
function settleMirror(mirror, winner, nowTs) {
  const outcomeWon = mirror.outcome === winner;
  const isShort = mirror.tradeSide === 'SELL';
  let pnl;
  if (outcomeWon) {
    pnl = isShort ? (mirror.paperSize - mirror.paperShares) : (mirror.paperShares - mirror.paperSize);
  } else {
    pnl = isShort ? mirror.paperSize : -mirror.paperSize;
  }
  // `won` historically meant "the outcome we mirrored matched the winner";
  // for SELL records, profitability is the inverse (pnl > 0 ↔ outcome lost).
  return {
    kind: 'exit',
    ts: nowTs,
    slug: mirror.slug,
    master: mirror.master,
    tradeSide: mirror.tradeSide || 'BUY',
    won: outcomeWon,
    winner,
    outcome: mirror.outcome,
    pnl,
    paperShares: mirror.paperShares,
    masterPrice: mirror.masterPrice,
  };
}

// Filter the raw trades list to candidates that should be mirrored now.
// Honors lastSeenTs per master.
function selectNewTrades(rawTrades, opts) {
  const lastSeen = opts.lastSeenByMaster || {};
  const out = [];
  for (const t of rawTrades) {
    const masterLastSeen = lastSeen[t.proxyWallet] || 0;
    if (!isCandidateTrade(t, { ...opts, lastSeenTs: masterLastSeen })) continue;
    out.push(t);
  }
  return out;
}

// Update lastSeenByMaster in place from the newly-selected trades.
function advanceLastSeen(lastSeenByMaster, newTrades) {
  for (const t of newTrades) {
    const cur = lastSeenByMaster[t.proxyWallet] || 0;
    if (t.timestamp > cur) lastSeenByMaster[t.proxyWallet] = t.timestamp;
  }
}

module.exports = {
  ALLOWED_SIDES,
  isCandidateTrade,
  isFresh,
  tradeKey,
  parseSlot,
  buildMirror,
  settleMirror,
  selectNewTrades,
  advanceLastSeen,
};
