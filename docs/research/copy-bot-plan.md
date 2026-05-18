# Bonereaper Copy Bot — Plan

Synthesizes the three research reports (`bonereaper-profile.md`, `bonereaper1-profile.md`, `5min-btc-market-structure.md`) into a concrete build plan.

## The decisive findings

1. **Fees are effectively 0%** on 5-min BTC markets (template says 1000 bps, effective is 0). This is the single biggest change to the original cost model — a naive taker copy does **not** suffer fee drag.
2. **No maker LP rewards** on these markets (`clobRewards: null`). Bonereaper1's edge is pure spread capture + win rate, not rebates. That's hard to replicate at $500.
3. **Bonereaper never sells** — 0 exit fills in 3,499 sample trades. He scales in and rides to resolution. This eliminates the entire "exit logic" surface from our bot.
4. **Spread cost = 1¢ tick** on ~$0.50 priced markets → 2% per round trip *in spread terms*. Break-even taker copy requires Bonereaper's win rate to clear that.
5. **PnL sign is unconfirmed.** The Polymarket data API only returns winning closed positions. The user has external evidence he's profitable; paper-trading is how we verify that AND that we can capture it.
6. **Two viable wallets:** Bonereaper1 (pure maker, +64% return, **not copyable** — copying him just pays back the spread he earns). Bonereaper (~65% maker / 35% taker, **partially copyable** if we accept paying the spread he sometimes earns).

## Strategy: thin-taker mirror

Copy mode: **Option 1 (taker mirror)**, but constrained. The taker objections the user raised — fees and latency — are partially dissolved by the zero-fee finding. What remains is the **spread cost**.

Rules:
- Copy **BUY entries only**. Bonereaper never sells; neither will we — hold to resolution.
- Copy **first fill per market only** for v1 (skip his scale-ins). Lower trade count, simpler attribution, cheaper paper test.
- Size cap **= min(his fill size × copy_ratio, top-of-book depth, $10)** per trade. v1 default copy_ratio = 1.0, hard cap $10.
- **Skip if** market has < 60s until resolution (no recovery time if we miss).
- **Skip if** spread > 2¢ (book too thin — our fill will walk levels).
- **Skip if** open positions ≥ N (default 10) — bankroll concentration limit.
- Daily loss cap: −5% of bank ($25 paper, $3.40 live initially).

Expected economics per trade (paper, $10 size, 0.50 entry, hold to resolution):
- Cost: $10 (20 shares × $0.50)
- Win: 20 × $1 = $20 → **+$10 (+100%)**
- Lose: $0 → **−$10 (−100%)**
- Break-even win rate: **50%**. Bonereaper1's measured win rate is 61.7%. If Bonereaper is in that range, expected value is positive even with spread paid.

## Architecture

New Rust module inside this repo (don't write a separate codebase — leverage existing auth, config, SDK plumbing):

```
src/bot/
  mod.rs           — subcommand entry, top-level loop
  watcher.rs       — poll loop watching the target wallet's trades
  classifier.rs    — turn a new fill into {market, side, token_id, size, max_entry_price}
  executor.rs      — paper OR live order placement, behind a trait
  positions.rs     — in-memory open-position state, mark-to-market
  resolver.rs      — detect market resolution, settle, compute realized PnL
  ledger.rs        — durable trade log (JSONL or SQLite) + paper bank
  config.rs        — TOML config: master_address, copy_ratio, max_position, kill_switch, mode
```

New CLI subcommands:

```
polymarket bot paper --bank 500          # paper-trade against live data
polymarket bot live                      # flip to real orders (requires --confirm-real-money)
polymarket bot status                    # open positions, today PnL, hit rate
polymarket bot ledger --since 24h        # paginated trade log
polymarket bot kill                      # hard stop, cancel everything
```

Implementation reuses:
- `src/auth.rs` for the wallet (already wired to `.env`)
- `polymarket_client_sdk::clob::Client` for order placement (existing dep)
- `polymarket_client_sdk::data::Client` for the trade watcher (already in `commands/data.rs`)

## Phases & estimated effort

| Phase | Deliverable | Estimated effort |
|---|---|---|
| **P1. Watcher + paper executor + ledger** | `bot paper` runs, polls Bonereaper, logs would-be trades, no resolution yet | 1–2 days |
| **P2. Resolution + PnL** | Each paper position auto-settles when its market resolves; aggregate stats in `bot status` | 1 day |
| **P3. Paper-trade validation run** | Run for 24–72 hours. Compare paper PnL to (a) Bonereaper's expected profile and (b) random-coinflip baseline | Live time, parallel to dev on other phases |
| **P4. Decision gate** | If paper PnL > 0 with reasonable Sharpe → user authorizes live. If ≤ 0 → iterate filters (stricter spread limit, only round-tick entries, etc.) | 0 if pass; 1–3 days iteration if fail |
| **P5. Live mode** | Same code, real orders, hard limits, alerts | 0.5 day (mostly safety rails) |

## Risk controls (apply to both paper and live)

- **Hard kill switch:** `polymarket bot kill` cancels everything, marks bot disabled in a state file the watcher reads each loop.
- **Per-trade cap:** $10 paper, $1 live initially. Both via config.
- **Daily loss cap:** if realized PnL today ≤ −5% of bank, disable until manual reset.
- **Max open positions:** default 10. Prevents bankroll concentration.
- **Heartbeat:** log every N seconds with current state; cron-friendly.
- **No leverage, no derivatives, no negative-risk markets** in v1.

## Open questions that need a decision before P1

1. **Polling cadence.** The Polymarket data API doesn't have a documented rate limit but it's good etiquette to stay under ~2 req/s. Default: poll `data trades 0xeebde7…` every **2 seconds**. Faster is more reactive but riskier on rate limits.
2. **First-fill-only vs scale-in mirroring.** v1 plan says first-fill-only. The risk: Bonereaper's edge may *require* the scale-in (he likely scales in when the price moves against him cheaply). Easy to add later.
3. **Storage.** JSONL file (simple, grep-friendly) or SQLite (queries, but adds a dep). v1 recommendation: JSONL.
4. **Notifications.** None in v1; just log. Could add Telegram/Discord later.

## What I will NOT do without your sign-off

- Place any live order — paper-only until the P4 decision gate.
- Increase per-trade cap above $10 paper / $1 live without your explicit instruction.
- Disable safety rails or kill switch.
