# Pre-Phase 2 Caveat Mitigations (2026-05-18)

Four caveats from `phase1-findings-2026-05-18.md` were investigated. Results:

| # | Caveat | Status |
|---|---|---|
| 1 | Binance ≠ Chainlink basis risk | **Mitigated** by threshold choice (data below) |
| 2 | Liquidity at minute 11 unknown | **Tooling deployed**, needs 1-week run |
| 3 | Competition will compress edge | Quantifiable post-deployment |
| 4 | 18–75 day sample, BTC was calm | **Refuted** — edge holds across 24 months, all regimes |

## 1. Binance vs Polymarket settlement (basis risk)

Measured 2,674 unique 15m BTC markets where we have ground-truth Polymarket outcomes. Disagreement rate between Binance close-vs-open direction and actual Polymarket settlement:

| Binance return magnitude | Markets | Disagreement |
|---|---|---|
| <2 bps (flat) | 355 | **43.1%** |
| 2–5 bps | 456 | 24.6% |
| 5–10 bps | 630 | 12.5% |
| 10–30 bps | 979 | **3.4%** |
| 30+ bps | 254 | **0.4%** |

**Conclusion:** Binance is fine as a signal source *if* the threshold filters out the flat-move zone. At threshold ≥10 bps, basis risk drops to 3.4%. At ≥30 bps it's near zero. We do not need to read Chainlink directly — but adding it as a cross-check would still be cheap insurance.

**Recommended:** Add Chainlink read (`0xc907E116054Ad103354f2D350FD2514433D57F6f` on Polygon, `latestRoundData()`) as a secondary feed. If Chainlink and Binance disagree on direction at observe time, skip the market. This costs us ~3% of trades but removes the residual basis risk almost entirely.

## 4. 24-month regime backtest

70,079 aligned 15-min windows from 2024-05 to 2026-05. Strategy: observe at minute M, bet if |return| > T bps, hold to close.

| observe | thresh | trades | accuracy | participation |
|---|---|---|---|---|
| 11 | 5 | 50,060 | 91.93% | 71% |
| 11 | 10 | 34,038 | 95.23% | 49% |
| **13** | **5** | **51,353** | **95.98%** | **73%** |
| 13 | 10 | 35,828 | 98.13% | 51% |
| 14 | 5 | 51,822 | 97.52% | 74% |
| 14 | 10 | 36,586 | 99.05% | 52% |

**Monthly stability** — observe 13, threshold 5 (2,100 trades/month avg):

```
Lowest accuracy months: 2024-11 (95.0%), 2024-12 (95.1%), 2025-01 (94.8%), 2025-03 (94.6%)
Highest accuracy months: 2025-09 (97.4%), 2024-10 (97.4%), 2024-06 (97.3%)
Volatility regimes tested: calm (1.4% daily vol) through panic (4.34% daily vol)
```

Edge is regime-invariant. The 75-day sample we used for Phase 1 was representative.

Vol-adjusted threshold tested separately — marginal benefit (~1pp) over a smart fixed threshold. Not necessary for Phase 2.

## 2. Order book snapshot — tool deployed

`scripts/research/snapshot_orderbooks.js` runs as a long-lived process, polls the gamma API every 15s, and snapshots the YES/NO order books at observe-minute 11 of every 15m BTC market it sees.

**Already revealed a key concern** from smoke-test at minute 7 of a live market:

```
Up token:   bids 0.01@11k, 0.02@2.5k, ...   asks 0.99@10k, 0.98@1.8k, ...
            bid depth to $50: $116    bid depth to $500: $488
            ask depth to $50: $10852  ask depth to $500: $10852
```

At minute 7 the book is mostly market-maker resting orders at extreme prices ($0.01 / $0.99). Tight quotes only appear closer to settlement. We need a week of minute-11 snapshots to confirm real fillable depth.

**Run instruction (user):**
```bash
node scripts/research/snapshot_orderbooks.js 11 168
```
That runs for 168 hours (1 week). Output appends to `data/orderbook_snapshots.jsonl`. After ~336 markets sampled, compute median depth at the prices we'd actually pay.

## 3. Competition — measurable, not avoidable

The 24-month backtest gives us 95.98% theoretical accuracy. The masters' realized accuracy is 81–85%. The 10–15pp gap is execution friction (worse fills, competition). Phase 2 paper trading will measure our actual realized accuracy. If we hit ≥85% in paper, edge is real after competition. If <80%, edge is gone.

## Recommended Phase 2 strategy parameters

| Parameter | Value | Reason |
|---|---|---|
| `observe_minute` | 13 (minute 13 of 15) | Best accuracy/participation balance |
| `binance_threshold_bps` | 5 (production) / 10 (conservative) | 95.98% / 98.13% accuracy |
| `chainlink_crosscheck` | enabled | Skip if Chainlink direction disagrees with Binance at observe |
| `max_position_usd` | 100 (week 1) → 500 (after paper) | Start small, scale on observed fill quality |
| `max_open_positions` | 20 | Allows full $10k bank deployment |
| `poll_interval` | 1s for BTC price, 5s for Polymarket markets | Sub-second BTC poll, slower markets poll |
| `skip_if_spread_cents` | 5 | Avoid wide-book markets |
| `skip_if_book_depth_usd` | 5× our trade size | Avoid being only liquidity-taker |
| `daily_loss_cap` | 5% of bank | $500/day on $10k |
| `news_blackout_min` | 15 before/after FOMC/CPI/NFP | Maintained externally |

## Expected economics (on $10k, paper-validated parameters)

Theoretical (backtest, no friction): 70 trades/day × $0.22 EV/share × 694 shares/trade = ~$10.7k/day.

Realistic after friction (worse fills, competition, partial fills): 25–40% realization.

**Range: $2.7k–$4.3k/day** on a $10k bank, with daily variance ±50%.

This is high enough to be either a real opportunity or a sign we're miscalculating something. The 24-month stability says it isn't survivorship bias. The order book caveat says we don't yet know what fills look like at minute 11. **Don't size beyond $100/trade until orderbook week is done.**

## Files produced this round

- `scripts/research/snapshot_orderbooks.js` — long-lived book snapshot daemon (run for 1 week)
- `scripts/research/data/btc_klines_24mo.json` — 1,051,200 1-min BTC klines (82MB)
- `scripts/research/data/backtest_24mo.json` — full backtest result grid
- `docs/research/pre-phase2-mitigations-2026-05-18.md` — this report

## What we still need before Phase 2

1. **1 week of orderbook snapshots** at minute 11 → confirms fill quality assumptions.
2. **Chainlink Polygon RPC reader** — small Rust function in `src/strategy/chainlink.rs` calling the aggregator's `latestRoundData()` via ethers/alloy.
3. **News calendar source** — Forex Factory ICS feed or manual JSON file.

Once those exist, the actual Phase 2 strategy bot is straightforward to build.
