# Master Selection — Crypto Leaderboard Research (2026-05-18)

**Goal:** pick the best crypto trader to mirror with the existing Bonereaper copy bot, given a $10k bank.

## Method
1. Pulled Polymarket leaderboards: week / month / all-time PnL + weekly volume, 200 deep each.
2. For every candidate appearing in any board, pulled their last 500–2500 fills via `data trades`, classified each by slug.
3. For top crypto-active wallets, pulled `data closed-positions` and bucketed by market type (`btc-updown-5m-*`, `btc-updown-15m-*`, `bitcoin-up-or-down-*`, `eth-updown-*`, `sol-updown-*`, `xrp-updown-*`).
4. Computed bot-eligibility = `(5m + UMA) / total crypto fills` since the classifier rejects 15m and 1h.

## Key finding
Almost every PnL leaderboard king (Sassy-Bucket, mooseborzoi, VPenguin, gmpm, Feromont, justwins, etc.) trades **sports**, not crypto. The bot's filter rejects 100% of their fills.

Only ~6 traders are crypto-pure AND active enough to be useful copy targets.

## Candidate scoreboard (bot-eligible 5m + UMA taker buys only)

| Trader | Wallet | Crypto-pure | 5m+UMA share | Med fill $ | Week PnL (all-mkt) | Style |
|---|---|---|---|---|---|---|
| **ohanism** | `0x89b5cdaaa4866c1e738406712012a630b4078beb` | 98% | 83% | $25 | **+$7.8k** | favorites-leaning, lower variance |
| **0xcE25** | `0xce25e214d5cfe4f459cf67f08df581885aae7fdc` | 100% | 39% (52% is 15m, ineligible) | $14 | **+$6.0k** | 15m specialist |
| **0xb55fa** | `0xb55fa1296e6ec55d0ce53d93b9237389f11764d4` | 87% | 49% | $16 | **+$4.0k** | balanced 5m/15m/UMA |
| **0x50f7** | `0xee65685de42f8de9a03b4c53ee77d56a20d2cfc9` | 95% | 86% | $5 (p90 $50) | **+$2.9k** | barbell, mostly tiny fills |
| **gansinimen** | `0x9412cdfc1e3171e1aabb013d0f494986445d0cd0` | 100% | 99.7% | $36 | +$0.9k | high-frequency 5m only |
| **Bonereaper** (current) | `0xeebde7a0e019a63e6b476eb425505b7b3e6eba30` | 100% | 84% | $16 | not on board (<$13k cutoff) | longshot tails (some at $0.03) |

Excluded: **JPMorgan101** ($97k week PnL but ~50% sports, ~$3k from BTC); **redvinny / Sharky6999 / alihanyer** (whale fill sizes $850–$1.8k — bot would always cap and underdeploy); **Maxdaboss1 / 0xa697** (negative or marginal crypto PnL).

## Recommendation

**Primary: switch master to `ohanism` (0x89b5cdaaa4866c1e738406712012a630b4078beb)**

Why:
- Highest weekly PnL among crypto-pure traders.
- 98% of activity is in crypto markets; 83% in bot-eligible (5m + UMA).
- Median fill $25, p90 $39 — every fill copyable at full ratio with $10k bank.
- Favorites-leaning (most buys at $0.40–$0.80) → higher win rate, lower variance than Bonereaper's tail-bet style.

**Strong alternative: extend the bot to `btc-updown-15m-*` and switch to `0xcE25`**

`btc-updown-15m-` markets settle in 15 min — three times the window of 5m. The bot's REST-polling latency (memory says 5m fills "arrive too stale to copy") is much more forgiving on 15m. `0xcE25` is 100% crypto-pure, +$6k/wk, 52% of activity is currently rejected by the classifier. Adding the prefix to `classifier.rs:75-78` is a one-line change.

## Sizing for $10k

Current defaults (`config.rs`): `max_position_usdc=10`, `max_open_positions=10` → max simultaneous exposure $100 (1% of $10k). Way underdeployed.

Recommended `~/.config/polymarket/bot.json` for $10k:

```json
{
  "master_address": "0x89b5cdaaa4866c1e738406712012a630b4078beb",
  "copy_ratio": 1.0,
  "max_position_usdc": 500,
  "max_open_positions": 20,
  "daily_loss_cap_pct": 5.0,
  "min_time_to_resolve_secs": 0
}
```

- `max_position_usdc: 500` (5% per fill) — fully copies ohanism's typical $25 fill, caps at $500 if they whale-buy.
- `max_open_positions: 20` — max simultaneous $10k exposure.
- `daily_loss_cap_pct: 5.0` — $500/day kill threshold.
- `min_time_to_resolve_secs: 0` — UMA markets don't parse this gate anyway; this lets late-window 5m taker tape through too.

## Caveats

1. **PnL is leaderboard-reported (all-market).** For 95%+ crypto-pure traders it's effectively crypto PnL, but I couldn't independently verify net PnL on bot-eligible subset alone — `closed-positions` endpoint returned only winning-side rows (cur_price=1 cases), so loss accounting is incomplete in that source. Treat ROI numbers as directional.
2. **Survivorship in active sample.** Weekly PnL is one week — could be lucky. Cross-check with month leaderboard before committing real funds.
3. **No live-mode in bot yet.** `bot paper` only. Switching masters affects paper performance; before going live (when that subcommand is added), validate the new master for 1–2 weeks in paper.
4. **Confirm wallet identity off-chain before going live.** A wallet name like "ohanism" is self-selected and not a guarantee of strategy continuity.
