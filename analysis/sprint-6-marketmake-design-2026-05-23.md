# Sprint 6 — Market-Maker Paper Bot (Design)

**Date:** 2026-05-23
**Status:** scoped down on review — SELL-side mirror shipped first (Sprint 6.1); full bid-ladder MM deferred to Sprint 7.
**Prereqs:** Phase 3 directional bots (D/G/H) deployed and evaluated; mastercopy paper backfilled (2026-05-22)

---

## 0. Update (2026-05-23, post-review) — what actually shipped

The original section 2 math below describes a **two-sided maker quoting at $0.49 / $0.53 and holding to settlement**. On second pass, that model is mathematically equivalent to what the BUY-side mastercopy already paper-tested: mirroring cE25's BUYs (at avg fill $0.49) and holding to settlement gave **−2.57% ROI over 3,897 trades**. The "+2% spread capture" intuition in section 2 only works for an MM who **cycles inventory** (cancels and resells before settlement) — not one who holds. A naive bid-ladder + hold-to-settlement implementation would re-discover the same −2.57% loss with more code.

Cheaper higher-signal experiment shipped instead (commit `730b13b`): **paper-mirror cE25's SELLs**. If cE25's overall PnL is positive (per leaderboard) but their BUY flow alone loses −2.57%, then their SELL flow must earn meaningfully more than +2.57% to net out positive. Mirroring SELLs directly tests this — same architecture as `scripts/mastercopy/`, same masters, opposite side filter via a new `MIRROR_SIDES=SELL` env var.

What this validates / invalidates:
- **+3% to +5% net realized on SELL-side mirror over 24-48h** → "the masters profit from SELL flow" hypothesis confirmed. Justifies Sprint 7 (full two-sided MM with inventory cycling) as the right next step.
- **~0% to −3% net** → SELL flow alone isn't the answer either; the masters' profit must come from inventory cycling, not from holding either side. Sprint 7 still warranted but with skepticism.
- **Worse than −5%** → leaderboard PnL data is unreliable, or there's a different mechanic we haven't identified. Pause and re-investigate before building anything.

The architecture sections below (3–8) describe the **deferred** full bid-ladder MM. Keep for reference when Sprint 7 lands — the counterfactual fill simulator and queue-priority calibration concerns still apply once we add inventory cycling on top.

---

## 1. Why now — the empirical case

Today's mastercopy backfill produced the first realized PnL data on Polymarket 15m BTC markets across a full month of mirrored MM behavior:

| Master (laddering MM) | Settled trades | Win rate | Realized ROI |
|---|---|---|---|
| 0xcE25 | 2,447 | 49.0% | **−2.59%** |
| 0xb55fa | 1,450 | 52.3% | **−2.53%** |
| Combined | 3,897 | 50.2% | **−2.57%** |

The directional paper bots (D / G / H) have settled into the same band:

| Variant | Settled | Win rate | Realized ROI |
|---|---|---|---|
| D BTC 15m | 31 | 83.9% | −2.34% (RETIRED 2026-05-23) |
| G BTC 5m | 69 | 75.4% | −7.00% (RETIRED 2026-05-22) |
| H ETH 15m | 13 | 84.6% | −4.15% (still running, n too small) |

**The market is internally consistent at ≈ −2 to −2.5% ROI for any side that takes liquidity.** Whether you mirror an MM (paper TAKE of their fills) or run your own directional signal (TAKE the favorite ask), the spread tax dominates.

**Corollary (the testable hypothesis for this sprint):** the wallets that ARE the MMs must be earning the corresponding **+2 to +2.5% ROI** that takers lose, minus their inventory risk. If true, becoming an MM is the only sustainable strategy. Sprint 6 paper-tests this without capital risk.

---

## 2. Hypothesis with explicit math

The MM model on a Polymarket binary:

1. MM has $1 collateral. Mints two outcome tokens (1 Up + 1 Down).
2. Posts a resting SELL of 1 Up at $0.49 (cE25's observed avg), resting SELL of 1 Down at $0.53 (b55fa's observed avg).
3. Both fill: collects $0.49 + $0.53 = **$1.02** cash.
4. At resolution, the winning outcome token pays $1.00 to whoever holds it. The MM delivered both, so they pay out $1.00.
5. **Net per round-trip-pair: +$0.02 = +2% per $1 of capital cycled.**

This is the exact mirror of the taker's −2%. The 0.5pp slippage between empirical taker (−2.57%) and theoretical MM (+2%) gives a ~4pp gross spread that the MM must share with adverse selection (informed flow), inventory imbalance (only one side fills), and gas/fees.

**Empirical question Sprint 6 answers:** when WE quote at the same prices cE25 quotes at, do we capture +1.5% to +2% ROI net of adverse selection? Or does adverse selection kill the spread entirely for new entrants without the masters' queue priority?

---

## 3. Simulation methodology

We **cannot** place real maker orders without signer access + capital. Sprint 6 is a **counterfactual paper-fill simulator**: at each slot, hypothesize where we'd have placed our maker orders, then replay the public trade tape to determine which of our orders would have been hit.

### Quote ladder generator

For each new `btc-updown-15m-<openTs>` slot, at minute 0 of the slot, generate a hypothetical maker quote ladder. Initial version (matching cE25's observed pattern):

```
Up side (selling Up tokens):    quotes at 0.45, 0.40, 0.30, 0.20, 0.10
Down side (selling Down tokens): quotes at 0.55, 0.40, 0.30, 0.20, 0.10
```

(Side asymmetry comes from cE25's empirical avg fills: Up=$0.49, Down=$0.53. We can also start symmetric and tune later.)

Quote size: 1 share per ladder rung (matches MC's $1 paper notional for direct comparability).

### Counterfactual fill detection

For each slot, fetch the trade tape via data-api `?market=<conditionId>&limit=500`. Each trade has `side`, `outcome`, `price`. Our hypothetical orders fill when:

- **Our Up quote at price P** (we sell Up to a taker who BUYs Up): filled iff there exists a tape entry `side=BUY, outcome=Up, price ≥ P` between slot open and resolve (a taker paid ≥ our ask, so we'd have been crossed).
- **Our Down quote at price P**: filled iff `side=BUY, outcome=Down, price ≥ P` exists in the slot window.

Assumes we are FIRST in queue at our price, which is an upper-bound assumption (real fill rates will be lower because cE25's existing orders may eat the flow first).

### Settlement

After `resolveTs + 60s`, call gamma with `&closed=true` (per `polymarket-gamma-closed-filter` memory) to get the winning outcome. For each of our hypothetical fills:
- If we sold the WINNING side at price P: PnL = P − $1.00 (negative).
- If we sold the LOSING side at price P: PnL = +P (positive).

Append exit record.

### Per-slot expected PnL

For a perfectly-balanced slot (one Up fill at $0.49, one Down fill at $0.53):
- Up wins (50% prob): PnL = (0.49 − 1.00) + 0.53 = **+$0.02**
- Down wins (50% prob): PnL = 0.49 + (0.53 − 1.00) = **+$0.02**

Deterministic +$0.02 per matched pair. Variance comes from imbalanced fills (only one side hit).

---

## 4. Architecture

Mirrors `scripts/mastercopy/` layout for consistency:

```
scripts/marketmake/
  lib.js                — pure helpers: generateLadder, matchTradeToLadder,
                          settleFill, isFresh. Stateless, fully testable.
  main.js               — daemon: poll new slots, queue ladders, replay tape,
                          settle. Read-only HTTP, paper-only.
  test_marketmake.js    — unit tests on lib.js (target >= 25 assertions).
  data-mm/              — strategy-ledger.jsonl + strategy-state.json

deploy/polybot-marketmake.service  — systemd unit; STRATEGY_DATA_DIR=data-mm
```

### Ledger record shapes

```
{kind: "quote",   ts, slug, openTs, resolveTs, side, price, size}
{kind: "fill",    ts, slug, side, price, size, takerProxyWallet, takerTxHash}
{kind: "exit",    ts, slug, winner, fills: [{side, price, pnl}], totalPnl}
{kind: "skip",    ts, slug, reason: "slot_pruned"|"no_conditionId"|"no_trades"}
```

`side` is Polymarket's outcome label (`Up` or `Down`), `price` is the maker price we hypothesized, `pnl` is settlement-payout − price.

### State

```json
{
  "lastSeenSlot": <openTs>,
  "openQuotes": {
    "<slug>": {
      "openTs": ..., "resolveTs": ...,
      "ladder": [{"side": "Up", "price": 0.45}, ...],
      "fills": [{"side": "Up", "price": 0.45, "ts": ..., "takerProxyWallet": "..."}]
    }
  }
}
```

When `resolveTs + 60 < now`, settle + delete from `openQuotes`, append exit to ledger.

---

## 5. Service config (`polybot-marketmake.service`)

```ini
Environment=STRATEGY_DATA_DIR=/opt/polybot/polymarket-cli/scripts/marketmake/data-mm
Environment=SLUG_PREFIXES=btc-updown-15m-
Environment=POLL_INTERVAL_SEC=30
Environment=MAX_LAG_SEC=7200
Environment=LADDER_UP=0.45,0.40,0.30,0.20,0.10
Environment=LADDER_DOWN=0.55,0.40,0.30,0.20,0.10
Environment=QUOTE_SIZE=1
ExecStart=/usr/bin/node /opt/polybot/polymarket-cli/scripts/marketmake/main.js 168
```

Daemon discovers new slots, snapshots its ladder per slot, polls the trade tape every 30s, marks fills, settles at resolve+60s.

---

## 6. Kill criteria (per Phase 3 doc section 6, ratified here)

- **PnL >= +$10 after 100 settled slots** → strong positive signal; consider drafting a live-mode signer (Sprint 7+).
- **−$50 < PnL < +$10 after 200 settled slots** → spread approximately captured but adverse selection eats it; consider widening the ladder or reducing low-conviction rungs.
- **PnL < −$50 after 100 settled slots** → debug simulator first (likely fill-detection bug — paper shouldn't lose at MM if math is right). If sim is correct, abandon — adverse selection has wiped the +2% theoretical edge entirely.

---

## 7. Risks and unknowns

1. **Queue priority assumption is upper-bound.** Real MM fills are gated by queue position at the same price. We assume FIFO from the moment the slot opens — real cE25 may have orders resting from minutes before. Worst case: paper overstates fill rate. Mitigation (Sprint 6.5): only count a paper fill if our hypothetical price is **strictly below** the worst real maker at that level (we'd be the first new order at that price tier).
2. **Adverse selection is uncalibrated.** When informed flow (a trader with directional signal) hits us, we lose more than the spread on that fill. cE25 has been doing this profitably long enough to suggest they've calibrated their ladder against informed flow. Our copy may not survive that calibration.
3. **Slot pruning.** Gamma's `?slug=...&closed=true` works for recent (last 30d) slots but unknown for very old; the daemon's settle loop must handle `null` winner gracefully (skip).
4. **No cancel logic in v1.** Real MMs cancel-and-replace as price moves. Our paper bot quotes once at slot open and doesn't update. This penalizes us versus real MM by ~1-2 percentage points of effective spread.
5. **Coverage scope.** First version only `btc-updown-15m`, matching MC. ETH 15m could be added once the methodology is validated.

---

## 8. Implementation order (sub-sprints)

| # | Item | Effort | Output |
|---|---|---|---|
| 6.1 | Write `lib.js` (pure helpers) + `test_marketmake.js` | 2-3h | All helpers tested, lib.js exports stable |
| 6.2 | Write `main.js` daemon loop (slot enumeration, ladder placement, fill detection via trade-tape replay, settlement) | 3-4h | Runs locally against last 24h of slots, dumps preview ledger |
| 6.3 | Create `deploy/polybot-marketmake.service` + add to `redeploy.sh` discovery | 30min | Service file in repo |
| 6.4 | Deploy to Lightsail (manual cp first time per `lightsail-polybot-server` memory's redeploy-doesn't-sync-units gotcha) | 15min | Running on server |
| 6.5 | After 24h, pull ledger, compute realized PnL, compare to +2% theoretical | 30min | Empirical answer |

Realistic timeline: **half a day to first running version, 24h paper window, then decision**.

---

## 9. Open questions before implementing

1. **Should the ladder be static or derived from book?** Static = simpler, but doesn't adapt to actual market depth. Derived = quote one tick inside the best ask on each side. Recommend: start static (matches cE25's pattern), add derived as Sprint 6.5.
2. **What's the "first in queue" assumption worth?** Empirically we could measure: in a backfilled slot, what % of trades happened at prices where cE25/b55fa had a resting order? If their resting orders were always hit first, our paper will overstate fill rate by ~30%+. Worth a short calibration script before trusting MM paper PnL.
3. **Should MM also be ETH?** No — start scope-bounded, validate on BTC, then expand.
4. **Cancel-on-divergence?** When BTC moves >10bps after slot open, the resting maker quotes are stale and become adverse-selected. Real MM cancels. Paper bot v1 doesn't. Sprint 6.5 should add a "cancel at slot+5min if BTC drift > X bps" feature.

---

## TL;DR

We've now empirically confirmed that **taking** liquidity on Polymarket 15m loses 2-3% (mastercopy −2.57%, all directional strategies −2 to −7%). The only sustainable strategy is **making** liquidity. Sprint 6 builds a counterfactual paper-fill simulator to test whether the +2-2.5% spread theoretical edge survives adverse selection at our (no-queue-priority) entry point. Half a day to first run, 24h paper window, then go/no-go decision on a live MM signer.
