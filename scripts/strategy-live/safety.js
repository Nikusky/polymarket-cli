// Hardcoded risk rails. Intentionally not env-driven — changing requires
// editing this file + redeploying, providing a review gate vs accidental
// relaxation in production.
const RAILS = Object.freeze({
  PER_TRADE_USD: 100,
  DAILY_LOSS_USD: -150, // inclusive at -150 exactly; kill at -150.01
  MAX_CONCURRENT: 3,
});

function checkPerTradeSize(sizeUsd) {
  if (sizeUsd > RAILS.PER_TRADE_USD) {
    return { ok: false, reason: `size_exceeds_per_trade_cap (${sizeUsd} > ${RAILS.PER_TRADE_USD})` };
  }
  return { ok: true };
}

function checkDailyLossKill(dailyPnl) {
  if (dailyPnl < RAILS.DAILY_LOSS_USD) {
    return { ok: false, reason: `daily_loss_kill (${dailyPnl.toFixed(2)} < ${RAILS.DAILY_LOSS_USD})` };
  }
  return { ok: true };
}

function checkConcurrentCap(openCount) {
  if (openCount >= RAILS.MAX_CONCURRENT) {
    return { ok: false, reason: `concurrent_cap (${openCount} >= ${RAILS.MAX_CONCURRENT})` };
  }
  return { ok: true };
}

function allClear({ sizeUsd, dailyPnl, openCount }) {
  const a = checkPerTradeSize(sizeUsd); if (!a.ok) return a;
  const b = checkDailyLossKill(dailyPnl); if (!b.ok) return b;
  const c = checkConcurrentCap(openCount); if (!c.ok) return c;
  return { ok: true };
}

module.exports = { RAILS, checkPerTradeSize, checkDailyLossKill, checkConcurrentCap, allClear };
