// Persistent state for the live executor: data-live/state.json. Atomic
// writes via write-temp-then-rename. Idempotency = orderHistory: {paperSlug -> clobOrderId}.
const fs = require('fs');
const path = require('path');

// Match the dashboard's convention (readers.js reads <dataDir>/strategy-state.json).
const STATE_FILENAME = 'strategy-state.json';

function defaultState() {
  return {
    positions: {},
    orderHistory: {},
    dailyPnl: {},
    killSwitch: { active: false, reason: null },
  };
}

function statePath(dataDir) {
  return path.join(dataDir, STATE_FILENAME);
}

function loadState(dataDir) {
  try {
    const raw = fs.readFileSync(statePath(dataDir), 'utf8');
    const parsed = JSON.parse(raw);
    return { ...defaultState(), ...parsed };
  } catch (e) {
    if (e.code === 'ENOENT') return defaultState();
    throw e;
  }
}

function saveState(dataDir, state) {
  const final = statePath(dataDir);
  const tmp = final + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, final);
}

function recordOrder(state, paperSlug, clobOrderId) {
  state.orderHistory[paperSlug] = clobOrderId;
}

function hasOrderFor(state, paperSlug) {
  return Object.prototype.hasOwnProperty.call(state.orderHistory, paperSlug);
}

function utcDayKey(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

function addRealizedPnl(state, unixSeconds, delta) {
  const day = utcDayKey(unixSeconds);
  state.dailyPnl[day] = (state.dailyPnl[day] || 0) + delta;
}

function dailyPnlForToday(state, nowUnixSeconds) {
  const day = utcDayKey(nowUnixSeconds);
  return state.dailyPnl[day] || 0;
}

module.exports = {
  defaultState, loadState, saveState,
  recordOrder, hasOrderFor,
  addRealizedPnl, dailyPnlForToday, utcDayKey,
};
