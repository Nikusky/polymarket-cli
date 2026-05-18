# Bonereaper1 — Wallet Profile

**Address (proxy wallet):** `0x725Fd0798Eca95357696f2521DD1d4784162570C`
**Display name:** Bonereaper1 — pseudonym `Astonishing-Tackle`
**Data source:** Polymarket data-api via local Rust CLI; activity paginated through the API's max offset of 3000 records, plus `data trades`, `data closed-positions`, `data value`, `data traded`.
**Snapshot taken:** 2026-05-17 (data window captured: 2026-05-09 19:59:06 UTC -> 2026-05-10 13:44:05 UTC, i.e. one ~17.75-hour burst).
**Wallet type:** Polymarket-managed proxy wallet (`proxy_wallet` field returned, all activity attributed to the proxy address).

---

## 1. Identity & scope

| Metric | Value |
|---|---|
| Markets traded (lifetime, `data traded`) | **105** |
| Activity records captured in window | 3 499 (cap at API offset = 3 000 + 500) |
| TRADE rows in window | **3 453** |
| REDEEM rows in window | 44 |
| Unique markets in window | 48 (47 BTC 5-min, 1 BTC 15-min - likely a slip) |
| Total USDC notional (in window) | **$59 273** (BUY $46 474 + SELL $12 799) |
| `data value` (current open exposure) | **$0** |
| Open positions | **None** (`data positions` empty) |
| Last activity in window | 2026-05-10 13:44:05 UTC |

The wallet is **active**, **fully flat at snapshot**, and concentrates its volume in a single 17-hour window. Lifetime market count (105 vs. 48 in window) implies several prior, similar bursts.

---

## 2. Market focus

| Bucket | Trades | Share | USDC |
|---|---|---|---|
| `btc-updown-5m-*` (5-min BTC binary) | **3 433** | **99.42 %** | $59 216 |
| `btc-updown-15m-1778406300` | 20 | 0.58 % | $57 |
| Anything else | 0 | 0 % | $0 |

Bonereaper1 is **a pure 5-minute BTC up/down specialist**. The single 15-min market appearance is a rounding-error stub ($57 total) and can be ignored. Of 47 unique 5m markets in the window, only 1 saw both UP and DOWN bought - see section 7.

---

## 3. Maker vs taker classification

**Verdict: MAKER / passive limit orders. High confidence.**

Evidence:

| Signal | Value | Interpretation |
|---|---|---|
| Fills per tx hash | 1.00 (3 433 fills / 3 433 unique tx) | One settlement per fill - characteristic of resting limit orders being matched, not a single taker order sweeping multiple makers |
| Round-price fills (`x.xx` exact, two decimals) | 75.2 % | Wallet posts at clean tick prices (0.50, 0.49, 0.90, 0.40...) - the top 5 prices alone account for **~70 %** of all fills |
| Top price buckets | 0.50 (1 200 fills), 0.49 (713), 0.90 (367), 0.40 (221), 0.38 (161) | These are typical maker quote levels at and just inside the spread |
| Median fill size | $2.78 (mean $17.25, p90 $24.60) | Many small partial fills against one resting order - classic maker behavior |
| Largest market | 2 038 fills in a single 5-min slot | A maker quote resting through the whole window collected this many counterparty taker hits |
| SELL behavior in the closing 30 s | Only 7 of 551 SELLs (1.3 %) - sells are **early**, not last-second hedging | Confirms he is providing liquidity, not stop-outing |

The combination of (a) 1 fill/tx, (b) 75 % round-price fills, (c) tiny median fill, and (d) SELLs concentrated mid-window not end-window is the textbook signature of a maker bot quoting both sides and rebalancing as the window evolves.

---

## 4. Sizing & cadence

| Metric | USDC |
|---|---|
| Mean trade size | **$17.25** |
| Median | $2.78 |
| p25 / p75 | $1.07 / $8.29 |
| p90 / p99 | $24.60 / $300.00 |
| Max | $3 902.66 |
| Min | ~$0 (dust) |

| Cadence | Value |
|---|---|
| Trades / hour (avg over 17.75 h) | **193** |
| Peak hour | 2 334 trades |
| Median active hour | 119 trades |
| Hours active in window | 10 of 18 |
| Trades per market (median) | 16 |
| Trades per market (p90) | 89 |
| Trades per market (max) | 2 038 |

Holding time (BUY -> opposite-side SELL pairs, only 17 such pairs found): median **84 s**, p75 **102 s**, max **222 s**. The wallet rarely round-trips a single share - it usually buys, holds to resolution, and collects $1 redemption.

---

## 5. Timing within the 5-min window

Window offset = `trade.timestamp - openTs` where `openTs` parsed from slug.

| Bucket | Fills | Share | USDC |
|---|---|---|---|
| **before open** (pre-roll, off < 0) | 799 | 23.3 % | $12 079 |
| [0, 60) s | 1 033 | 30.1 % | $12 875 |
| [60, 180) s | 828 | 24.1 % | $16 524 |
| [180, 270) s | 699 | 20.4 % | $15 006 |
| [270, 300) s (last 30 s) | 63 | 1.8 % | $2 600 |
| after close | 11 | 0.3 % | $133 |

Bonereaper1 quotes **across the whole window**, with a heavy bias to the **first minute** and a deliberate pull-back in the **last 30 seconds** (1.8 %). 23 % of fills happen *before* market open - he posts quotes pre-roll and lets early takers hit them.

---

## 6. Realized edge

Computed per market as `sells_USDC + redeems_USDC - buys_USDC`.

| Metric | Value |
|---|---|
| Markets settled | **47** |
| Total cost (BUYs) | $46 417 |
| Total proceeds (SELLs + REDEEMs) | $76 140 |
| **Realized PnL (window)** | **+$29 723** |
| Return on capital deployed | **+64.0 %** |
| Win rate | **61.7 %** (29 W / 18 L / 0 flat) |
| Avg win | **+$1 386** |
| Avg loss | **-$582** |
| Expectancy / market | **+$632** |
| Cumulative after first 5 markets | +$11 036 |
| Cumulative after 25 markets | +$25 726 |

Top wins were concentrated in three markets (+$13.5k, +$6.0k, +$4.6k) which together accounted for ~80 % of profit. Losses are smaller and more spread out, but 17 markets ended with a complete write-off of the losing side's cost (`redeem = 0`). The edge is real but **fat-tailed** - strip the top three winning markets and PnL drops to roughly +$5.6k on $26k cost (~22 %), still positive but much less spectacular.

---

## 7. Side bias

| Action | Count | USDC |
|---|---|---|
| BUY Up | 1 171 | $17 791 |
| BUY Down | 1 711 | $28 627 |
| SELL Up | **0** | $0 |
| SELL Down | 551 | $12 799 |

By dollar BUYs are **61.7 % Down, 38.3 % Up**. Per market, **36 of 47** markets were Down-net, **10 of 47** were Up-net, only 1 was two-sided. SELLs are **exclusively on Down shares** - he never closes a long-Up position, he just lets Up shares ride to redemption. This is asymmetric: he uses Down as the actively-rebalanced inventory and Up as a redeem-and-hold ticket.

---

## 8. Replicability at $500 + 1-5 s latency

**Verdict: poor fit for naive copy.** Bonereaper1 is a **maker** running a high-frequency two-sided quoting bot on a single market type. His edge comes from (a) being on the book before takers arrive - 23 % of his fills are pre-open quotes - and (b) collecting hundreds to thousands of small fills against a resting order, which only works because his orders sit at the best price level *first*. A $500 copy bot reacting 1-5 s after each on-chain trade is fundamentally a **taker**: by the time you see his fill, the price has already moved and you would cross the spread to replicate. You will pay roughly the entire edge he is earning. Worse, the realized +64 % is concentrated in three windows ($13.5k + $6.0k + $4.6k = $24.1k of $29.7k profit). At $500 stake you cannot reliably accumulate those tails; one of the larger losses (max -$3 530) alone is 7x your bankroll. Conclusion: do not copy-trade this wallet. The strategy is replicable only if you (i) run your own maker quoting on BTC 5m markets, (ii) co-locate against the CLOB websocket, and (iii) start with >= $20k. The other agent's wallet (Bonereaper) may be a better copy candidate if it is a taker - see below.

---

## vs. Bonereaper (comparative notes from this dataset)

I have not coordinated with the sibling agent, but the visible markers are suggestive:

- **Same pseudonym surname.** This wallet displays as `Bonereaper1` (suffix `1`), pseudonym `Astonishing-Tackle`. A sibling `Bonereaper` (no suffix) is the standard naming for a second proxy under the same operator account. **Likely same human, different proxy.**
- **Concentration:** This wallet is laser-focused on BTC 5m (99.4 %). If `Bonereaper` shows the same market focus, that strongly confirms a shared operator and likely **one bot running two wallets** for capital separation or risk segmentation.
- **Strategy hypothesis:** If `Bonereaper` shows **multi-fill txs and aggressive crossing prices** (sweeping the book in last 30 s), the operator probably runs **maker on `Bonereaper1` and taker on `Bonereaper`** - two complementary legs of the same edge. That would also explain the suffix-`1` convention (the "1" being the passive book).
- **For copy-bot purposes:** If `Bonereaper` is the taker, *that* is the wallet worth copying with $500 (you can mimic taker latency). If `Bonereaper` is also a maker, neither wallet is a viable copy target. Recommend the parent compare these specific signals: (a) fills-per-tx (1.0 here = maker), (b) round-price fill share (75 % here = maker), (c) last-30s SELL share (1.8 % here = maker).

---

*Report generated 2026-05-17 from on-chain Polymarket data via `polymarket-cli`. Raw JSON cached at `C:\Users\nicol\AppData\Local\Temp\b1_*.json`.*
