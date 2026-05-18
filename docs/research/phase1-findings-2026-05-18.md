# Phase 1 — Pattern Discovery Findings (2026-05-18)

## TL;DR

The three target 15m BTC traders (ohanism, cE25, b55fa) are running **the same simple strategy**: late-window trend persistence. We do not need to copy them — the strategy is replicable from scratch using only the Binance BTC price feed.

Backtested on 7,222 historical 15-min BTC windows (108k klines, March–May 2026):

| Observe at minute | Min move threshold | Trades | Accuracy |
|---|---|---|---|
| 14 (last min) | 10 bps | 3,490 | **99.26%** |
| 13 | 10 bps | 3,418 | 97.98% |
| 12 | 5 bps | 5,028 | 94.05% |
| 11 | 5 bps | 4,984 | 92.13% |
| 9 | 5 bps | 4,745 | 88.54% |
| 5 | 0 bps | 7,222 | 83.93% |

The opposite strategy (fade observed direction) achieves 25–35%. Trend persistence in the last minutes of a 15-min window is structural.

## Evidence

**Three masters, three samples, same pattern:**

| Master | btc15m positions | Directional accuracy | Avg buy price |
|---|---|---|---|
| ohanism | 1,954 | **85.3%** (Up:85.8% / Down:84.9%) | 0.682 / 0.671 |
| cE25 | 1,206 | **81.0%** (Up:81.9% / Down:80.1%) | 0.611 / 0.601 |
| b55fa | 1,196 | **83.4%** (Up:84.7% / Down:82.0%) | 0.629 / 0.616 |

Prior-window BTC return (last 60 min before market open) is *not* meaningfully correlated with their bet direction (Δ < 5 bps between Up and Down bets). They are not momentum traders on the broader trend.

Average buy prices of 0.60–0.68 confirm they enter **after BTC has already moved 30–40 bps in their bet direction** within the window. That positioning + 81–85% accuracy + hold-to-close = ~30–38% ROI per trade on capital deployed. Matches their reported leaderboard PnL.

When master bets Up: BTC closed +9 to +13 bps higher (avg). When master bets Down: BTC closed −9 to −12 bps. Real predictive correlation, not luck.

## The strategy

```
For each 15-min BTC binary market with open time t0:
  1. Wait until t0 + observe_minutes * 60   (e.g. 11 minutes in)
  2. Compute r = log(BTC_now / BTC_at_open)
  3. If |r| < threshold_bps / 10000: skip
  4. Else: BUY the side matching sign(r) at market
  5. Hold to t0 + 900
```

Tunables: `observe_minutes` (5–14), `threshold_bps` (0–10). Higher both → higher accuracy, fewer trades.

## Sizing for $10k

Backtest implies ~$0.25 expected value per share when buying at 0.65 with 90% accuracy. At $500 per market × ~48 15m BTC markets/day:

- Theoretical max ≈ 38% per trade × $500 × 48 = $9,120/day. Not realistic.
- After execution friction (worse mid fills, partial fills, competition compressing price toward true value): expect 30–50% of theoretical = **$1.5k–$4k/day on $10k bank**, with daily variance ±50%.

Recommended starting parameters: `observe_minutes=11, threshold_bps=5` (92% accuracy, 4,984 trades in test window).

## Caveats — read before deploying real funds

1. **Binance ≠ Chainlink.** Polymarket settles on Chainlink BTC/USD which updates only when price moves > threshold or every ~30s. Backtest used Binance spot. Most windows will agree but 1–3% of resolutions can diverge — adds drift risk.
2. **Liquidity unknown at entry.** We don't yet know whether $500 of taker buy at minute 11 is absorbable in the book. May need to size smaller or split orders.
3. **Competition will compress edge.** When we enter, our own buys move the price toward fair value. With $500 orders this is small but real.
4. **Same model the masters use.** If three independent traders found this, others will too. Edge persists for now but is not permanent.
5. **Survivorship in the 18–75 day sample.** BTC was generally calm in this period. Behavior in fast moves / black swans untested.

## Next steps (Phase 2)

1. **Build the strategy bot** at `src/strategy/` (separate from `src/bot/`):
   - Poll Polymarket gamma API for live 15m BTC market list
   - Poll Binance for BTC price every 1s
   - When market hits observe-minute and abs-return > threshold, place market buy
   - Hold to settlement
2. **Run paper mode for 1–2 weeks**, comparing realized accuracy to backtest 92%.
3. **If paper validates**, go live with $500 size, scale to $10k over 4 weeks based on observed slippage.
4. **Delete `src/bot/` and master-selection docs** once strategy bot is paper-validated.

## Files produced

- `scripts/research/pull_master_tape.js` — pulls trade tape (limit-3050 server cap).
- `scripts/research/pull_closed_positions.js` — pulls position-level history.
- `scripts/research/fetch_btc_klines.js` — fetches Binance 1m BTC klines.
- `scripts/research/data/positions_{ohanism,cE25,b55fa}.json` — 15,000 positions each.
- `scripts/research/data/btc_klines.json` — 108,358 1-min BTC OHLCV.
- `docs/research/phase1-findings-2026-05-18.md` — this file.
