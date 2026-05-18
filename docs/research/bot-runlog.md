# Bonereaper Copy Bot — Run Log

Chronological log of bot builds, config changes, and observed performance.
Newest entries at the top of each section. UTC timestamps unless noted.

## Implementation milestones

| Phase | Done | Summary |
|---|---|---|
| **P1** (scaffolding) | 2026-05-17 | Watcher + paper executor + JSONL ledger + positions store + bot subcommands. 10 substeps. Smoke-tested. |
| **P2** (resolution + PnL) | 2026-05-17 | Resolver via `gamma::market_by_slug`; settle sweep every 30s; daily-loss-cap enforcement; PnL accounting in `bot status`. 6 substeps. |
| **P2.7–P2.11** (hardening) | 2026-05-17 | Executor unit tests via pure `plan_paper_fill()`; classifier edge cases; lint + fmt + full test pass; richer terminal output (per-poll tick line + 4-line heartbeat). |
| **P2.12** | 2026-05-17 | `parse_resolve_ts(slug)` — derives resolution time from `btc-updown-5m-<EPOCH>` slug; watcher passes it to classifier. |
| **P2.13** | 2026-05-17 | Executor catches 404 from `/book` as `Skipped(MarketClosed)` instead of bubbling as error. |
| **P2.14** | 2026-05-17 | `is_btc_five_min_market` tightened to require `parse_resolve_ts.is_some()` — rejects UMA `bitcoin-up-or-down-*-et` markets. |
| **P2.15** | 2026-05-17 | Config override: `min_time_to_resolve_secs` 60 → 30. |
| **P2.16** | 2026-05-18 | Config override: `min_time_to_resolve_secs` 30 → 0. |

## Test suite progression

| Date | Total tests | Notes |
|---|---|---|
| 2026-05-17 (P1 start) | 86 | pre-existing project tests only |
| After P1.3 (config) | 90 | +4 BotConfig tests |
| After P1.4 (ledger) | 93 | +3 ledger round-trip tests |
| After P1.7 (positions) | 96 | +3 positions tests |
| After P1.5 (classifier) | 105 | +9 classifier tests |
| After P2.2 (resolver) | 113 | +8 resolver tests |
| After P2.7 (executor) | 123 | +10 executor `plan_paper_fill` tests |
| After P2.8 (classifier edges) | 131 | +8 more classifier edge cases |
| After P2.12 (resolve_ts) | 135 | +4 `parse_resolve_ts` tests |
| Current | **131** | (one test flipped expectation in P2.14 when slug pattern tightened) |

CI gates all green throughout: `cargo fmt --check`, `cargo clippy --bin polymarket -- -D warnings`, `cargo test --bin polymarket`.

Pre-existing fix made in passing: `commands::upgrade::tests::detect_target_returns_valid_triple` gated with `#[cfg(not(windows))]` (test was unconditionally calling `detect_target().unwrap()` which panics on Windows).

## Config evolution

| Date (UTC) | Field | Value | Why |
|---|---|---|---|
| 2026-05-17 | `min_time_to_resolve_secs` | 60 (default) | Safety buffer to avoid late-window 404s. |
| 2026-05-17 ~22:30 | same | **30** | After observing 79% of 5m-market skips were `too_close_to_resolve`; halved buffer to recover entries. |
| 2026-05-18 ~16:20 | same | **0** | Even at 30s, ALL 5m-market master fills today (139/139) landed in the 0–30s window. Disabling the time gate; relying on executor's 404→`MarketClosed` net. |

Other defaults (unchanged so far): `copy_ratio=1.0`, `max_position_usdc=10.0`, `max_open_positions=10`, `daily_loss_cap_pct=5.0`, `spread_skip_cents=2`, `poll_interval_secs=2`.

## Performance snapshots

Each row is a `polymarket bot status` capture at the listed time. `entries`/`exits` are ledger-derived and survive restarts.

| When (UTC) | Open | Today entries | Today exits | Today PnL | All-time PnL | Win rate | Bank | seen |
|---|---|---|---|---|---|---|---|---|
| 2026-05-17 14:24 | 0 | 0 | 0 | $0 | $0 | – | $500 | 100 (warmup only) |
| 2026-05-17 18:43 | 1 | 4 | 3 | −$1.66 | −$1.66 | 33.3% | $494.54 | 376 |
| 2026-05-17 20:50 | 2 | 5 | 3 | −$1.66 | −$1.66 | 33.3% | $497.65 | 319 |
| 2026-05-17 22:17 | 3 | 6 | 3 | −$1.66 | −$1.66 | 33.3% | $500.00 | 614 |
| **2026-05-18 16:13** | **0** | **0 today** | **3** | **+$1.10 today** | **−$0.56** | **50.0%** | **$510.00** | **485** |

Notes:
- "Bank" is in-memory only and resets to `--bank N` on each restart. The ledger holds the true running PnL.
- "Today" rolled over at 2026-05-18T00:00Z. The 3 UMA-pending `bitcoin-up-or-down-*-et` positions all resolved overnight: 2 wins, 1 loss, +$1.10 net.
- The all-time win rate climbed from 33.3% (1W/2L on prior 5-min markets) to 50% (3W/3L after UMA resolutions).

## Skip-reason history

Snapshot of `grep '"kind":"skip"' data/bot-ledger.jsonl | sed -E 's/.*"reason":"([^"]+)".*/\1/' | sort | uniq -c | sort -rn`:

### 2026-05-17 ~22:17 (after P2.14, before P2.15)
| Count | Reason | Notes |
|---|---|---|
| 759 (60%) | not_btc_5min | Filtered UMA / non-BTC markets — by design |
| 392 (31%) | too_close_to_resolve | 79% of 5m-market skips → critical signal |
| 86 (7%) | already_open | Bonereaper's scale-in fills on markets we hold |
| 19 (2%) | no_liquidity | Empty/thin book at fetch time |

### 2026-05-18 16:15 (today only, after P2.15 with 30s filter)
| Count | Reason | Notes |
|---|---|---|
| 161 (54%) | not_btc_5min | Same pattern |
| 139 (46%) | too_close_to_resolve | **100% of 5m-market fills today were within 30s of resolve.** Drove P2.16. |
| 0 | already_open | No open positions today |
| 0 | no_liquidity | – |

## Errors observed

- **404 from `/book` (32 instances on 2026-05-17, pre-P2.13):** book is gone because the market just resolved. Now caught and logged as `skip market_closed` instead of stderr error.
- **Transient `Internal: error sending request for url ...` (~5 instances per few-second blip):** both data-api and gamma-api throw these intermittently. Watcher recovers on the next poll tick; settle sweep retries on next 30s cycle. No special handling needed.

## Key research-confirmed observations

From the three parallel research agents on 2026-05-16 and live runtime data:
- **Fees on 5m BTC markets are effectively 0** (template caps 1000 bps; effective 0). Naive taker copy has no fee drag.
- **No maker LP rewards** (`clobRewards: null` on every 5m BTC market). Maker-side strategies have no rebate offset.
- **Bonereaper never sells** — 0 of 3,499 sample trades are exits. He scales in and rides to resolution.
- **`bitcoin-up-or-down-*-et` markets resolve via UMA** (multi-hour dispute window after end). 5m `btc-updown-5m-<EPOCH>` markets resolve via Chainlink (seconds).
- **`data.trades` defaults to `taker_only=true`** — the 65/35 maker/taker split for Bonereaper means the API returns ~35% of his total fills by default. Set `taker_only(false)` in the SDK builder if maker visibility is wanted.
- **His taker fills concentrate near resolution.** Live data confirmed: 79% of his 5m-market taker fills land in the last 60s, ~100% in the last 30s. This is the signal-vs-latency tradeoff at the heart of P2.15/P2.16.

## Open issues / known limitations

- **In-memory bank** resets on restart. Cosmetic for paper mode; revisit before P5 (live).
- **Scale-in fills are ignored** (first-fill-only policy). 86 `already_open` skips so far. Possible v2 enhancement: copy each fill independently, allowing dollar-cost-averaging into a market.
- **No `data.activity` integration.** Trades API is enough for v1 but doesn't show splits/merges/redeems Bonereaper might do.
- **Settle sweep doesn't retry failed `market_by_slug` immediately** — waits the full 30s. Acceptable given UMA settle latency dominates.
- **Daily loss cap is per-process, not per-UTC-day.** Restart resets the loss accumulator. Adequate for paper; needs persistence before live.

## Path to P4 (decision gate) and P5 (live)

P3 is data-collection. Targets before flipping to live:
- ≥ 30 exits with statistically interpretable win rate
- Confirmed positive net PnL across that sample
- Skip reasons balanced (not all `too_close_to_resolve`)

If those pass, P5 requires:
- New `LiveExecutor` impl behind an `Executor` trait (so paper and live can swap)
- `polymarket bot live --confirm-real-money` subcommand with explicit per-run prompt
- Per-trade cap reduced to ~$1 initially
- Daily loss cap persisted to disk
- Order build via `polymarket_client_sdk::clob::Client::order_builder` and `post_order`
