# Polymarket 5-Minute BTC Up/Down — Market Structure Research

Data collected 2026-05-17 ~13:30 UTC via the local `polymarket` CLI against the production Gamma + CLOB APIs (read-only).

---

## 1. Market cadence

A new `btc-updown-5m-<unix_ts>` market is created **every 5 minutes**, where `<unix_ts>` is the **open time in epoch seconds**, always aligned to an exact UTC 5-minute boundary (`ts % 300 == 0`). End-time = open + 300s. Markets are deployed and start `acceptingOrders` roughly **24 hours before** the window opens (see `acceptingOrdersTimestamp` deltas of ~24h vs the slug timestamp). After the 5-minute window closes, the market resolves automatically.

Sample of most recent / upcoming markets (slug timestamp = window open, all closed/resolved unless noted):

| slug | open (UTC) | resolve (UTC) | conditionId (short) |
|---|---|---|---|
| btc-updown-5m-1779110100 | 2026-05-18 13:15 | 13:20 | 0xb1d9…2496 (upcoming) |
| btc-updown-5m-1779109800 | 2026-05-18 13:10 | 13:15 | 0xaaf0…f4c2 (upcoming) |
| btc-updown-5m-1779109500 | 2026-05-18 13:05 | 13:10 | 0x7589…1cf5 (upcoming) |
| btc-updown-5m-1779009600 | 2026-05-17 09:20 | 09:25 | 0xf590…e521 |
| btc-updown-5m-1778961000 | 2026-05-16 19:50 | 19:55 | 0x7124…4296 |
| btc-updown-5m-1778951700 | 2026-05-16 17:15 | 17:20 | — |
| btc-updown-5m-1778941500 | 2026-05-16 14:25 | 14:30 | — |
| btc-updown-5m-1776907500 | 2026-04-23 01:25 | 01:30 | — |
| btc-updown-5m-1775932500 | 2026-04-11 18:35 | 18:40 | — |
| btc-updown-5m-1775529600 | 2026-04-07 02:40 | 02:45 | — |
| btc-updown-5m-1775181000 | 2026-04-03 01:50 | 01:55 | 0x2978…9c23 |
| btc-updown-5m-1773976200 | 2026-03-20 03:10 | 03:15 | 0xf7ea…7b92 |
| btc-updown-5m-1773184800 | 2026-03-10 23:20 | 23:25 | — |
| btc-updown-5m-1772860200 | 2026-03-07 05:10 | 05:15 | — |
| btc-updown-5m-1772731800 | 2026-03-05 17:30 | 17:35 | — |

Gaps observed between consecutive upcoming markets visible in the API: **exactly 300 s** each. All `<ts> mod 300 == 0`. The Gamma `markets list` API only returns markets currently within its live page (active=true, closed=false); beyond the immediate ~24h horizon, only markets already deployed are visible. New 5-min markets are minted on a rolling 24h schedule.

---

## 2. Resolution mechanic

Every market's description and `resolutionSource` field are identical across the BTC 5m series:

> "This market will resolve to **Up** if the Bitcoin price at the end of the time range specified in the title is greater than or equal to the price at the beginning of that range. Otherwise it will resolve to **Down**."
> Source: `https://data.chain.link/streams/btc-usd` (Chainlink BTC/USD on-chain data stream).

Key implications:
- **Tie / exact-equal resolves UP** (≥ open price). No tolerance band — strict ≥ comparison.
- Pricing source is **Chainlink Data Streams**, *not* Binance / Coinbase / Pyth or any single spot venue. Chainlink aggregates multiple sources and updates on a distinct cadence — you cannot simply mirror a single exchange to predict resolution.
- Resolution timestamp is the +300s mark of the slug timestamp. Window is `[open, open+300s]`. UP if `BTC/USD(close) ≥ BTC/USD(open)` on the Chainlink stream.

---

## 3. CLOB parameters (sample of 7 markets)

All values pulled via `clob market <CID>`:

| slug | tick | min order | maker_fee | taker_fee | neg_risk | rewards.min_size | rewards.max_spread (¢) | clobRewards |
|---|---|---|---|---|---|---|---|---|
| btc-updown-5m-1779110100 (May 18) | 0.01 | 5 | 1000 | 1000 | false | 50 | 4.5 | null |
| btc-updown-5m-1779109800 (May 18) | 0.01 | 5 | 1000 | 1000 | false | 50 | 4.5 | null |
| btc-updown-5m-1779109500 (May 18) | 0.01 | 5 | 1000 | 1000 | false | 50 | 4.5 | null |
| btc-updown-5m-1779009600 (May 17) | 0.01 | 5 | 1000 | 1000 | false | 50 | 4.5 | null |
| btc-updown-5m-1778961000 (May 16) | **0.001** | 5 | 1000 | 1000 | false | 50 | 4.5 | null |
| btc-updown-5m-1775181000 (Apr 3) | **0.001** | 5 | 1000 | 1000 | false | 50 | 4.5 | null |
| btc-updown-5m-1773976200 (Mar 20) | **0.001** | 5 | 1000 | 1000 | false | 50 | 4.5 | null |

Observations:
- **Tick size changed mid-May 2026** from 0.001 (1/10¢) to **0.01 (1¢)**. All May-17 and later markets use 0.01.
- **Min order size = 5 shares**. The reward-eligible min size in the template is 50 shares (but no live rewards — see §5).
- **`neg_risk = false`** on every BTC 5m market (plain binary CLOB market, not shared-collateral).
- `clob fee-rate` returns `base_fee_bps: 1000`; `maker_base_fee` and `taker_base_fee` are both `"1000"`. Polymarket charges **0 actual fees** on these markets in production — the `1000` values are template caps stored at deployment, not the live charged rate. `makerRebatesFeeShareBps: 10000` (= 100% rebate of the maker fee to the maker) confirms fees net to zero.
- **`clobRewards: null`** on every BTC 5m market — these markets are **not enrolled** in an LP reward program at the time of writing, despite the template carrying default `rewardsMinSize / rewardsMaxSpread` placeholders.

---

## 4. Liquidity & spread profile

### Live order book — `btc-updown-5m-1779109800` (opens 2026-05-18 13:10 UTC, ~23.5h ahead)

`clob book` for UP token (`0x1158…ed0e`):

| side | price | size (shares) |
|---|---|---|
| ask +5 | 0.56 | 235 |
| ask +4 | 0.54 | 10 |
| ask +3 | 0.53 | 100 |
| ask +2 | 0.52 | 20 |
| **best ask** | **0.51** | **273.98** |
| **best bid** | **0.50** | **195.22** |
| bid −2 | 0.49 | 78.02 |
| bid −3 | 0.48 | 45 |
| bid −4 | 0.47 | 100 |
| bid −5 | 0.46 | 10 |

- Spread = **1¢ (1 tick)**. Mid = 0.505.
- Depth within ±2¢ of mid: ~273 shares bid, ~294 shares ask → only **~$138 / $148 in USDC notional** at the inside. Books are thin — a $500 marketable order will walk 4–5 levels.
- Total visible book is ~50k shares per side, but most of that sits 3¢+ from mid.

### Intra-window price trajectory — resolved market `btc-updown-5m-1779009600` (May 17 09:20–09:25 UTC)

Using `clob price-history --interval 1d --fidelity 1` on the UP token (history records ~60 s spacing):

| t offset | timestamp (UTC) | UP price |
|---|---|---|
| pre-window (~5 m before) | 09:15 | 0.485 |
| t ≈ 0 s | 09:20:05 | 0.715 |
| t ≈ 60 s | 09:21:07 | 0.635 |
| t ≈ 180 s | 09:23:05 | 0.615 |
| t ≈ 270 s | 09:24:05 | 0.685 |
| post-resolve | 09:26:05 | 0.005 (resolved DOWN) |

UP jumped from 0.485 → 0.715 at the open boundary as BTC ticked up, then oscillated 0.61–0.70 through the window. The market resolved **DOWN** — final Chainlink print at +300 s was below open, so UP wiped to 0.005. Public `price-history` fidelity is ~1 point / 60 s — there is no finer historical book/L2 data exposed by the CLI. Live book snapshots are real-time only.

`data open-interest` on this market: **$1,493.68 USDC** — small. Top holders showed two wallets each holding 1–13k UP shares: retail-size books.

---

## 5. Maker rewards eligibility

- `clobRewards: null` on every sampled BTC 5m market.
- `clob current-rewards` and `clob market-reward <CID>` require authentication and could not be enumerated. However, the Gamma `clobRewards` field is the definitive signal — when present (e.g., on 15m / 1h / daily BTC markets), it contains `rewardsDailyRate`, `assetAddress`, and start/end dates. For **5m BTC markets that field is null**, meaning **no daily payout is being distributed**.
- The template values `rewards.min_size = 50`, `rewards.max_spread = 4.5` are present in the CLOB market metadata but with empty `rates: []` — no active distribution.
- **Conclusion:** a maker bot earns **zero rebates** on 5m BTC and must rely purely on captured spread to offset adverse selection.

---

## 6. Fee structure

- `clob fee-rate <token>` → `base_fee_bps: 1000`.
- `clob market <cid>` → `maker_base_fee: "1000"`, `taker_base_fee: "1000"`.
- `makerRebatesFeeShareBps: 10000` (100% of maker fee returned to maker).
- Effective trading fee: **0 bps** for both sides on these markets in production — the stored values are template caps applied at deployment, not the live charged rate.
- No volume tiers, no separate maker rebate $ amount, no taker discount tiers are exposed by the API.
- `seconds_delay = 0` — orders are not artificially delayed.

For modelling, assume **0 bps** but pad with a 10 bps safety buffer per side until trade-level fee receipts confirm.

---

## 7. Operational constraints relevant to a bot

| Constraint | Value |
|---|---|
| Min order size (shares) | 5 |
| Min order size (USDC notional) | ~$2.50 at 0.50; Polymarket also enforces a floor of $1 |
| Tick size | 0.01 (was 0.001 before mid-May 2026) |
| Order types | GTC, GTD, FOK, FAK, post-only — all per CLOB API spec. CLI exposes `create-order`, `market-order`, `post-orders`, `cancel`, `cancel-orders`, `cancel-all`, `cancel-market` |
| Auth | EOA / proxy / gnosis-safe signature; API key via `clob create-api-key` |
| Geoblock | Argentina IP returns `blocked: false`. US & sanctioned jurisdictions geoblocked. |
| Rate limits | Not exposed by CLI; CLOB doc reference is ~20–50 req/s burst, stricter on `create-order`. Expect cancel-replace latency ~100–300 ms on a clean HTTPS connection. |
| Resolution | Automatic, `seconds_delay: 0`, fires when window closes on the Chainlink stream. |

---

## 8. Profitability math — $500 paper book

Assumptions from the live book on `btc-updown-5m-1779109800`:
- Mid = 0.505, best bid = 0.50, best ask = 0.51 → **spread = 1¢ = ~2% of mid**.
- Effective fees: 0 bps; use 10 bps each side as safety buffer.

### (a) Taker copy — mirror an external trade

Buy 200 UP @ 0.51 = $102 notional. Exit later at 0.50 bid = $100.
- Spread loss = (0.51 − 0.50) × 200 = **−$2.00** per round trip.
- Fees @ 10 bps × 2 sides on $100 = **−$0.20**.
- **Net round trip: ~−$2.20 per $100 notional (−2.2%).**

Breakeven needs a source-wallet edge > **2.2%** per trade. On a $500 book turning 5×/day → 25 trades × $20 avg notional, breakeven requires ~$0.44 avg edge per trade (~2.2¢ favourable move after entry). Achievable only if the copy target has true alpha against a publicly-readable on-chain oracle. Most "copy" wallets won't.

### (b) Maker shadow — quote inside the book

Post 50 UP @ 0.501 bid and 50 UP @ 0.509 ask (tighter than the 1¢ market).
- Captured spread = (0.509 − 0.501) × 50 = **+$0.40 per round trip** on $25 notional → +1.6% gross.
- Adverse selection: at resolution your inventory worth 0 or 1. If filled on the wrong side near resolution, the 50-share inventory can wipe (≈ −$25 in the worst case).
- With **no maker rebates (`clobRewards: null`)**, no subsidy offsets adverse selection. Even at a 90% win rate, expected value: `0.9 × $0.40 − 0.1 × $25 = −$2.14` per round trip. **Maker shadow is structurally negative-EV** on these markets in their current (unrewarded) state.

### Bottom line for a $500 paper book

- **Taker copy** is only viable if the source wallet has > 2.5% per-trade edge net of spread — rare on a Chainlink-resolved oracle market.
- **Maker shadow** is not viable on 5m BTC right now: zero rewards, thin books, binary adverse selection at resolution.
- Best operational targets: (i) longer-window BTC up/down series (15m / 1h) — the 15m series does carry `clobRewards`, so adverse selection is partially subsidised; or (ii) treat 5m markets as a **pure forecast-execution venue** — trade only when an internal BTC-price model predicts the Chainlink close with high confidence, taking liquidity inside the 5-min window. A practical bot should pre-cache books on each new 5m market ~24h ahead and queue entry signals near t=0.
