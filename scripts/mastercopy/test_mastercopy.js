// Tests for the mastercopy daemon. Pure-logic + dependency-injected pollOnce.
// Run: node scripts/mastercopy/test_mastercopy.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

let failed = 0;
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => console.log(`  ok ${name}`),
        (e) => { failed++; console.log(`  FAIL ${name}\n    ${e.message}`); });
    }
    console.log(`  ok ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n    ${e.message}`);
  }
}

console.log('== lib pure logic ==');

const lib = require('./lib');

function mkTrade(over = {}) {
  return {
    proxyWallet: '0xce25e214d5cfe4f459cf67f08df581885aae7fdc',
    side: 'BUY',
    asset: '999',
    conditionId: '0xCONDITION',
    size: 22.22,
    price: 0.45,
    timestamp: 1779399960,
    title: 'Bitcoin Up or Down - 15m slot',
    slug: 'btc-updown-15m-1779399900',
    outcome: 'Up',
    outcomeIndex: 0,
    name: 'cE25',
    pseudonym: 'someUser',
    transactionHash: '0xabc123',
    ...over,
  };
}

test('isCandidateTrade accepts valid BUY in tracked prefix', () => {
  const t = mkTrade();
  assert.ok(lib.isCandidateTrade(t, { slugPrefixes: ['btc-updown-15m-'], lastSeenTs: 0 }));
});

test('isCandidateTrade rejects SELL', () => {
  const t = mkTrade({ side: 'SELL' });
  assert.ok(!lib.isCandidateTrade(t, { slugPrefixes: ['btc-updown-15m-'], lastSeenTs: 0 }));
});

test('isCandidateTrade rejects wrong prefix', () => {
  const t = mkTrade({ slug: 'eth-updown-15m-1779399900' });
  assert.ok(!lib.isCandidateTrade(t, { slugPrefixes: ['btc-updown-15m-'], lastSeenTs: 0 }));
});

test('isCandidateTrade respects multiple prefixes', () => {
  const t = mkTrade({ slug: 'eth-updown-15m-1779399900' });
  assert.ok(lib.isCandidateTrade(t, { slugPrefixes: ['btc-updown-15m-', 'eth-updown-15m-'], lastSeenTs: 0 }));
});

test('isCandidateTrade rejects timestamp <= lastSeenTs', () => {
  const t = mkTrade({ timestamp: 1779399960 });
  assert.ok(!lib.isCandidateTrade(t, { slugPrefixes: ['btc-updown-15m-'], lastSeenTs: 1779399960 }));
  assert.ok(!lib.isCandidateTrade(t, { slugPrefixes: ['btc-updown-15m-'], lastSeenTs: 1779400000 }));
  assert.ok(lib.isCandidateTrade(t, { slugPrefixes: ['btc-updown-15m-'], lastSeenTs: 1779399000 }));
});

test('isCandidateTrade rejects invalid price', () => {
  for (const p of [0, -0.1, 1, 1.1]) {
    const t = mkTrade({ price: p });
    assert.ok(!lib.isCandidateTrade(t, { slugPrefixes: ['btc-updown-15m-'], lastSeenTs: 0 }),
      `should reject price=${p}`);
  }
});

test('parseSlot returns correct openTs and resolveTs for 15m', () => {
  const r = lib.parseSlot('btc-updown-15m-1779399900');
  assert.deepStrictEqual(r, { openTs: 1779399900, resolveTs: 1779400800, slotSecs: 900 });
});

test('parseSlot returns correct values for 5m', () => {
  const r = lib.parseSlot('btc-updown-5m-1779399900');
  assert.deepStrictEqual(r, { openTs: 1779399900, resolveTs: 1779400200, slotSecs: 300 });
});

test('parseSlot returns null for malformed slug', () => {
  assert.strictEqual(lib.parseSlot('not-a-slug'), null);
  assert.strictEqual(lib.parseSlot('btc-updown-no-epoch'), null);
});

test('buildMirror correct shape and math', () => {
  const t = mkTrade();
  const m = lib.buildMirror(t, 1, 1779399965);
  assert.strictEqual(m.kind, 'mirror');
  assert.strictEqual(m.slug, t.slug);
  assert.strictEqual(m.master, t.proxyWallet);
  assert.strictEqual(m.masterPrice, 0.45);
  assert.strictEqual(m.outcome, 'Up');
  assert.strictEqual(m.paperSize, 1);
  assert.ok(Math.abs(m.paperShares - (1 / 0.45)) < 1e-9);
  assert.strictEqual(m.openTs, 1779399900);
  assert.strictEqual(m.resolveTs, 1779400800);
  assert.ok(Math.abs(m.minuteInSlot - 1.0) < 1e-9);
});

test('buildMirror returns null on malformed slug', () => {
  const t = mkTrade({ slug: 'bad' });
  assert.strictEqual(lib.buildMirror(t, 1, 0), null);
});

test('settleMirror WIN: bought Up at 0.45, Up wins', () => {
  const m = lib.buildMirror(mkTrade({ outcome: 'Up', price: 0.45 }), 1, 1779399965);
  const exit = lib.settleMirror(m, 'Up', 1779400860);
  assert.strictEqual(exit.kind, 'exit');
  assert.strictEqual(exit.won, true);
  assert.strictEqual(exit.winner, 'Up');
  assert.ok(Math.abs(exit.pnl - (1/0.45 - 1)) < 1e-9, `pnl=${exit.pnl}`);
});

test('settleMirror LOSS: bought Up at 0.45, Down wins', () => {
  const m = lib.buildMirror(mkTrade({ outcome: 'Up', price: 0.45 }), 1, 1779399965);
  const exit = lib.settleMirror(m, 'Down', 1779400860);
  assert.strictEqual(exit.won, false);
  assert.strictEqual(exit.pnl, -1);
});

test('settleMirror cheap fill WIN: bought Up at 0.05, Up wins', () => {
  const m = lib.buildMirror(mkTrade({ outcome: 'Up', price: 0.05 }), 1, 0);
  const exit = lib.settleMirror(m, 'Up', 0);
  assert.ok(Math.abs(exit.pnl - 19) < 1e-9);
});

test('isCandidateTrade accepts SELL when allowedSides includes SELL', () => {
  const t = mkTrade({ side: 'SELL' });
  assert.ok(lib.isCandidateTrade(t, {
    slugPrefixes: ['btc-updown-15m-'],
    lastSeenTs: 0,
    allowedSides: new Set(['SELL']),
  }));
});

test('isCandidateTrade rejects BUY when allowedSides is SELL-only', () => {
  const t = mkTrade({ side: 'BUY' });
  assert.ok(!lib.isCandidateTrade(t, {
    slugPrefixes: ['btc-updown-15m-'],
    lastSeenTs: 0,
    allowedSides: new Set(['SELL']),
  }));
});

test('isCandidateTrade accepts both BUY and SELL when allowedSides has both', () => {
  const sides = new Set(['BUY', 'SELL']);
  const baseOpts = { slugPrefixes: ['btc-updown-15m-'], lastSeenTs: 0, allowedSides: sides };
  assert.ok(lib.isCandidateTrade(mkTrade({ side: 'BUY' }), baseOpts));
  assert.ok(lib.isCandidateTrade(mkTrade({ side: 'SELL' }), baseOpts));
});

test('buildMirror records tradeSide from the trade', () => {
  const mBuy = lib.buildMirror(mkTrade({ side: 'BUY' }), 1, 1779399965);
  assert.strictEqual(mBuy.tradeSide, 'BUY');
  const mSell = lib.buildMirror(mkTrade({ side: 'SELL' }), 1, 1779399965);
  assert.strictEqual(mSell.tradeSide, 'SELL');
});

test('settleMirror SELL + outcome-wins is a loss for the seller', () => {
  // Master sold Up at $0.45; we paper-mirrored (1/0.45 shares short, $1 cash collected).
  // Up wins → seller owes paperShares * $1, keeps paperSize.
  // PnL = paperSize - paperShares = 1 - (1/0.45) ~= -1.2222
  const m = lib.buildMirror(mkTrade({ side: 'SELL', outcome: 'Up', price: 0.45 }), 1, 1779399965);
  const exit = lib.settleMirror(m, 'Up', 1779400860);
  assert.strictEqual(exit.tradeSide, 'SELL');
  assert.strictEqual(exit.won, true); // outcome matched winner
  assert.ok(Math.abs(exit.pnl - (1 - 1/0.45)) < 1e-9, `pnl=${exit.pnl}`);
  assert.ok(exit.pnl < 0, 'SELL + outcome wins must be a loss');
});

test('settleMirror SELL + outcome-loses is a win for the seller', () => {
  // Master sold Up at $0.45; Down wins -> Up token worthless, seller keeps paperSize.
  const m = lib.buildMirror(mkTrade({ side: 'SELL', outcome: 'Up', price: 0.45 }), 1, 1779399965);
  const exit = lib.settleMirror(m, 'Down', 1779400860);
  assert.strictEqual(exit.won, false);
  assert.strictEqual(exit.pnl, 1);
});

test('settleMirror missing tradeSide defaults to BUY math (back-compat)', () => {
  // Legacy mirror records (pre-2026-05-23) lack tradeSide; they must settle as BUYs.
  const m = lib.buildMirror(mkTrade({ outcome: 'Up', price: 0.45 }), 1, 1779399965);
  delete m.tradeSide;
  const exit = lib.settleMirror(m, 'Up', 1779400860);
  assert.strictEqual(exit.tradeSide, 'BUY');
  assert.ok(Math.abs(exit.pnl - (1/0.45 - 1)) < 1e-9);
});

test('selectNewTrades filters across multiple masters by per-master lastSeen', () => {
  const trades = [
    mkTrade({ proxyWallet: '0xaaa', timestamp: 1000 }),
    mkTrade({ proxyWallet: '0xaaa', timestamp: 2000 }),
    mkTrade({ proxyWallet: '0xbbb', timestamp: 1500 }),
  ];
  const news = lib.selectNewTrades(trades, {
    slugPrefixes: ['btc-updown-15m-'],
    lastSeenByMaster: { '0xaaa': 1500, '0xbbb': 0 },
  });
  assert.strictEqual(news.length, 2);
  assert.deepStrictEqual(news.map((t) => t.proxyWallet + '@' + t.timestamp).sort(),
    ['0xaaa@2000', '0xbbb@1500']);
});

test('isFresh accepts current slot', () => {
  // slot opens at 1779399900, resolves at 1779400800
  const t = mkTrade({ slug: 'btc-updown-15m-1779399900', timestamp: 1779399960 });
  assert.ok(lib.isFresh(t, 1779400000, 7200), 'mid-slot is fresh');
});

test('isFresh accepts slot just past resolution within maxLag', () => {
  const t = mkTrade({ slug: 'btc-updown-15m-1779399900' });
  assert.ok(lib.isFresh(t, 1779400800 + 3600, 7200), 'within 2h lag');
});

test('isFresh rejects slot resolved long ago beyond maxLag', () => {
  const t = mkTrade({ slug: 'btc-updown-15m-1779399900' });
  assert.ok(!lib.isFresh(t, 1779400800 + 7300, 7200), 'beyond 2h lag');
});

test('isFresh rejects malformed slug', () => {
  const t = mkTrade({ slug: 'bad-slug' });
  assert.ok(!lib.isFresh(t, 1779400000, 7200));
});

test('advanceLastSeen sets to max ts per master', () => {
  const seen = { '0xaaa': 500 };
  const news = [
    mkTrade({ proxyWallet: '0xaaa', timestamp: 1000 }),
    mkTrade({ proxyWallet: '0xaaa', timestamp: 2000 }),
    mkTrade({ proxyWallet: '0xbbb', timestamp: 1500 }),
  ];
  lib.advanceLastSeen(seen, news);
  assert.strictEqual(seen['0xaaa'], 2000);
  assert.strictEqual(seen['0xbbb'], 1500);
});

console.log('\n== pollOnce integration (dependency-injected) ==');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-test-'));
process.env.STRATEGY_DATA_DIR = tmpDir;
process.env.MASTER_ADDRESSES = '0xce25e214d5cfe4f459cf67f08df581885aae7fdc';
process.env.MIRROR_SIZE_USD = '1';
process.env.SLUG_PREFIXES = 'btc-updown-15m-';

delete require.cache[require.resolve('./main')];
const main = require('./main');

(async () => {
  await test('pollOnce mirrors a fresh master trade and persists state', async () => {
    const state = { lastSeenByMaster: {}, positions: {} };
    const t = mkTrade({ price: 0.40, outcome: 'Up', timestamp: 1779399960, transactionHash: '0xT1' });
    const r = await main.pollOnce(state, {
      fetchTrades: async () => [t],
      fetchWinner: async () => null,
      now: () => 1779399965,
    });
    assert.strictEqual(r.newMirrors, 1);
    assert.strictEqual(r.settled, 0);
    assert.strictEqual(Object.keys(state.positions).length, 1);
    assert.strictEqual(state.lastSeenByMaster['0xce25e214d5cfe4f459cf67f08df581885aae7fdc'], 1779399960);

    const ledgerPath = path.join(tmpDir, 'strategy-ledger.jsonl');
    const lines = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.strictEqual(rec.kind, 'mirror');
    assert.strictEqual(rec.outcome, 'Up');
    assert.strictEqual(rec.masterPrice, 0.40);
  });

  await test('pollOnce idempotent: re-running on same trade does not double-mirror', async () => {
    const state = main.loadState();
    const t = mkTrade({ price: 0.40, outcome: 'Up', timestamp: 1779399960, transactionHash: '0xT1' });
    const r = await main.pollOnce(state, {
      fetchTrades: async () => [t],
      fetchWinner: async () => null,
      now: () => 1779399965,
    });
    assert.strictEqual(r.newMirrors, 0, 'should not re-mirror the same trade');
  });

  await test('pollOnce settles a ripe position via fetched winner (WIN)', async () => {
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-test2-'));
    process.env.STRATEGY_DATA_DIR = tmpDir2;
    delete require.cache[require.resolve('./main')];
    const m2 = require('./main');
    const state = { lastSeenByMaster: {}, positions: {} };
    const t = mkTrade({ price: 0.30, outcome: 'Up', timestamp: 1779399960, transactionHash: '0xT2' });
    await m2.pollOnce(state, {
      fetchTrades: async () => [t],
      fetchWinner: async () => null,
      now: () => 1779399965,
    });
    const r = await m2.pollOnce(state, {
      fetchTrades: async () => [],
      fetchWinner: async () => 'Up',
      now: () => 1779400900,
    });
    assert.strictEqual(r.settled, 1);
    const pos = Object.values(state.positions)[0];
    assert.strictEqual(pos.settled, true);
    assert.strictEqual(pos.actualWinner, 'Up');
    assert.ok(Math.abs(pos.realizedPnl - (1/0.30 - 1)) < 1e-9);
  });

  await test('pollOnce drops stale historical trades (resolved long ago)', async () => {
    const tmpDirStale = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-test-stale-'));
    process.env.STRATEGY_DATA_DIR = tmpDirStale;
    delete require.cache[require.resolve('./main')];
    const ms = require('./main');
    const state = { lastSeenByMaster: {}, positions: {} };
    // Slot from 2 months ago, would have resolved at 1774704600 (March 28)
    const oldTrade = mkTrade({
      slug: 'btc-updown-15m-1774703700',
      timestamp: 1774704187,
      transactionHash: '0xOLD',
    });
    const r = await ms.pollOnce(state, {
      fetchTrades: async () => [oldTrade],
      fetchWinner: async () => null,
      now: () => 1779399965, // 2026-05-21, way past March
    });
    assert.strictEqual(r.newMirrors, 0, 'should drop stale historical trade');
    assert.strictEqual(Object.keys(state.positions).length, 0);
  });

  await test('pollOnce LOSS settlement: bought Up, Down wins', async () => {
    const tmpDir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-test3-'));
    process.env.STRATEGY_DATA_DIR = tmpDir3;
    delete require.cache[require.resolve('./main')];
    const m3 = require('./main');
    const state = { lastSeenByMaster: {}, positions: {} };
    const t = mkTrade({ price: 0.40, outcome: 'Up', timestamp: 1779399960, transactionHash: '0xT3' });
    await m3.pollOnce(state, {
      fetchTrades: async () => [t],
      fetchWinner: async () => null,
      now: () => 1779399965,
    });
    const r = await m3.pollOnce(state, {
      fetchTrades: async () => [],
      fetchWinner: async () => 'Down',
      now: () => 1779400900,
    });
    assert.strictEqual(r.settled, 1);
    const pos = Object.values(state.positions)[0];
    assert.strictEqual(pos.actualWinner, 'Down');
    assert.strictEqual(pos.realizedPnl, -1);
  });

  await test('pollOnce in SELL mode mirrors SELL trades and ignores BUY trades', async () => {
    const tmpDirSell = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-test-sell-'));
    process.env.STRATEGY_DATA_DIR = tmpDirSell;
    process.env.MIRROR_SIDES = 'SELL';
    delete require.cache[require.resolve('./main')];
    const mSell = require('./main');
    const state = { lastSeenByMaster: {}, positions: {} };
    const buyTrade = mkTrade({
      side: 'BUY', price: 0.40, transactionHash: '0xBUY', timestamp: 1779399960,
    });
    const sellTrade = mkTrade({
      side: 'SELL', price: 0.55, transactionHash: '0xSELL', timestamp: 1779399970,
    });
    const r = await mSell.pollOnce(state, {
      fetchTrades: async () => [buyTrade, sellTrade],
      fetchWinner: async () => null,
      now: () => 1779399975,
    });
    assert.strictEqual(r.newMirrors, 1, 'only SELL should mirror');
    const pos = Object.values(state.positions)[0];
    assert.strictEqual(pos.tradeSide, 'SELL');
    assert.strictEqual(pos.masterPrice, 0.55);
    // Restore default so subsequent test runs are not contaminated.
    delete process.env.MIRROR_SIDES;
  });

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} - ${failed} failure(s)`);
  process.exit(failed === 0 ? 0 : 1);
})();
