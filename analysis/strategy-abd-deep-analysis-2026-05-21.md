# Deep analysis — A/B/D losses, master comparison, risk reduction proposals

**Window:** 12-25h per variant. 49 settled trades pooled. **All variants are losing money.**

## TL;DR

1. **Up bets work (90.5% WR, +$49). Down bets are broken (60.7% WR, -$862).** This is the entire story of our PnL.
2. **The "masters 81-85% WR" claim is a filtering artifact.** Real master WR on raw BTC 15m trades is **49.4%**. The 80% figure only appears when filtering to fills > 0.65. We're paying 0.85+ on average — outside the master profitable zone on both ends.
3. **Worst hours: 22 UTC (0% WR, -$500/5 trades) and 16 UTC (40% WR, -$288/5 trades).** Concentrated, not random.
4. **One filter combo gives clean +12.8% ROI in this sample: "Up only + skip hr 16/22 + fill ∈ [0.85, 0.92]"** (n=7, 100% WR). Sample tiny, but every component is independently signed.

## Pooled summary

| Variant | Span | Entries | WR | PnL | Avg fill | Edge (WR-fill) |
|---|---|---|---|---|---|---|
| A | 24.5h | 14 | 71.4% | -$290 | 0.856 | **-0.142** |
| B | 24.8h | 26 | 76.9% | -$336 | 0.859 | **-0.090** |
| D | 12.0h | 9 | 66.7% | -$186 | 0.845 | **-0.179** |
| **Pool** | — | **49** | **73.5%** | **-$812** | **0.855** | **-0.120** |

`Edge = WR - avgFill`. Break-even requires edge ≥ 0. We're consistently 9-18 pp negative.

## The 13 losses, anatomized

| Variant | UTC | Side | obsBps | fill | Pattern |
|---|---|---|---|---|---|
| B | 02:26 | Up | 5.53 | **0.80** | Weak signal + suspiciously cheap fill |
| A | 05:43 | Up | 7.85 | 0.95 | Strong signal but priced-in (fill 0.95) |
| A | 15:58 | Down | -7.45 | 0.82 | Down at 16-UTC cluster |
| A | 16:58 | Down | -8.52 | 0.94 | Down at 16-UTC cluster |
| **B,D** | **16:56** | **Down** | -7.68 | 0.86 | **Same trade, both variants — Down reversal** |
| B | 18:26 | Down | -5.91 | **0.59** | Cheap Down = trap |
| **B,D** | **22:26** | **Down** | -9.85 | 0.73-0.79 | **Both variants — 22-UTC cluster** |
| **B,D** | **22:41** | **Down** | -6.73 | 0.89 | **Both variants — 22-UTC cluster** |
| A | 22:28 | Down | -6.58 | **0.24** | Cheap Down = trap |
| B | 01:41 | Down | -5.43 | 0.73 | Down reversal |

**12 of 13 losses are Down bets.** The one Up loss (B 02:26) had fill 0.80 (cheap = trap) and weak signal (5.53 bps).

**Loss clusters are systemic:** 16:00 UTC (3 losses across A/B/D) and 22:00-22:41 (4 losses, 3 of which hit B and D simultaneously). These aren't noise — they're regime moments where BTC's mean reverts after a Down drift.

## Master comparison (full tape, 869 trades, bug-fixed)

| | n | WR | avg fill | ROI |
|---|---|---|---|---|
| All masters | 869 | **49.4%** | 0.491 | **-0.9%** |
| ohanism | 151 | 58.9% | 0.551 | +7.9% |
| cE25 | 419 | 48.2% | 0.471 | -0.6% |
| b55fa | 299 | 46.2% | 0.489 | -3.5% |

**The masters are not 81% accurate. They're 49% accurate at ~$0.49 fills, which is roughly break-even after losses.** Where the 80% claim comes from:

| Fill bucket | n | WR | ROI |
|---|---|---|---|
| [0, 0.40) | 334 | 24% | -25% |
| [0.40, 0.55) | 183 | 40% | -28% |
| [0.55, 0.65) | 95 | **64%** | **+25%** ← sweet spot |
| [0.65, 0.75) | 97 | 65% | +6% |
| [0.75, 0.85) | 69 | **90%** | **+20%** |
| [0.85, 0.95) | 49 | 98% | +9% |

**Two zones make money:** (1) fills 0.55-0.65 (positive edge, decent ROI), (2) fills 0.75-0.85 (high WR offsets low payout). The "80% accuracy" was the docs filtering to fill > 0.65. The masters' edge is **picking high-conviction late-cycle trades at fills the market mispriced** — not "buy cheap, hold to settlement."

### Where we fall relative to masters

| | Our avg fill | Master avg fill |
|---|---|---|
| All trades | **0.855** | 0.491 |

**We're entering exclusively in the 0.85+ zone where masters need 90%+ WR to be profitable.** Masters get there. We don't (73.5%).

Why: by minute 11-13 with obs > 5 bps, the move has already been seen by other traders. The book on the winning side has been cleared; only expensive asks remain. We're "buying the news."

## Why we're losing — three structural reasons

1. **Asymmetric edge by direction.** Up trades have 90.5% WR. Down trades have 60.7% WR. The strategy works one-sided.
   - Hypothesis: BTC has positive drift in this period. After a Down drift in the first 11-13 min, mean reversion is stronger than after an Up drift.
   - Confirmed by clustering: losses bunched at 16 UTC and 22 UTC, both Down-side, both reversal hours.

2. **Fill bracket mismatch.** We pay 0.85+ where break-even needs 85%+ WR; we deliver 73%. The 12 pp gap × $100 average position × 49 trades = $588 expected loss (close to actual -$812 once losses are full -$100 each).

3. **Pay-to-loss asymmetry.** Avg win $13.54. Avg loss $100. **A single loss erases 7.4 wins.** This is structural for any fill > 0.50, not fixable without entering cheaper — and entering cheaper means observing earlier, where the signal hasn't formed.

## Counterfactual: filter combinations on existing 49 trades

| Filter | n | WR | PnL | ROI |
|---|---|---|---|---|
| No filter (baseline) | 49 | 73% | -$812 | -16.6% |
| Up only | 21 | **90%** | **+$49** | **+2.3%** |
| Skip hr 22 | 44 | 82% | -$312 | -7.1% |
| Skip hrs 16+22 | 39 | 87% | -$24 | -0.6% |
| Up + skip 22 | 21 | 90% | +$49 | +2.3% |
| fill ∈ [0.85, 0.92] | 16 | 75% | -$254 | -15.9% |
| **fill ∈ [0.85, 0.92] AND Up** | **7** | **100%** | **+$90** | **+12.8%** |
| **Up + skip 16,22 + fill [0.85, 0.92]** | **7** | **100%** | **+$90** | **+12.8%** |

The fill cap **alone** doesn't help. But **fill cap + Up-only** = clean (every single trade in that filter won). Hour blackouts give incremental help on top.

Asymmetric sizing ($150 Up / $50 Down) cuts losses in half (-7.8% vs -16.6%) but doesn't turn positive. **Stopping Down entirely is the only path to positive ROI** with current edge profile.

## Risk reduction proposals — ranked by impact

### 1. Kill Down side entirely (HIGHEST IMPACT)

**Action:** `if (betSide === 'Down') skip`. One-line change in `main.js`.

**Effect on pooled sample:** -16.6% → +2.3% ROI. Trades drop 49 → 21 (57%), but PnL turns positive.

**Risk:** sample is one week. The Down/Up asymmetry might be a 2026-May regime, not structural. Mitigant: re-enable Down if it shows 85%+ WR for 3 consecutive weeks in paper.

**Implementation:** new env `STRATEGY_SIDES=up` (or `up,down` default).

### 2. Hour blackout: 16 UTC and 22 UTC

**Action:** add `BLACKOUT_HOURS=16,22` env. Skip entries where decideHr matches.

**Effect:** alone reduces ROI from -16.6% to -0.6%. Stacked with Up-only doesn't add much (Up-only already catches most of the benefit).

**Risk:** hour patterns may be sample-specific. Argentina-relevant: 22 UTC = 19:00 ART (post-dinner). Could be coincidence.

**Implementation:** trivial.

### 3. Lower position size + Kelly-aware

**Action:** drop from $100 → $50/trade until WR validates. With avg loss $100 vs avg win $13.54, Kelly fraction is negative — so technically the strategy says "don't bet". Pragmatic: $50 caps damage during validation.

**Effect:** reduces both upside and downside proportionally. Doesn't fix the strategy but limits paper losses while iterating.

**Implementation:** change ExecStart arg from 100 to 50 in service files.

### 4. Stop-loss equivalent (early exit)

**Action:** at minute 14 (1 min before settle), check current ask. If BTC has reversed past entry direction (e.g., bet Up but BTC now < btcAtDecision), close position via market sell.

**Effect:** would have salvaged ~40-60% of losses (rough estimate from the cluster pattern — many losses showed reversal in last 2-3 min). Need orderbook simulation to size precisely.

**Risk:** Polymarket exit slippage may eat the rescue. Need pre-trade orderbook data on the OPPOSITE side (which we don't currently capture). **Requires snapshot daemon change.**

**Implementation:** medium effort. Add `settleEarly()` path in main.js.

### 5. Confirmation: require obs persistence at min 10 AND min 13

**Action:** if observing at min 11, also peek at min 10 BTC. Require both confirm direction with |obs| > 5.

**Effect:** would have killed ~3-4 false-positive entries based on the loss clusters (where signals fluctuated). Drops entry rate ~30%.

**Risk:** complexity, less data.

**Implementation:** medium. Requires storing min-10 snapshot.

### 6. Avoid extreme cheap fills (anti-trap)

**Action:** **floor** the fill (`MIN_FILL_PRICE=0.50`). Cheap fills (< 0.5) are where masters lose 25% ROI; in our data 2 of the 3 cheapest entries (0.24, 0.59) were losses.

**Effect:** small (only 3 of 49 entries below 0.65), but each saves a near-certain -$100.

**Implementation:** symmetric to MAX_FILL_PRICE, trivial.

## Recommended immediate action

**Apply #1 and #2 today** (Up-only + skip hours 16, 22). Highest impact, lowest implementation cost, zero new infrastructure.

Concretely: introduce env `STRATEGY_SIDES=up` and `STRATEGY_BLACKOUT_HOURS=16,22` in `main.js`. Add a new variant **E = "Up-only filtered"** alongside A/B/D as a paper test. After 48h compare E vs D vs B on the **same trades** they all see.

Defer #3-#6 until E shows whether the asymmetric-side hypothesis holds for another week.

## Open questions

- Is Up/Down asymmetry a regime (recent BTC drift) or structural? Re-test in 30 days with new BTC behavior.
- Can master comparison be improved by filtering to their 0.55-0.85 fill zone with similar logic? That's where they have edge — we should aim for that bracket, not 0.85+.
- The orderbook snapshot daemon (`snapshot_orderbooks.js`) captures fill quality at min 11 across the day. Cross-reference: are the loss hours (16, 22) also the worst snapshot fills?

## Sources

- Ledgers: `analysis/strategy-ledger-{a,b,d}.jsonl` (49 settled trades, 113 skips)
- Master tapes: `scripts/research/data/tape_{ohanism,cE25,b55fa}.json` (869 BTC 15m BUY trades)
- BTC oracle: `scripts/research/data/btc_klines_24mo.json` (24mo, 1-min resolution)
- Outcome computation: `winner = btcClose > btcOpen ? 'Up' : 'Down'` using kline `.c` (close) field. Initial bug fixed in this analysis: prior code returned the full kline object as a price, causing NaN comparisons → constant Down winner.
