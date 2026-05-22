# Phase 3 strategy design — 5 instances, parallel tracks

**Date:** 2026-05-21
**Premise:** All 5 current directional variants (A/B/D/E/F) are net-negative because the bot is a TAKER paying efficient ask prices (~$0.86), while the masters are laddering MAKERS averaging $0.40-0.56. The directional thesis at obs-11/13 is structurally negative-EV. See [[polymarket-15m-master-microstructure]].

**Track 1 budget:** unlimited paper funds (user assumption). Real-money pivot considered later.

**Server constraint:** max 5 strategy instances + 1 snapshot daemon.

---

## 1. Retire / keep

| Slot | Current | Action | Rationale |
|---|---|---|---|
| polybot-strategy-a | obs-13/thr-5 | RETIRE | No filter stack salva A. -$194 net. |
| polybot-strategy-b | obs-11/thr-5 | RETIRE | Supersedida por D + blackout. |
| polybot-strategy-d | obs-11/thr-6/fill≤0.92 | KEEP, reconfigure | Mejor directional. +$248 retro con blackout. |
| polybot-strategy-e | obs-11/thr-5/obs≤7 | REPLACE | Diseño backwards. |
| polybot-strategy-f | obs-9/thr-4/fill≤0.85 | REPLACE | -$252. Hipótesis fresh-fill no se sostiene. |
| polybot-snapshot | research | KEEP | Sigue capturando books. |

## 2. New slot layout

| Slot | Name | Track | Mercado | Estrategia | Engineering |
|---|---|---|---|---|---|
| D | polybot-strategy-d | baseline directional control | btc-updown-15m | obs-11/thr-6/fill≤0.92 + blackout 13,17,22 UTC | env edit |
| G | polybot-strategy-g | redirect (4) | btc-updown-5m | mismo directional, observe adaptado | nuevo daemon basado en main.js |
| H | polybot-strategy-h | redirect (4) | eth-updown-15m | mismo directional, asset distinto | param slug-prefix + eth_price.js |
| MM | polybot-marketmake | market making (1) | btc-updown-15m | laddered limit BUYs ambos lados | daemon nuevo + CLOB orders |
| MC | polybot-mastercopy | counter-master | btc-updown-15m | mirror cE25 BUYs $1 paper | daemon nuevo (data-api poll) |

---

## 3. Spec por instancia

### D — directional baseline (control)

```ini
ExecStart=/usr/bin/node main.js 11 6 100 168
Environment=MAX_FILL_PRICE=0.92
Environment=STRATEGY_BLACKOUT_HOURS=13,17,22
```

`STRATEGY_SIDES` no se setea (= both). Up-only se descartó como no-significativa.

Sirve como control. Si en 7 días no cruza breakeven con blackout, kill.

---

### G — 5m directional (track 4)

**Hipótesis:** El 5m tiene fees 0%, spreads más estrechos, 3× más slots/hora → si hay edge directional, debería aparecer más limpio que en 15m.

**Adaptaciones para 5m:**
- Slot = 5 min = 300 seg.
- Observe minute relativo. 15m bot observa min 11/15 = 73%. Equivalente 5m = 3.65 min. Round a 3 o 4.
- Threshold bps: BTC se mueve menos en 5 min. Reducir a ~3 bps inicial.
- Slugs: `btc-updown-5m-<EPOCH>`.

Decisión inicial: `observe=3, thr=3, fill≤0.92`.

**Engineering:**
- Generalize `cur15m = now - (now % 900)` → `cur_slot = now - (now % SLOT_SECS)`
- New envs `STRATEGY_SLUG_PREFIX=btc-updown-5m-`, `STRATEGY_SLOT_SECS=300`
- Settlement check sin cambios (mismo gamma)

**Risk:** los masters en 5m (Bonereaper) entran en los últimos 30 seg. La window observe-3 nos pone 2 min antes del master → fills probablemente caros. Si pasa, probar observe=4 (último minuto).

---

### H — ETH 15m (track 4 redirect)

**Hipótesis:** ETH-15m menos saturado por arbitrage → tal vez fills más amigables.

**Adaptaciones:**
- BTC price source → ETH price source. Coinbase + Kraken median sobre ETH/USD.
- Slug prefix `eth-updown-15m-`.
- ETH es más volátil → thr=8-10 bps.

Engineering: param slug-prefix + new oracle file `eth_price.js`.

---

### MM — Market making (track 1, fondos ilimitados)

**Hipótesis (validada empíricamente con cE25):**
Colocar limit BUY orders escalonadas en ambos lados a $0.05/$0.15/$0.30/$0.50, esperar que takers desesperados nos paguen, holdear a settlement, capturar spread + payoff asimétrico de cola.

**Spec del daemon `marketmake.js`:**

```text
Por slot btc-updown-15m que abra:
  En minuto 1, calcular tokenId_Up y tokenId_Down
  Para cada lado:
      Place limit BUY orders a precios [0.05, 0.10, 0.20, 0.35, 0.50]
      Size por nivel: $200. Total = $1000/lado, $2000/slot.
  En minuto 14, cancel orders no llenadas
  Sumar fills → posiciones por lado
  Hold a settlement
  PnL = winning_side_shares × $1 - cost_basis_both_sides

Ledger schema (data-mm/strategy-ledger.jsonl):
  {kind:"order_placed", ts, slug, side, price, size, orderId(synth)}
  {kind:"fill", ts, slug, side, price, shares, cost}
  {kind:"order_canceled", ts, slug, side, price, unfilledSize}
  {kind:"settlement", ts, slug, winner, upShares, downShares, totalCost, payout, pnl}
```

**Paper-mode fill simulator:**

Sin órdenes reales en paper:
1. Pollear `clob book` cada N segundos durante el slot.
2. Si nuestro limit BUY price ≥ best ASK actual → fill instantáneo a nuestro price.
3. Si nuestro limit BUY price < best ASK → orden resting. Fill solo si otro trader vende cruzando nuestro nivel.
   - Sin order-by-order data, aproximar con `data-api /trades?market=<slug>` filtrando SELL prints.
   - Fallback simplista: fill 30% del size de cada SELL print al precio más alto ≤ nuestra orden (conservador).

**Math expected:**
- Per slot deployed $2000, get fills averaging ~$0.30 → ~6666 shares spread Up/Down
- Settle ~52% wins: 6666 × $0.50 × 0.52 × $1 = +$1733 win revenue, costs ~$2000 → +$100/slot net
- 96 slots/day → +$9600/day max teórico
- Reality much lower

Target paper: +$50-200/día. Si funciona, plan Phase 4 (real money).

**Risks:**
- Adverse selection: takers vendiendo cheap es porque BTC se movió → caché un panic seller cuyo lado va a perder. Necesita stop-loss por slot.
- Cancel-replace: cuando BTC se mueve mid-slot, nuestra orden a $0.50 en el lado favorito quedó sub-mid (stale). Cancel y re-price. Adds complejidad.
- Paper sim puede over-attribute fills. Validar con micro-test real antes de scale.

---

### MC — Master copy (counter-master experimental)

**Hipótesis:** copiar cE25's BUYs en 15m a $1 size, paper-only, en near-realtime. Si genera PnL → edge replicable por copia. Si no → confirma que el master gana por SER maker, no por la dirección de sus trades.

**Spec del daemon `mastercopy.js`:**

```text
Cada 30 seg:
  Pollear data-api /trades?user=0xce25e2...&limit=20
  Filtrar btc-updown-15m, side=BUY, timestamp > last_seen
  Para cada trade nuevo:
    Simular nuestra entrada al MISMO price que pagó él
    Size: $1 (constant, $1000 daily cap)
    Append ledger
  Cada slot resuelto: settle, compute PnL

Comparison: nuestro paper PnL / (master PnL × 0.07)
  0.07 = $1/$14 size ratio
Si paper iguala scaled master → edge replicable
Si paper falla → master's edge is in his maker flow, not directional
```

**Risks:**
- Latency 30s → perdemos los fills de mejor precio. El master entra a $0.05, nosotros pollemos 30s después y el book ya está a $0.25.
- Tail bets a $0.01 — el master los ganó porque su orden estaba colocada hace 10 min. Nosotros llegamos tarde. Si MC pierde sistemáticamente, **confirma que ser maker es lo único que importa**.

---

## 4. Engineering order

| Sprint | Item | Effort | Output |
|---|---|---|---|
| 1 | Edit `polybot-strategy-d.service` add blackout env, restart | 5 min | D running fixed |
| 2 | Retire A, B, E, F services (stop + disable, keep unit files) | 5 min | server 1 strategy + snapshot |
| 3 | Generalize `main.js` to accept `STRATEGY_SLUG_PREFIX` + `STRATEGY_SLOT_SECS` envs | 2-3 h | uno daemon soporta 15m/5m, BTC/ETH |
| 4 | Add `eth_price.js` oracle module | 30 min | ETH variants viable |
| 5 | Create `polybot-strategy-g` (5m BTC) and `polybot-strategy-h` (15m ETH) units | 10 min | 3 directional running |
| 6 | Build `scripts/marketmake/main.js` + paper-fill simulator | 1-2 días | MM running paper |
| 7 | Build `scripts/mastercopy/main.js` daemon | 4-6 h | MC running paper |
| 8 | 48 h después: pull ledgers, compute comparative WR/PnL/EV, decide Phase 4 | 1 h | Phase 4 plan |

---

## 5. Counter-master analysis

User asked: "knowing the master strategy, can we exploit it?"

Three candidates:

**(a) Frontrun master cancel-replace:**
Cuando BTC se mueve, masters cancelan-reemplazan orders stale. Con oracle más rápido (~50ms ahead) podríamos pick-off bids stales antes del cancel.
**Verdict:** infeasible a nuestra latencia. Server us-east-1, CLOB probablemente NJ/NY. Necesitaríamos co-located infra. Phase 5 maybe; not now.

**(b) Adverse-select master via informed flow:**
Cuando tengamos signal más fuerte (10+ bps drift cases), podríamos vender el lado favorito al master. Pero **no se puede shortear en Polymarket binaries** — solo comprar outcome tokens.
Podemos comprar el OTRO lado al ask del master. Si está pidiendo $0.85 Up (favorito), también pide $0.15 Down. Comprar Down a $0.15 si creemos Down. = nuestra estrategia direccional actual con math negativo.
**Verdict:** no exploit, reframing.

**(c) Compete en market making:**
Ser MAKER nosotros. No "exploit" — supply liquidez en paralelo. Spreads más tight donde master está thin.
**Verdict:** esto es track 1. La respuesta correcta.

**Conclusión:** el único exploit sostenible es JOIN them, no fight. Track 1 ya lo cubre.

---

## 6. Kill criteria (48 h)

| Instance | Kill criterion |
|---|---|
| D | Si PnL < -$50 → kill (blackout debía arreglar esto) |
| G (5m) | Avg fill > 0.80 OR WR < 70% → kill |
| H (ETH) | Si PnL ≤ D's PnL → kill (no edge over BTC) |
| MM | Paper PnL < -$200 → debug sim; < -$500 → kill |
| MC | Si PnL diverge >50% del master scaled → o copy works o master needs maker flow → decidir |

---

## 7. Open questions

1. ¿Los datos del legacy 5m bot existen en `data/bot-ledger.jsonl` del server? Si sí, evidencia histórica antes de redeploy. Revisar.
2. ¿Bid-ask spread real de `clob book` a minuto 11 vs ask actual? Test rápido para cuantificar el upside de limit vs market.
3. ¿Los masters trade ETH-15m también? Si sí, la maker thesis aplica también; si no, ETH-15m podría tener edge direccional sin squeeze. Quick check de ohanism/cE25 en ETH.
