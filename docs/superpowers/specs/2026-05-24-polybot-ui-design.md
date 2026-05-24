# polyBOT UI — design spec

**Date:** 2026-05-24
**Status:** Draft, awaiting user review
**Scope:** Read-only web dashboard for monitoring polyBOT paper-trading variants

## 1. Purpose

A single dashboard for seeing, at a glance, the configuration and history of every paper-trading daemon running on the Lightsail server (`44.217.72.62`). Today this information lives in three places: the `deploy/*.service` files (config), the per-variant `strategy-ledger.jsonl` and `strategy-state.json` (history + open positions), and `journalctl -u polybot-*` (live logs). The CLI tools (`status.js`, `compare.js`) surface some of it but require SSH and a shell.

The UI consolidates these sources into a browser view that updates every 15 seconds.

## 2. Goals & non-goals

**Goals:**
- Show all variants side-by-side (overview table, equivalent to `compare.js` output).
- Drill into any variant to see its full spec (env vars + ExecStart args), recent ledger entries/exits, open positions, and cumulative PnL curve.
- Tail the journalctl log of any variant without SSH.
- Stay current via 15-second browser polling.

**Non-goals (out of scope for v1):**
- Mutations: no start/stop/restart buttons. No editing service files from the UI.
- Authentication: UI binds to `127.0.0.1:8080` on the server and is reached via SSH tunnel only.
- Multi-user collaboration: single-user tool.
- Mobile / responsive: desktop-first, fixed-width layout is fine.
- Historical replay: shows what the data says now, not "rewind to last Tuesday."
- WebSocket / SSE streaming: 15-second polling is sufficient.

## 3. Architecture

```
Laptop browser --SSH tunnel--> Lightsail :8080
                                |
                                +-- polybot-ui.service (Node)
                                    +-- HTTP server on 127.0.0.1:8080
                                    +-- readers.js (pure parse functions)
                                    +-- public/{index.html, app.js, styles.css}
                                    +-- reads: deploy/*.service, data-*/ledger+state, journalctl -u
```

**Tech choices:**
- Node.js, built-ins only (`http`, `fs`, `path`, `child_process`). No npm dependencies.
- Vanilla JS frontend, no build step. Chart.js loaded once from CDN via `<script>` tag.
- systemd-managed, same pattern as the other 7 daemons.
- Binds `127.0.0.1:8080`. Accessed via `ssh -L 8080:localhost:8080 ubuntu@44.217.72.62`.

**File layout:**
```
polymarket-cli/
+-- scripts/ui/
|   +-- server.js              # HTTP server + JSON API + static file serving
|   +-- readers.js             # pure: parse ledger, service files, journalctl
|   +-- public/
|   |   +-- index.html         # shell, mounts <div id="root">
|   |   +-- app.js             # vanilla JS, hash router, polling, rendering
|   |   +-- styles.css         # ~150 lines, dark theme, monospace data
|   +-- test_readers.js        # unit tests for parsers
|   +-- test_render.js         # unit tests for frontend logic
|   +-- test_server.js         # integration tests for HTTP endpoints
|   +-- __fixtures__/          # synthetic .service + ledger files for tests
+-- deploy/
    +-- polybot-ui.service     # systemd unit
```

## 4. Components & API contract

### 4.1 Reader module (`readers.js`)

Pure functions, no global state, all take their root path as an argument so tests can pass fixture paths.

```js
listVariants(deployDir)
// Discover deploy/polybot-strategy-*.service + polybot-mastercopy*.service.
// Parse each: Environment=, ExecStart=, Description=.
// Returns: [{ label, service, description, env:{...}, args:{observeMin,threshBps,positionUsd,runtimeHours}, dataDir }]

readLedger(dataDir, { limit = 2000 })
// Stream-parse strategy-ledger.jsonl from the end.
// Returns: { records:[...lastN...], totals:{entries,exits,wins,losses,pnl,deployed,stopExits} }

readState(dataDir)
// JSON.parse strategy-state.json.
// Returns: { positions:[...openOnly...], decisionCounts:{below_threshold,fill_too_high,blackout_hour,...} }

readJournal(unitName, { lines = 200 })
// spawn journalctl -u <unit> -n <lines> --no-pager --output=short-iso
// Returns: [{ts, message}]   // unix-epoch ts + plain log line
```

### 4.2 API endpoints (all GET, all JSON)

| Path | Returns | Used by view |
|---|---|---|
| `/api/state` | `{ generatedAt, variants:[...] }` — compact aggregate of all variants with totals + cumulativePnl arrays. ~3-5kB. | Overview table + chart |
| `/api/variant/:label` | `{ spec, totals, ledger:[last200], positions:[open] }` — full data for one variant | Variant detail page |
| `/api/logs/:label?lines=200` | `{ lines:[{ts,message}], error? }` from journalctl | Logs panel |
| `/api/health` | `{ ok, uptime, lastRead:{...}, memoryUsage }` | Connectivity check, sanity drift monitoring |

**Wire-format example, `/api/state`:**
```json
{
  "generatedAt": 1779648500,
  "variants": [
    {
      "label": "d",
      "service": "polybot-strategy-d",
      "description": "BTC 15m baseline (control)",
      "env": { "MAX_FILL_PRICE": "0.92", "STRATEGY_BLACKOUT_HOURS": "13,17,22" },
      "args": { "observeMin": 11, "threshBps": 6, "positionUsd": 100, "runtimeHours": 168 },
      "dataDir": "scripts/strategy/data-d",
      "totals": { "entries": 36, "exits": 36, "wins": 31, "losses": 5, "pnl": 16.56, "deployed": 3600 },
      "openCount": 0,
      "latestExit": { "ts": 1779634800, "pnl": 16.28, "betSide": "Up", "won": true },
      "cumulativePnl": [[1779200000, 9.82], [1779287400, 42.02]]
    }
  ]
}
```

### 4.3 Frontend (`app.js`)

- Single-page-app, hash routing: `#/`, `#/variant/d`, `#/variant/k`, `#/logs/d`.
- One `<div id="root">` in `index.html`; `app.js` re-renders into it on hash change and on each poll.
- 15-second `setInterval` calls `fetchAndRender()`.
- Chart.js mounted once; updated in place by pushing new points (no destroy/recreate).
- ~200 lines including a small helper module that's `module.exports`-wrapped so Node can unit-test the pure parts (route parser, table diff helpers).

### 4.4 Layout — left sidebar (chosen during brainstorming)

```
+-----------------------------------------------------------------------------+
| polyBOT                                       o 15s . 16:42 UTC             |
+------------+----------------------------------------------------------------+
| Overview   |                                                                |
|            |   [the selected view renders here]                             |
| Variants   |                                                                |
| D          |                                                                |
| H          |                                                                |
| I          |                                                                |
| J          |                                                                |
| K          |                                                                |
| MC         |                                                                |
|            |                                                                |
| Other      |                                                                |
| Logs       |                                                                |
+------------+----------------------------------------------------------------+
```

- Sidebar is persistent across all views. Active item highlighted.
- Top-right shows poll interval and last-data timestamp; turns red if poll fails.
- Overview = compare-table + cumulative-PnL chart side-by-side (or stacked on narrow viewports).
- Variant detail = spec card (env + args, color-coded badges) + ledger table (filterable by `kind ∈ {entry, exit, skip}` plus a "stops only" toggle that filters exit rows by `stoppedOut === true`) + open positions + "view logs" link.
- Logs view is per-variant (route `#/logs/<label>`); the sidebar "Logs" entry routes to `#/logs/d` by default. The logs page also has an in-page dropdown to switch variants quickly without going back through the sidebar.

## 5. Data flow

**Initial page load**
1. Browser GETs `/`, server reads `public/index.html`.
2. Browser GETs `/static/app.js`, server reads from disk.
3. `app.js` parses `window.location.hash` (default `#/`), calls `fetchAndRender()` once.
4. `setInterval(fetchAndRender, 15000)` starts.

**Polling tick — overview view**
1. `app.js` -> GET `/api/state`.
2. `server.js`:
   - For each `deploy/polybot-*.service`: parse env + ExecStart (cached by `(path, mtimeMs)`).
   - For each `variant.dataDir`: read JSONL ledger (last 2000 lines), parse state.json, derive totals + cumulativePnl array.
   - Return aggregate.
3. `app.js` diffs old vs new state, updates table rows, pushes new points to Chart.js.

**Per-variant detail**
1. User clicks variant in sidebar -> `location.hash = "#/variant/k"`.
2. `app.js` fetches `/api/variant/k` and `/api/logs/polybot-strategy-k` in parallel.
3. Renders spec card + ledger table + logs panel.
4. Next polling tick refetches both for the open variant.

**Concurrency:** single-threaded Node event loop. `child_process.spawn(journalctl, ...)` is async and doesn't block the API. Reads are buffered per-request.

**JSONL safety:** the bot daemons append to `strategy-ledger.jsonl` continuously. POSIX append guarantees we either read a complete final line or not see it at all — never half. Plain `readFileSync` + `split('\n').filter(Boolean)` is safe.

## 6. Error handling

Read-only consumer — failures should degrade gracefully, not crash the dashboard. Never throw; always include the error in the response.

| Failure | Server response | Browser surface |
|---|---|---|
| `.service` file unparseable | `error:"parse failed"` on the variant, omit env/args | Row dimmed, `cfg?` badge |
| `data-x/` missing | `totals: zeros`, `error:"no ledger yet"` | Row + `new` badge |
| Ledger line not JSON | Skip line, increment `parseErrors` | "(n parse errors)" footnote |
| journalctl exits non-zero / >3s timeout | `{ lines:[], error:"..." }` HTTP 200 | Red banner in logs panel |
| Unit not loaded in systemd | `error:"unit not loaded"` | `down` badge on variant |
| Filesystem EACCES etc. | HTTP 500 with `{ error }`, log to stderr | Top-of-page red toast |
| `/api/state` >10s timeout | (none — browser handles) | Last-known-good + "stale Xm" banner |
| Server process dies | (none) | "UI server unreachable" banner |

**Recovery:** `polybot-ui.service` has `Restart=always`. Uncaught exceptions logged to journal. The 10s browser timeout + retry-on-next-poll covers the gap.

**Input validation:** the only user-provided input is the URL path. Variant labels are matched against `/^[a-z]{1,3}$/` before being interpolated into file paths or unit names. No shell injection vector — `child_process.spawn(journalctl, [...])` passes args as array (no shell).

## 7. Testing

| Layer | File | What it tests | Deps |
|---|---|---|---|
| Unit — readers | `test_readers.js` | Service-file parser, JSONL ledger parser, totals derivation, cumulative PnL derivation, open-position count from state.json | None — inline fixtures |
| Unit — frontend | `test_render.js` | Hash router, table-diff helper. `app.js` exports helpers via `module.exports` guard so Node can load it | None |
| Integration — HTTP | `test_server.js` | Spin up `server.js` on a random port pointed at `__fixtures__/`, hit each endpoint with `fetch`, assert JSON shape + status codes + error-degradation behavior | Node http only |
| Smoke — live | manual checklist | `curl /api/health`, open via tunnel, click every variant, intentionally rename a ledger file and confirm graceful error | One-time post-deploy |

**Fixture tree (`scripts/ui/__fixtures__/`):**
```
deploy/
  polybot-strategy-d.service              # 2 env vars, 4 ExecStart args (valid baseline)
  polybot-strategy-malformed.service      # missing Environment= line (graceful-degrade case)
  polybot-mastercopy.service              # mastercopy schema (kind:"mirror" path coverage)
scripts/strategy/data-d/
  strategy-ledger.jsonl                   # 5 entries + 5 exits + 2 skips
  strategy-state.json                     # 1 open position
scripts/mastercopy/data-mc/
  strategy-ledger.jsonl                   # 1 mirror + 1 exit
```

**Cross-check:** the integration test additionally invokes `compare.js` against the same fixtures and asserts `/api/state` totals are byte-identical to `compare.js` numbers for the strategy-* variants. Note `compare.js` discovers only `polybot-strategy-*.service` files (regex in `compare.js:30`), so this cross-check covers the strategy variants but NOT mastercopy — the mastercopy totals are verified in `test_readers.js` directly against the fixture ledger instead.

## 8. Acceptance criteria for v1 ship

- All unit and integration tests pass (`node scripts/ui/test_readers.js && node scripts/ui/test_render.js && node scripts/ui/test_server.js`).
- `curl http://localhost:8080/api/state` on the server returns valid JSON with 7+ variants, no `error:` fields under normal conditions.
- Browser opened via SSH tunnel renders the overview within 1 second of page load.
- Clicking each variant in the sidebar successfully loads its detail page within 1 second.
- Logs panel scrolls live (15s polling) and shows the same lines as `journalctl -u <unit> -n 200 --no-pager`.
- `/api/state` totals match `compare.js` output exactly.
- Manual smoke list passes: rename a ledger -> "no ledger yet" badge appears within 15s; restore -> row recovers within 15s.

## 9. Deployment

- New systemd unit `deploy/polybot-ui.service` runs `node /opt/polybot/polymarket-cli/scripts/ui/server.js`.
- `User=polybot`. No `ReadWritePaths=` (the UI never writes). `ProtectSystem=full` + `ProtectHome=read-only` handle the rest of the sandboxing, matching the other daemons.
- Port `127.0.0.1:8080`, never exposed publicly.
- `redeploy.sh`'s `discover_services()` extra-loop gains a `polybot-ui` entry (one-line change, documented in `lightsail-polybot-server.md` gotcha).
- Access: `ssh -L 8080:localhost:8080 ubuntu@44.217.72.62`, then `http://localhost:8080` in browser.

## 10. Open questions / future work

These are NOT in scope for v1 but worth noting so we don't paint ourselves into a corner:

- **Mutation endpoints** (start/stop daemons) would need auth — defer until needed.
- **Real-time push** (SSE for logs) — defer until 15s polling proves insufficient.
- **Historical comparison** ("D yesterday vs D today" diff view) — defer.
- **Mobile-friendly layout** — defer, desktop-only is fine for single-user dashboard.
- **`mastercopy-sells` and other retired daemons** — `listVariants()` enumerates ALL `.service` files in `deploy/`; the UI annotates `is-active=inactive` ones with a "stopped" badge. Visibility into retired variants preserves context.

## 11. References

- Existing tools: `scripts/strategy/status.js`, `scripts/strategy/compare.js` (source-of-truth for totals).
- Service patterns: any `deploy/polybot-strategy-*.service` for systemd skeleton.
- Server gotchas: memory `lightsail-polybot-server`.
- Microstructure context: memory `polymarket-15m-master-microstructure`.
