# Bonereaper trader profile

Address queried: `0xeebde7a0e019a63e6b476eb425505b7b3e6eba30`
Pulled 2026-05-17 via local `polymarket.exe` CLI (data-api endpoints).

## 1. Identity and scope

- The address resolves directly. The CLI returns records where `proxy_wallet = 0xEEbde7A0E019A63E6b476eb425505b7b3e6EBA30`, `name = "Bonereaper"`, `pseudonym = "Popular-Insurrection"`. **No EOA-to-proxy translation needed — this address IS the proxy wallet used by Polymarket's data layer.**
- `data traded`: **36,359 unique markets** traded.
- `data value`: **$1,248** current portfolio value.
- `data trades --limit 3500`: returns a full 3,499 trades, all within a **6.6-hour window on 2026-05-17 (06:45 – 13:22 UTC)**. The data-api `trades` endpoint caps at ~3,500 rows (offsets ≥3500 return empty). The wallet is very active.

## 2. Market focus (last 3,499 trades, 6.6h)

| Bucket                          | Trades | %    |
|---------------------------------|--------|------|
| BTC 5-min up/down               | 1,565  | 44.7 |
| BTC 15-min up/down              | 1,515  | 43.3 |
| BTC longer-tf (hourly/daily/4h) | 391    | 11.2 |
| ETH 5-min up/down               | 28     | 0.8  |
| Everything else                 | 0      | 0.0  |

BTC short-window up/down is **~99% of activity**. The 5-minute target class is **44.7%** of fill rows but ~55% by market-count (5m markets cycle 3x faster than 15m). Sampling closed-positions across the lifetime 36k records shows the composition shifts toward ETH/SOL up/down in the deeper history.

## 3. Maker vs taker classification

**The data-api `/trades` and `/activity` records do NOT expose a maker/taker flag.** Fields returned: `asset, condition_id, event_slug, outcome, outcome_index, price, side (BUY/SELL), size, timestamp, transaction_hash, usdc_size, proxy_wallet, title`. No `maker`, no `taker`, no `order_type`, no `event_type` distinction.

**Proxy inference via price granularity:**

| Side | Round-price fills (≤2 dp) | Fractional/weighted-avg fills |
|------|---------------------------|-------------------------------|
| BUY  | 1,022 (65.3%)             | 543 (34.7%)                   |
| SELL | 0                          | 0                              |

Round prices like `0.55`, `0.71`, `0.75` strongly indicate **resting limit orders at tick boundaries** (he was the maker, someone else took). Fractional prices like `0.7564465517241379` are **single-order multi-fill weighted averages**, characteristic of a market/IOC order sweeping the book (he was the taker).

**Best estimate: ~65% maker / ~35% taker on BUYs. Medium confidence** — heuristic, not authoritative. Definitive classification would require the CLOB `/trade-history?market=...&user=...` endpoint which exposes a `maker_orders` array, or matching `transaction_hash` against the Polygon CTFExchange event logs and reading the `OrderFilled` `makerAssetId`. Neither is exposed by this CLI.

## 4. Sizing and cadence

Notional in USDC per fill (BTC 5-min subset, n=1,565):

| min  | p25   | p50   | p75   | p90   | p99    | max     |
|------|-------|-------|-------|-------|--------|---------|
| 0.10 | 12.19 | 17.60 | 29.80 | 59.04 | 433.50 | 3,290.22|

- Total notional in the 6.6-hour sample: **~$105k**, extrapolated ~$380k/day.
- Cadence: **528 fills/hr total, 236 fills/hr on BTC5m, ~12 BTC5m markets entered per hour** (one every ~5 min — i.e. one per window).
- Per BTC 5-min market: **avg 19.6 fills, p50 first-to-last-fill duration = 236 s, p75 = 264 s, p90 = 282 s** (he keeps scaling in nearly to the close).
- **He never exits early.** Across all 3,499 trades, **SELL count = 0**. Every position is BUY-only, held to resolution. He is a one-way scaler, not a flipper.

## 5. Timing within the 5-minute window

Entry seconds-into-window (window start = `btc-updown-5m-<unix>` timestamp). BUY only:

| Bucket                          | Fills | %    |
|---------------------------------|-------|------|
| pre-open (<0s)                  | 0     | 0    |
| 0–60s                           | 451   | 28.8 |
| 60–180s                         | 668   | 42.7 |
| 180–270s                        | 389   | 24.9 |
| 270–300s                        | 48    | 3.1  |
| post-resolve (>300s, late slug) | 9     | 0.6  |

Entry percentiles: p25=53s, p50=118s, p75=191s, p90=241s. He concentrates in the middle of the window (~min 2–3) when prices have moved off 0.50 and he can pick a side with directional context. Very little activity in the final 30 seconds.

## 6. Realized edge — IMPORTANT CAVEAT

`data closed-positions` is **strictly filtered to winning positions** and sorted DESC by `realized_pnl`. Sampled at 25 strategic offsets across 0–36,000 (n=625 records): 100% had positive PnL, lowest sampled bin still averaged **+$3.76** per market. Losing closed markets are simply **not returned**. This means:

- You can compute **gross winnings** but not net PnL or true win rate from this endpoint alone.
- Estimated gross lifetime winning PnL (Riemann sum over 36,359 records, 1,500-row bins): **~$13.4M USDC**, of which **~$10M from BTC 5-min markets specifically**.
- Top 5 single-market wins: $11.9k, $7.2k, $6.5k, $6.0k, $4.8k. Many on BTC5m, outcome=Up.
- Side bias on sampled wins: 307 Up / 318 Down (symmetric).
- Avg win in sample: **$357** per closed-winning market.

What we know about losses (from open positions, n=25):
- 19/25 currently underwater, cumulative open `cash_pnl = -$3,296` (just on the 25 most recent).
- 12/25 are already at `cur_price=0` (lost, awaiting redemption): summed loss = **-$3,118** on **$6,099 bought**, **-51% ROI** on losing tranche, with the biggest single loss being **-$2,765 on the `bitcoin-up-or-down-april-4-2026-10am-et` Down side**.
- The structural pattern: he loads up on the wrong side and the position goes to zero, but the winners are large enough to compensate. The CLI gives no way to enumerate the losing closes for an aggregate net figure.

**Net PnL: unknown sign, but probably positive given the heavy tail of wins.** The data we have is enough to confirm he is a meaningful trader, not enough to confirm net profitability over the long run.

## 7. Side bias

Per the 6.6-hour BTC 5-min sample: **Up BUYs = 845, Down BUYs = 720** (~54/46). Across the 625 sampled winning closes lifetime: **Up = 307, Down = 318**. Effectively symmetric — no structural Up/Down bias.

## 8. Replicability assessment

The dominant pattern is **directional accumulation late in a 5-minute window with no early exit**, paying a mix of resting (~65%) and aggressive (~35%) prices. This is **(b) directional alpha on the BTC move during the window**, not (a) spread capture (he holds to resolution, doesn't quote both sides) and not (c) near-resolution arbitrage (entries cluster around 60–240s, not 270–300s). The maker-share is high enough to suggest some price-improvement edge but he is not running a passive market-maker.

**Survivability at $500 capital, 1–5 s copy latency:**
- His median fill is $17 — entirely feasible at $500.
- p90 size = $59 and biggest fills are $300–$3,000+; copying those at fractional scale loses some of the heavy-tail upside that may be the actual edge.
- The 65% maker share **does not survive copy-trading**: by the time you observe his fill, his resting order is filled — copying produces a taker order chasing the same direction at worse prices, paying ~2–4¢ of additional slippage on every fill. That is likely larger than his realized edge per fill.
- A 1–5 s copy delay on a 300-second window is significant — he often enters at 60–120s and his information advantage may already be priced in by t+5s.

**Verdict:** Replicating Bonereaper at $500 with vanilla copy logic is a **negative-EV proposition**. Worth pursuing only if you can (i) post the same passive resting orders he posts (requires inferring his order placement *before* the fill, not after), or (ii) ride only his outsized aggressive entries (top decile by notional) and skip the small maker-style fills.

---

## Data-source labels (for ctx_search follow-up)

- `tmp_bone/trades_{0..3000}.json` — last ~3,500 fills
- `tmp_bone/closed_all.json`, `cp_{offset}.json` — closed-positions paginated (winners only)
- `tmp_bone/pos_full.json`, `op_{offset}.json` — open positions
- `tmp_bone/act_{0..3000}.json` — activity feed (identical schema to trades)
- Indexed sections include `value bonereaper`, `traded count`, `positions head`, `first 5 trades (2)`, `first 5 activity (2)`, `first 3 closed`.
