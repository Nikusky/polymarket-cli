# Análisis A/B/C paper trading — 2026-05-20

**Ventana observada:** ~11 horas desde el arranque (muestra MUY chica, no concluyente).

## Configuración

| Var | Observe min | Threshold (bps) | $/trade |
|-----|-------------|-----------------|---------|
| A (control) | 13 | 5 | 100 |
| B (earlier) | 11 | 5 | 100 |
| C (higher thr) | 13 | 10 | 100 |

## Resultados

| Métrica | A | B | C |
|---|---|---|---|
| Entries | 3 | 9 | **0** |
| Exits (W/L) | 2W/1L | 8W/1L | — |
| Win rate | 66.7% | **88.9%** | — |
| PnL realizado | **-$85.69** | -$22.59 | $0 |
| ROI sobre deployed | -28.6% | -2.5% | — |
| Avg fill price | 0.939 | 0.901 | — |
| Median fill | 0.936 | 0.926 | — |
| Fill range | 0.93–0.95 | 0.80–0.95 | — |
| Skips below_threshold | 22 | 24 | **35** |
| obsBps promedio | 2.5 | -0.3 | — |

## Lectura clave (break-even = win rate)

Como cada paper buy paga `fillPrice` para ganar 1.0 si acierta, **break-even** ocurre cuando `avg fill = win rate`.

- **A:** WR 0.667 vs fill 0.939 → edge **-0.27** (catastrófico). Las ganancias por acertar (1-0.94)=$0.06/sh no compensan la pérdida del 33% de losses.
- **B:** WR 0.889 vs fill 0.901 → edge **-0.012** (casi breakeven). Si WR sube a 91-92% o fills bajan a 0.86, gira a positivo.
- **C:** Sin entries. El threshold de 10bps filtra todas las señales del día — muestra que el régimen actual de BTC no produce movimientos > 10bps en los minutos previos al cierre. **No es estrategia mala, es muestra cero.**

## Diagnóstico

1. **B es la única viable hoy.** WR 88.9% se acerca al backtest (95.98%) y a los masters (81-85%). El problema no es el edge, son los **fills demasiado altos** (mediana 0.93, muy lejos del 0.60-0.68 de los masters).
2. **A subentrega** por dos razones: muestra de 3 trades + observe-13 deja menos book disponible que observe-11. Probablemente converge a algo parecido a B con más data, pero hoy queda peor.
3. **C necesita régimen de mayor volatilidad** o bajar threshold a 7-8 bps. Sin entries en 11h, no aprende nada.
4. **Fills caros son el cuello de botella** en las 3 variantes. Confirma la hipótesis de la nota del 2026-05-19: o llegamos tarde al book o la competencia se comió los precios baratos.

## Recomendación

- **Demasiado temprano para decidir** (gate del día 7 es ~450 trades; llevamos 12).
- Dejar corriendo 48h más antes de re-evaluar.
- Si en 48h los fills medianos de A y B siguen > 0.85, probar **variante D: observe minute 10, threshold 5 bps** para anticiparse a la compresión del book.
- C: considerar bajarlo a 7 bps para que produzca algún sample, sino lo apagamos al día 3.

## Fuentes
- `analysis/strategy-ledger-{a,b,c}.jsonl` (pulled vía scp 2026-05-20)
- `status.js` output corrido en server por variante

---

## Update 2026-05-20: C descartada, reemplazada por D

**Por qué se descarta C** (`min 13, threshold 10 bps`):
- 0 entries en 11h vs 35 skips `below_threshold`. El régimen actual de BTC no produce drifts > 10 bps a minuto 13.
- Sin entries → no aprende nada, no aporta señal experimental. No es "estrategia conservadora útil", es estrategia muda.

**D = "B refined"**: `observe 11, threshold 6 bps, MAX_FILL_PRICE 0.92, $100/trade`. Hereda de B la ventaja del observe-11 (más entries, mejores fills), y agrega dos filtros derivados del análisis de losses:

| Filtro | Justificación |
|---|---|
| `threshold 6 bps` (vs B=5) | La única loss de B (02:26) entró con obs=5.53 — señal apenas sobre el threshold. Subir 1 bp habría evitado esa loss en este sample. |
| `MAX_FILL_PRICE 0.92` (vs B=0.95) | La única loss de A (05:43) entró con fill=0.95 — matemáticamente no podía ganar dinero aún con WR alto. Cap a 0.92 mata el peor caso. |

Una sola variable nueva por vez (D vs B) para que el comparativo en 48-72h aísle el efecto.

**Cambios de código:**
- `scripts/strategy/main.js`: nuevo env `MAX_FILL_PRICE` (default 0.95, preserva A/B). Skip `fill_too_high` ahora también escribe al ledger.
- `deploy/polybot-strategy-c.service`: eliminado.
- `deploy/polybot-strategy-d.service`: nuevo.
