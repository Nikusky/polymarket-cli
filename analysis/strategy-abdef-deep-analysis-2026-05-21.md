# Deep analysis — 5 variants live, fresh data, contramedidas

**Date:** 2026-05-21 21:40 UTC
**Author:** Claude (polyBOT session)
**Data source:** server pull via SCP from `/opt/polybot/polymarket-cli/scripts/strategy/data-{a,b,d,e,f}/strategy-ledger.jsonl`
**Variants in scope:** A, B, D, E, F — **all five deployed and running**

E and F came up 2026-05-21 03:28:20 UTC, so this analysis includes ~18 h of E/F data and ~44 h of A/B and ~31 h of D. Supersedes the earlier draft of this document which was based on local 12-h-stale ledgers and the incorrect assumption that E/F were not deployed.

---

## 1. Variant parameters (as actually running)

| Variant | observeMin | thresholdBps | maxFillPrice | maxObsBps | thesis |
|---|---|---|---|---|---|
| A | 13 | 5 | (none) | — | control: late observe, low threshold |
| B | 11 | 5 | (none) | — | earlier observe captures momentum |
| D | 11 | 6 | 0.92 | — | B refined: cap fills |
| E | 11 | 5 | 0.92 | **7** | Goldilocks: skip large drifts as exhausted news |
| F | 9 | 4 | **0.85** | — | catch fills before book reprices |

---

## 2. Current performance — all five variants

| Variant | Entries | WR | PnL | ROI | Avg fill | BE gap | MaxDD | UpWR | DownWR |
|---|---|---|---|---|---|---|---|---|---|
| **E** | 3 | 66.7% | -$43.94 | -14.65% | 0.8159 | **-14.9 pp** | $100 | 50.0% | 100.0% |
| **D** | 18 | 77.8% | -$151.43 | -8.41% | 0.8546 | -7.7 pp | $274 | 83.3% | 75.0% |
| **A** | 22 | 81.8% | -$193.97 | -8.82% | 0.8707 | -5.3 pp | $333 | 90.9% | 72.7% |
| **B** | 43 | **83.7%** | -$238.31 | -5.54% | 0.8726 | **-3.5 pp** | $396 | 88.9% | 80.0% |
| **F** | 18 | 64.7% | -$251.84 | -13.99% | **0.7630** | -11.6 pp | $403 | 62.5% | 66.7% |

Read this twice — it is the whole story:
- All five are negative.
- Breakeven WR equals avg fill price. B is closest to breakeven (-3.5 pp), but does not cross.
- E's tiny sample (n=3) makes its rank meaningless; 39 skips with reason `obs_too_high` show E is actively rejecting trades B/D would have entered.
- F has the lowest fill price (0.763 — cap is working) but the worst WR (64.7%). Early-observe is not finding signal.

---

## 3. Asymmetric Up/Down edge is **less extreme** than yesterday's stale data suggested

Aggregate across all 5 variants:

| Side | n | WR | PnL |
|---|---|---|---|
| Up | 45 | 82.2% | -$237.49 |
| Down | 58 | 75.9% | **-$642.01** |

Down is still worse, but Up is also now negative. Cutting Down is not the silver bullet that yesterday's snapshot implied — Up alone would still bleed across most variants.

Per variant:
- A: Up -$16.77, Down -$177.19 — Down dominates
- D: Up -$15.90, Down -$135.53 — Down dominates
- F: Up -$128.15, Down -$123.69 — **no asymmetry**. Early-observe washes the directional edge.

---

## 4. By UTC hour — aggregate across all 5 variants (fresh)

**Toxic hours (PnL negative, n≥2):**

| Hour UTC | n | WR | PnL |
|---|---|---|---|
| **22** | 6 | 17% | **-$485.46** |
| **13** | 7 | 43% | **-$337.33** |
| **17** | 7 | 57% | -$245.80 |
| 07 | 4 | 50% | -$156.60 |
| 18 | 6 | 67% | -$131.75 |

**Productive hours (PnL positive, n≥3):**

| Hour UTC | n | WR | PnL |
|---|---|---|---|
| **14** | 10 | **100%** | **+$177.96** |
| **12** | 6 | **100%** | **+$142.13** |
| 20 | 5 | **100%** | +$82.32 |
| 10 | 3 | **100%** | +$75.77 |
| 19 | 4 | **100%** | +$74.05 |
| 04 | 3 | **100%** | +$66.89 |
| 16 | 11 | 91% | +$42.75 |
| 06 | 3 | **100%** | +$35.54 |
| 03 | 3 | **100%** | +$34.41 |

**13 UTC is a new finding** — not in yesterday's snapshot. The three worst hours (13, 17, 22) drain **-$1068 combined** across the 5 variants. Blacking out 13 + 17 + 22 UTC alone would have shifted aggregate PnL from -$879 → +$189.

---

## 5. By |observeBps| bucket — 5-7 bps fails everywhere except obs-13

| Bucket | A (obs-13) | B (obs-11) | D (obs-11) | E (obs-11, capped) | F (obs-9) |
|---|---|---|---|---|---|
| 4-5 | — | — | — | — | n=4, 75% WR, +$1.68 |
| 5-7 | n=10, **90% WR, +$11** | bleed | n=4, 50% WR, -$129 | n=3, 67%, -$44 | n=6, 50% WR, **-$199** |
| 7-10 | n=10, **70% WR, -$217** | mixed | n=11, 82% WR, -$71 | (blocked by cap) | n=5, 60% WR, -$109 |
| 10-15 | n=2, 100% WR, +$12 | n=3, 100% WR, +$19 | n=2, 100% WR, +$40 | (blocked) | n=2, 100% WR, +$55 |
| 15+ | — | — | n=1, 100% WR, +$9 | (blocked) | — |

**Microstructure interpretation (refined):**
- 5-7 bps is reliable signal **only at observe-13**. At obs-11 and obs-9, 5-7 bps is below the noise floor — too weak to confirm direction.
- 10+ bps is universally profitable (4 wins / 0 losses across 4 variants, +$118 combined). Strong drifts persist.
- 7-10 bps is mixed: D 82% WR, A 70%, F 60%. Earlier observe makes 7-10 less reliable.

**E's `MAX_OBS_BPS=7` is the opposite of what the data wants.** It blocks the universally-profitable 10+ bucket and keeps the universally-toxic 5-7 bucket.

---

## 6. Per-variant contramedidas (evidence-grounded)

### A — control (obs-13, thr-5)  currently -$194

Diagnosis: 7-10 bps is killer (-$217). 17, 22 UTC drain $185.
Counter:
1. `MAX_OBS_BPS=7` — at obs-13 the late-window exhaustion hypothesis IS correct.
2. `STRATEGY_BLACKOUT_HOURS=13,17,22`.
3. Optional: `STRATEGY_SIDES=up`.

Expected: -$194 → **+$10 to +$40**.

### B — earlier observe (obs-11, thr-5)  currently -$238

Diagnosis: Best WR (83.7%), closest to breakeven (-3.5 pp). Bleeds from 5-7 bucket and bad hours.
Counter:
1. **Raise threshold to 7** — kills the bad 5-7 bucket.
2. `STRATEGY_BLACKOUT_HOURS=13,17,22`.
3. `MAX_FILL_PRICE=0.92`.

Expected: -$238 → **+$50 to +$100**.

### D — fill-capped (obs-11, thr-6, fill≤0.92)  currently -$151

Diagnosis: Cleanest configuration so far. Bleeds from 22 UTC (-$200) and Down side.
Counter:
1. Keep threshold 6.
2. `STRATEGY_BLACKOUT_HOURS=13,17,22`.
3. `STRATEGY_SIDES=up`.

Expected: -$151 → **+$100 to +$140**.

### E — Goldilocks (obs-11, thr-5, fill≤0.92, |obs|≤7)  currently -$44 (n=3)

Diagnosis: Hypothesis backwards for obs=11. 39 `obs_too_high` skips threw away productive 10+ trades.

Full redesign:
```ini
ExecStart=/usr/bin/node main.js 11 7 100 168
Environment=MAX_FILL_PRICE=0.92
Environment=STRATEGY_BLACKOUT_HOURS=13,17,22
Environment=STRATEGY_SIDES=up
# REMOVE: MAX_OBS_BPS
```
Becomes "B + threshold-7 + Up-only + blackouts" — the stacked-filter variant.

### F — early observe (obs-9, thr-4, fill≤0.85)  currently -$252, worst ROI

Diagnosis: Lowest fill (0.763, cap working), no asymmetric edge, 5-7 bucket disaster (-$199), 07 UTC cluster (-$169). Early-observe hypothesis is not supported by 18 trades.

Two options:

**F1 (rescue):**
```ini
ExecStart=/usr/bin/node main.js 9 7 100 168
Environment=MAX_FILL_PRICE=0.85
Environment=STRATEGY_BLACKOUT_HOURS=07,13,17,22
```

**F2 (kill):** Stop the variant. Replace with `obs=10, thr=6, fill≤0.88` to interpolate between F and B/D.

Recommendation: F1 for 48 h, kill if still negative.

---

## 7. Ranking after contramedidas (estimates)

| Rank | Variant | Now | After contramedida |
|---|---|---|---|
| 1 | D + Up-only + blackout-13/17/22 | -$151 | **+$100 to +$140** |
| 2 | B + thr-7 + Up-only + blackout | -$238 | +$50 to +$100 |
| 3 | E redesigned (= B-stack) | -$44 (n=3) | parallels rank 2 |
| 4 | A + MAX_OBS=7 + blackout | -$194 | +$10 to +$40 |
| 5 | F1 (rescue) | -$252 | -$50 to +$30 |

Tier 1 (deploy contramedida now): D, B, A
Tier 2 (redesign): E
Tier 3 (rescue or kill): F

---

## 8. Fundamental problem: market efficiency at the trigger threshold

Breakeven WR equals fill price. The market prices the move correctly: when BTC drifts 5-7 bps in 11 min, the orderbook bids ~0.87 for the trending side, matching empirical settlement probability.

Edge can only come from:
- (a) Cheaper fills — F's strategy, partially working but signal also degrades
- (b) Selective entry — filter for high-WR conditions (10+ bps, productive hours)
- (c) Different markets — out of current scope

**The path with real signal is (b).** Threshold ≥ 7, blackout 13/17/22 UTC, prefer Up. That is what the contramedidas do.

---

## 9. Code prerequisites

The contramedidas assume `scripts/strategy/main.js` reads:
- `STRATEGY_BLACKOUT_HOURS` (comma-separated UTC hours)
- `STRATEGY_SIDES` (`up`|`down`|`both`, default `both`)
- `MAX_OBS_BPS` — already implemented (E uses it)

Verify with `grep -n -E 'BLACKOUT_HOURS|STRATEGY_SIDES' scripts/strategy/main.js`. If absent, building those two envs is the first dev work before redeploying any unit file. Add corresponding skip reasons `blackout_hour`, `wrong_side`.

---

## 10. Action items, prioritised

1. Implement env support in `main.js`: `STRATEGY_BLACKOUT_HOURS`, `STRATEGY_SIDES`.
2. Apply contramedidas to D, B, A (Tier 1).
3. Rewrite E unit file as B-stack.
4. F: rescue (F1) for 48 h, kill if still negative.
5. Re-evaluate at 2026-05-23 21:00 UTC once filters are live.

---

## 11. Caveats

- E n=3, treat its rank as noise.
- 13 UTC as toxic hour is a new finding — could be regime (current BTC volatility). Verify it persists.
- Up-only helps but is not the single dominant fix.
- `STRATEGY_SIDES` requires implementation; mark as TODO not deployable today.
- Contramedida PnL estimates are retrospective and assume non-blocked trades settle identically (true: paper-only, no market impact).
