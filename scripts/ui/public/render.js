// Pure helpers for the polyBOT UI frontend. DOM-free so they can be unit-tested
// in Node. Loaded in the browser via <script src="/static/render.js"> and exposed
// on window.polybotRender.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.polybotRender = api;
}(typeof window !== 'undefined' ? window : globalThis, function () {

  function parseHash(hash) {
    if (!hash || hash === '#/' || hash === '#') return { view: 'overview' };
    if (hash === '#/compare' || hash === '#/compare/') return { view: 'compare' };
    const m = hash.match(/^#\/(variant|logs)\/([a-z]{1,12}(?:-[a-z]+)?)$/);
    if (!m) return { view: 'overview' };
    return { view: m[1], label: m[2] };
  }

  function formatPnl(n) {
    if (n === 0) return '$0.00';
    const sign = n > 0 ? '+' : '-';
    return `${sign}$${Math.abs(n).toFixed(2)}`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  // Three operational states for a live executor (mode === 'live'):
  //   'armed'    — service active, DRY_RUN!=true  → placing real orders
  //   'dry_run'  — service active, DRY_RUN==true  → logs only, no real orders
  //   'disarmed' — service inactive               → not running
  // Returns null for non-live variants (use mode-off/mode-paper instead).
  function liveArmState(v) {
    if (!v || v.mode !== 'live') return null;
    if (!v.serviceActive || v.serviceActive !== 'active') return 'disarmed';
    const dryRun = String((v.env && v.env.DRY_RUN) || '').toLowerCase() === 'true';
    return dryRun ? 'dry_run' : 'armed';
  }

  function liveArmBadge(v) {
    const s = liveArmState(v);
    if (s === 'armed')    return `<span class="badge mode-armed" title="placing real CLOB orders">ARMED</span>`;
    if (s === 'dry_run')  return `<span class="badge mode-dry-run" title="DRY_RUN=true: logs WOULD-BUY/WOULD-SELL but does not trade">DRY RUN</span>`;
    if (s === 'disarmed') return `<span class="badge mode-disarmed" title="systemctl is-active: ${escapeHtml(v.serviceActive || 'inactive')}">DISARMED</span>`;
    return '';
  }

  // Renders a labelled overview section (Live or Paper) wrapping the standard
  // overview table. Returns '' when `variants` is empty so the caller can
  // simply concat both sections without an empty-section check.
  function buildOverviewSection(title, variants, opts) {
    if (!variants || variants.length === 0) return '';
    const note = opts && opts.note ? `<span class="muted section-note">${escapeHtml(opts.note)}</span>` : '';
    const cls = opts && opts.cls ? ` ${opts.cls}` : '';
    const rows = variants.map(buildOverviewRow).join('');
    return `<section class="overview-section${cls}">` +
      `<h3 class="section-title">${escapeHtml(title)} ${note}</h3>` +
      `<table><thead><tr><th>Variant</th><th>Exits</th><th>WR</th><th>PnL</th><th>Deployed</th><th>Open</th><th>Description</th></tr></thead>` +
      `<tbody>${rows}</tbody></table>` +
      `</section>`;
  }

  function buildOverviewRow(v) {
    const t = v.totals || {};
    const wr = t.exits > 0 ? `${(t.wins / t.exits * 100).toFixed(1)}%` : '-';
    const pnlClass = (t.pnl || 0) >= 0 ? 'pos' : 'neg';
    const errBadge = v.error ? `<span class="badge err" title="${escapeHtml(v.error)}">${escapeHtml(v.error.slice(0,8))}</span>` : '';
    // Live executors get a three-state badge (ARMED / DRY RUN / DISARMED);
    // paper variants get OFF only when their service is inactive.
    const activeBadge = v.mode === 'live'
      ? liveArmBadge(v)
      : (v.serviceActive && v.serviceActive !== 'active'
          ? `<span class="badge mode-off" title="systemctl is-active: ${escapeHtml(v.serviceActive)}">OFF</span>`
          : '');
    const lastErr = (v.recentErrors && v.recentErrors[0]) || null;
    const errCountTip = lastErr
      ? `${t.errors} ledger error${t.errors === 1 ? '' : 's'} — last: ${lastErr.failedCall || ''} ${lastErr.httpStatus ? 'http=' + lastErr.httpStatus + ' ' : ''}${lastErr.error || ''}`.trim()
      : `${t.errors || 0} ledger errors`;
    const errCountBadge = (t.errors || 0) > 0
      ? `<span class="badge err" title="${escapeHtml(errCountTip)}">!${t.errors}</span>`
      : '';
    return `<tr data-label="${escapeHtml(v.label)}">` +
      `<td class="label-cell">${escapeHtml(v.label.toUpperCase())} ${activeBadge}${errBadge}${errCountBadge}</td>` +
      `<td>${t.exits || 0} (${t.wins || 0}W/${t.losses || 0}L)</td>` +
      `<td>${wr}</td>` +
      `<td class="${pnlClass} num">${formatPnl(t.pnl || 0)}</td>` +
      `<td class="num">$${(t.deployed || 0).toFixed(0)}</td>` +
      `<td class="num">${v.openCount || 0}</td>` +
      `<td class="muted">${escapeHtml((v.description || '').slice(0, 60))}</td>` +
      `</tr>`;
  }

  function buildVariantSpec(v) {
    const envRows = Object.entries(v.env || {}).map(([k, val]) =>
      `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(val)}</dd>`).join('');
    const args = v.args || {};
    // For live executors the operational-state badge (ARMED / DRY RUN /
    // DISARMED) already implies live mode, so a separate LIVE label is
    // redundant. Paper variants still get the explicit PAPER badge.
    const modeBadge = v.mode === 'live'
      ? ''
      : `<span class="badge mode-paper" title="simulated fills">PAPER</span>`;
    const activeBadge = v.mode === 'live'
      ? liveArmBadge(v)
      : (v.serviceActive && v.serviceActive !== 'active'
          ? `<span class="badge mode-off" title="systemctl is-active: ${escapeHtml(v.serviceActive)}">OFF</span>`
          : '');
    return `<section class="spec">` +
      `<h3>${escapeHtml((v.label || '').toUpperCase())} ${modeBadge}${activeBadge} - ${escapeHtml(v.service || '')}</h3>` +
      `<p class="muted">${escapeHtml(v.description || '')}</p>` +
      `<dl>` +
      `<dt>observeMin</dt><dd>${args.observeMin ?? '?'}</dd>` +
      `<dt>threshBps</dt><dd>${args.threshBps ?? '?'}</dd>` +
      `<dt>positionUsd</dt><dd>${args.positionUsd ?? '?'}</dd>` +
      `<dt>runtimeHours</dt><dd>${args.runtimeHours ?? '?'}</dd>` +
      envRows +
      `</dl>` +
      `</section>`;
  }

  function buildLedgerTable(records, filter) {
    const rows = (records || []).filter(r => {
      if (!filter || filter === 'all') return true;
      if (filter === 'stops') return r.kind === 'exit' && r.stoppedOut === true;
      return r.kind === filter;
    }).slice(-200).reverse();
    if (!rows.length) return `<p class="muted">No records.</p>`;
    return `<table class="ledger"><thead><tr><th>ts</th><th>kind</th><th>slug</th><th>side</th><th>fill/pnl</th></tr></thead><tbody>` +
      rows.map(r => {
        const ts = new Date((r.ts || 0) * 1000).toISOString().slice(5,16).replace('T',' ');
        const slug = (r.slug || '').slice(-12);
        const isLiveShape = r.kind === 'live' || r.filledShares != null || r.filledUsd != null;
        const side = r.betSide || r.tradeSide || (isLiveShape ? 'BUY' : r.outcome) || '';
        let detail = '';
        if (r.kind === 'entry') {
          detail = `@${Number(r.avgFillPrice||0).toFixed(3)} x ${Number(r.paperShares||0).toFixed(1)}sh`;
        } else if (r.kind === 'mirror') {
          const px = r.masterPrice != null ? Number(r.masterPrice) : Number(r.avgFillPrice||0);
          detail = `@${px.toFixed(3)} x ${Number(r.paperShares||0).toFixed(1)}sh`;
        } else if (r.kind === 'live') {
          detail = `@${Number(r.avgFillPrice||0).toFixed(3)} x ${Number(r.filledShares||0).toFixed(2)}sh`;
        } else if (r.kind === 'exit') {
          detail = `${r.won ? 'WIN' : 'LOSS'} ${formatPnl(r.pnl||0)}${r.stoppedOut ? ' STOP' : ''}`;
        } else if (r.kind === 'error') {
          const tag = r.failedCall ? `[${r.failedCall}${r.httpStatus ? ' http=' + r.httpStatus : ''}] ` : '';
          const msg = String(r.error || '').slice(0, 80);
          detail = escapeHtml(tag + msg);
        } else if (r.kind === 'paper_skip') {
          const bps = typeof r.retBps === 'number' ? ` ${r.retBps.toFixed(2)}bps` : '';
          detail = `paper:${escapeHtml(r.reason || '?')}${bps}`;
        } else {
          detail = `reason=${escapeHtml(r.reason || '?')}`;
        }
        const rowClass = r.kind === 'error' ? ' class="ledger-error"' : '';
        const rowTitle = r.kind === 'error' && r.responseBody
          ? ` title="${escapeHtml(String(r.responseBody).slice(0, 400))}"`
          : '';
        return `<tr${rowClass}${rowTitle}><td>${ts}</td><td>${escapeHtml(r.kind)}</td><td class="muted">${escapeHtml(slug)}</td><td>${escapeHtml(side)}</td><td class="num">${detail}</td></tr>`;
      }).join('') +
      `</tbody></table>`;
  }

  function buildPositionsTable(positions) {
    if (!positions || !positions.length) return '';
    const rows = positions.map(p => {
      const slug = (p.slug || '').slice(-16);
      const isLiveShape = p.filledShares != null || p.filledUsd != null;
      const side = p.betSide || p.tradeSide || (isLiveShape ? 'BUY' : p.outcome) || '';
      const px = p.avgFillPrice != null ? Number(p.avgFillPrice)
               : p.masterPrice != null ? Number(p.masterPrice) : null;
      const shares = Number(p.paperShares ?? p.filledShares ?? 0);
      const cost = Number(p.paperCost != null ? p.paperCost
                       : p.filledUsd != null ? p.filledUsd
                       : px != null ? px * shares : 0);
      const opened = p.openTs ? new Date(p.openTs * 1000).toISOString().slice(5,16).replace('T',' ') : '-';
      const resolves = p.resolveTs ? new Date(p.resolveTs * 1000).toISOString().slice(5,16).replace('T',' ') : '-';
      return `<tr>` +
        `<td class="muted">${escapeHtml(slug)}</td>` +
        `<td>${escapeHtml(side)}</td>` +
        `<td class="num">${px != null ? px.toFixed(3) : '-'}</td>` +
        `<td class="num">${shares.toFixed(2)}</td>` +
        `<td class="num">$${cost.toFixed(2)}</td>` +
        `<td class="muted">${opened}</td>` +
        `<td class="muted">${resolves}</td>` +
        `</tr>`;
    }).join('');
    return `<h3>Open positions (${positions.length})</h3>` +
      `<table class="ledger"><thead><tr>` +
      `<th>slug</th><th>side</th><th>price</th><th>shares</th><th>cost</th><th>opened</th><th>resolves</th>` +
      `</tr></thead><tbody>${rows}</tbody></table>`;
  }

  function buildLogsList(lines) {
    if (!lines || !lines.length) return `<p class="muted">No log lines.</p>`;
    return `<pre class="logs">` + lines.map(l => {
      const t = new Date((l.ts || 0) * 1000).toISOString().slice(11, 19);
      return `<span class="ts">${t}</span>  ${escapeHtml(l.message)}`;
    }).join('\n') + `</pre>`;
  }

  // PnL range windowing.
  //
  // `spec` is one of: 'all' | '24h' | '7d' | '30d' | '<datetime-local-string>' | null.
  // Storing the preset name (instead of a frozen timestamp) keeps "last 24h"
  // sliding forward across the 15s poll cycle.
  const PRESET_SECONDS = { '24h': 86400, '7d': 7 * 86400, '30d': 30 * 86400 };

  function resolveSince(spec, nowMs) {
    if (spec == null || spec === '' || spec === 'all') return null;
    const now = Math.floor((nowMs || Date.now()) / 1000);
    if (Object.prototype.hasOwnProperty.call(PRESET_SECONDS, spec)) {
      return now - PRESET_SECONDS[spec];
    }
    const t = Date.parse(spec);
    if (isNaN(t)) return null;
    return Math.floor(t / 1000);
  }

  function emptyTotals() {
    return { entries: 0, exits: 0, wins: 0, losses: 0, stopExits: 0, pnl: 0, deployed: 0, errors: 0, paperSkips: 0 };
  }

  function entryCost(r) {
    return Number(
      r.paperCost
      ?? r.paperSize
      ?? r.filledUsd
      ?? (r.masterPrice != null && r.paperShares != null ? r.masterPrice * r.paperShares : 0)
    ) || 0;
  }

  // Mirrors readers.readLedger's totals/cumulativePnl logic, but applies an
  // optional `sinceTs` filter (unix seconds) and re-zeros running PnL at the
  // window start. Pure: no DOM, no I/O.
  function windowTotals(records, sinceTs) {
    const totals = emptyTotals();
    const cumulativePnl = [];
    let running = 0;
    for (const r of (records || [])) {
      if (sinceTs != null && Number(r.ts || 0) < sinceTs) continue;
      if (r.kind === 'entry' || r.kind === 'mirror' || r.kind === 'live') {
        totals.entries++;
        totals.deployed += entryCost(r);
      } else if (r.kind === 'exit') {
        totals.exits++;
        if (r.won === true) totals.wins++;
        else totals.losses++;
        if (r.stoppedOut === true) totals.stopExits++;
        const pnl = Number(r.pnl ?? 0);
        totals.pnl += pnl;
        running += pnl;
        cumulativePnl.push([r.ts, Math.round(running * 100) / 100]);
      } else if (r.kind === 'error') {
        totals.errors++;
      } else if (r.kind === 'paper_skip') {
        totals.paperSkips++;
      }
    }
    totals.pnl = Math.round(totals.pnl * 100) / 100;
    totals.deployed = Math.round(totals.deployed * 100) / 100;
    return { totals, cumulativePnl };
  }

  function buildRangeLabel(sinceTs) {
    if (sinceTs == null) return 'all-time';
    const iso = new Date(sinceTs * 1000).toISOString();
    return 'since ' + iso.slice(0, 16).replace('T', ' ') + 'Z';
  }

  function buildRangePicker(spec) {
    const active = spec == null || spec === '' ? 'all' : spec;
    const presets = [
      ['all', 'All'],
      ['24h', '24h'],
      ['7d',  '7d'],
      ['30d', '30d'],
    ];
    const isCustom = active !== 'all' && !Object.prototype.hasOwnProperty.call(PRESET_SECONDS, active);
    const customVal = isCustom ? String(active).slice(0, 16) : '';
    const buttons = presets.map(([k, lbl]) =>
      `<button class="range-btn${active === k ? ' active' : ''}" data-since="${k}">${lbl}</button>`
    ).join('');
    return `<div class="toolbar range-picker" data-role="range">` +
      `<span class="muted">PnL since:</span>` +
      buttons +
      `<input type="datetime-local" id="range-custom" value="${escapeHtml(customVal)}" step="60">` +
      `<button class="range-btn${isCustom ? ' active' : ''}" id="range-apply">Apply</button>` +
      `<span class="muted range-label">${escapeHtml(buildRangeLabel(resolveSince(active)))}</span>` +
      `</div>`;
  }

  // ---- Comparison metrics (pure) ---------------------------------------------

  // Max peak-to-trough decline on a cumulativePnl series [[ts_sec, runningPnl], ...].
  // Returns a non-negative number in $ (0 when there is one or fewer points,
  // or the series only goes up).
  function maxDrawdown(cumulativePnl) {
    if (!cumulativePnl || cumulativePnl.length < 2) return 0;
    let peak = -Infinity;
    let worst = 0;
    for (const point of cumulativePnl) {
      const v = Number(point[1] ?? 0);
      if (v > peak) peak = v;
      const dd = peak - v;
      if (dd > worst) worst = dd;
    }
    return Math.round(worst * 100) / 100;
  }

  // Bucket exit PnLs by UTC day → daily $ series, then return summary stats.
  // Days with no exits are skipped (so a 2-week 3-trade variant returns the
  // 3 trade-days, not 14 zeros — this keeps Sharpe meaningful on sparse data).
  function dailyPnlStats(records) {
    const byDay = new Map();
    for (const r of (records || [])) {
      if (r.kind !== 'exit') continue;
      const ts = Number(r.ts || 0);
      if (!ts) continue;
      const day = new Date(ts * 1000).toISOString().slice(0, 10);
      const pnl = Number(r.pnl || 0);
      byDay.set(day, (byDay.get(day) || 0) + pnl);
    }
    if (byDay.size === 0) {
      return { days: 0, bestDay: 0, worstDay: 0, sharpe: null };
    }
    const values = [...byDay.values()];
    const best = Math.max(...values);
    const worst = Math.min(...values);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    let sharpe = null;
    if (values.length >= 2) {
      const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (values.length - 1);
      const sd = Math.sqrt(variance);
      sharpe = sd > 0 ? mean / sd : null;
    }
    return {
      days: byDay.size,
      bestDay: Math.round(best * 100) / 100,
      worstDay: Math.round(worst * 100) / 100,
      sharpe,
    };
  }

  // Risk panel data for one variant.
  function computeRiskMetrics(cumulativePnl, records) {
    return {
      maxDrawdown: maxDrawdown(cumulativePnl),
      ...dailyPnlStats(records),
    };
  }

  // Per-trade panel data for one variant. Walks exits to compute avg win, avg
  // loss, payoff ratio, and the current consecutive W/L streak (e.g. "5W").
  function computePerTradeMetrics(totals, records) {
    const t = totals || {};
    const exits = (records || []).filter(r => r.kind === 'exit');
    let winSum = 0, winN = 0, lossSum = 0, lossN = 0;
    for (const r of exits) {
      const pnl = Number(r.pnl || 0);
      if (r.won === true) { winSum += pnl; winN++; }
      else { lossSum += pnl; lossN++; }
    }
    const avgWin = winN > 0 ? winSum / winN : 0;
    const avgLoss = lossN > 0 ? lossSum / lossN : 0;
    const payoffRatio = avgLoss < 0 && winN > 0 ? Math.abs(avgWin / avgLoss) : null;
    const avgPnlPerExit = (t.exits || 0) > 0 ? (t.pnl || 0) / t.exits : 0;
    const avgCostPerEntry = (t.entries || 0) > 0 ? (t.deployed || 0) / t.entries : 0;
    let streak = '-';
    if (exits.length) {
      const lastWon = exits[exits.length - 1].won === true;
      let n = 0;
      for (let i = exits.length - 1; i >= 0; i--) {
        if ((exits[i].won === true) !== lastWon) break;
        n++;
      }
      streak = `${n}${lastWon ? 'W' : 'L'}`;
    }
    return {
      avgPnlPerExit: Math.round(avgPnlPerExit * 100) / 100,
      avgCostPerEntry: Math.round(avgCostPerEntry * 100) / 100,
      avgWin: Math.round(avgWin * 100) / 100,
      avgLoss: Math.round(avgLoss * 100) / 100,
      payoffRatio: payoffRatio == null ? null : Math.round(payoffRatio * 100) / 100,
      streak,
    };
  }

  function fmtNum(n, digits) {
    if (n == null || !isFinite(n)) return '-';
    return Number(n).toFixed(digits == null ? 2 : digits);
  }

  // ---- Compare view ----------------------------------------------------------

  // Renders the full Compare page HTML. Caller is responsible for binding
  // checkbox change events and the range picker via app.js. `selected` is a
  // Set of variant labels.
  function buildCompareView(state, selected, sinceSpec) {
    const variants = (state && state.variants) || [];
    const sel = selected instanceof Set ? selected : new Set(selected || []);
    return `<h2>Compare</h2>` +
      `<p class="muted">Side-by-side performance for any combination of variants. ` +
      `Metrics respect the date range below.</p>` +
      buildRangePicker(sinceSpec) +
      buildCompareSelector(variants, sel) +
      buildCompareSpecs(variants, sel) +
      buildCompareTable(variants, sel) +
      `<h3 style="margin-top:24px">Cumulative PnL</h3>` +
      `<canvas id="chart" height="140"></canvas>`;
  }

  // Spec block rendered above the stats table so A/B reads of params (cap,
  // stop-loss, blackout, sizing) are glance-able. Pulls from readers.js's
  // parsed `args` + `env`; falls back to '-' for missing fields.
  function buildCompareSpecs(variants, selected) {
    const chosen = variants.filter(v => selected.has(v.label));
    if (chosen.length === 0) return '';
    const fmt = (val, fallback = '-') =>
      (val === undefined || val === null || val === '') ? fallback : String(val);
    const capCell = (env) => {
      const up = env.MAX_OBS_BPS_UP;
      const dn = env.MAX_OBS_BPS_DOWN;
      const sym = env.MAX_OBS_BPS;
      if (up != null || dn != null) {
        return `Up=${escapeHtml(fmt(up, sym || '∞'))} / Down=${escapeHtml(fmt(dn, sym || '∞'))}`;
      }
      return escapeHtml(fmt(sym, '∞'));
    };
    const sizeCell = (args, env) => {
      if (env.SIZE_BUCKETS_USD) return `buckets[${escapeHtml(env.SIZE_BUCKETS_USD)}]`;
      if ((env.CERTAINTY_SIZING || '').toLowerCase() === 'true') {
        return `certainty $${escapeHtml(fmt(env.CERTAINTY_MIN_USD, '?'))}-$${escapeHtml(fmt(env.CERTAINTY_MAX_USD, '?'))}`;
      }
      return `$${escapeHtml(fmt(args && args.positionUsd, '?'))}`;
    };
    const rows = chosen.map(v => {
      const a = v.args || {};
      const e = v.env || {};
      return `<tr>` +
        `<th>${escapeHtml((v.label || '').toUpperCase())}</th>` +
        `<td>${escapeHtml(fmt(a.observeMin))}</td>` +
        `<td>${escapeHtml(fmt(a.threshBps))}</td>` +
        `<td>${capCell(e)}</td>` +
        `<td>${escapeHtml(fmt(e.MAX_FILL_PRICE))}</td>` +
        `<td>${sizeCell(a, e)}</td>` +
        `<td>${escapeHtml(fmt(e.STOP_LOSS_RETBPS_REVERSAL, 'off'))}</td>` +
        `<td>${escapeHtml(fmt(e.STRATEGY_BLACKOUT_HOURS, 'none'))}</td>` +
        `<td>${escapeHtml(fmt(e.STRATEGY_SIDES, 'both'))}</td>` +
        `</tr>`;
    }).join('');
    return `<h3 style="margin-top:16px">Specs</h3>` +
      `<div class="compare-table-wrap">` +
      `<table class="compare-table compare-specs"><thead><tr>` +
        `<th>Variant</th>` +
        `<th title="OBSERVE_MIN — observation window in minutes">obs (m)</th>` +
        `<th title="THRESH_BPS — minimum |retBps| to enter">thresh (bps)</th>` +
        `<th title="MAX_OBS_BPS / per-side caps — skip beyond this">maxObs (bps)</th>` +
        `<th title="MAX_FILL_PRICE — skip if avg fill exceeds">maxFill</th>` +
        `<th title="Position sizing — fixed $, certainty, or step-buckets">size</th>` +
        `<th title="STOP_LOSS_RETBPS_REVERSAL — exit if BTC reverses this much">stopLoss</th>` +
        `<th title="STRATEGY_BLACKOUT_HOURS — UTC hours that skip entry">blackout</th>` +
        `<th title="STRATEGY_SIDES — Up / Down / both">sides</th>` +
      `</tr></thead><tbody>${rows}</tbody></table>` +
      `</div>`;
  }

  function buildCompareSelector(variants, selected) {
    const live = variants.filter(v => v.mode === 'live');
    const paper = variants.filter(v => v.mode !== 'live');
    const cb = (v) => {
      const checked = selected.has(v.label) ? ' checked' : '';
      return `<label class="compare-pick">` +
        `<input type="checkbox" class="compare-cb" data-label="${escapeHtml(v.label)}"${checked}>` +
        `${escapeHtml(v.label.toUpperCase())}</label>`;
    };
    const groupHtml = (title, list) => list.length
      ? `<div class="compare-group"><span class="muted">${escapeHtml(title)}:</span> ${list.map(cb).join('')}</div>`
      : '';
    return `<section class="compare-controls" data-role="compare-controls">` +
      `<div class="toolbar">` +
        `<span class="muted">Selected:</span> <span id="compare-count">${selected.size}</span>` +
        `<button class="range-btn" data-compare-action="all">Select all</button>` +
        `<button class="range-btn" data-compare-action="none">Clear</button>` +
        `<button class="range-btn" data-compare-action="paper">Paper only</button>` +
        `<button class="range-btn" data-compare-action="live">Live only</button>` +
      `</div>` +
      groupHtml('Live', live) +
      groupHtml('Paper', paper) +
      `</section>`;
  }

  function buildCompareTable(variants, selected) {
    const chosen = variants.filter(v => selected.has(v.label));
    if (chosen.length === 0) {
      return `<p class="muted">Select at least one variant above to compare.</p>`;
    }
    const rows = chosen.map(v => {
      const t = v.totals || {};
      const records = v.rangeRecords || [];
      const risk = computeRiskMetrics(v.cumulativePnl || [], records);
      const per  = computePerTradeMetrics(t, records);
      const wr = (t.exits || 0) > 0 ? ((t.wins || 0) / t.exits * 100) : null;
      const roi = (t.deployed || 0) > 0 ? ((t.pnl || 0) / t.deployed * 100) : null;
      const stopRate = (t.exits || 0) > 0 ? ((t.stopExits || 0) / t.exits * 100) : null;
      const pnlClass = (t.pnl || 0) >= 0 ? 'pos' : 'neg';
      const modeBadge = v.mode === 'live'
        ? `<span class="badge mode-live">L</span>`
        : `<span class="badge mode-paper">P</span>`;
      return `<tr>` +
        `<td class="label-cell">${escapeHtml(v.label.toUpperCase())} ${modeBadge}</td>` +
        `<td class="num ${pnlClass}">${formatPnl(t.pnl || 0)}</td>` +
        `<td class="num">${roi == null ? '-' : fmtNum(roi, 1) + '%'}</td>` +
        `<td class="num">${t.entries || 0}</td>` +
        `<td class="num">${t.exits || 0}</td>` +
        `<td class="num">${v.openCount || 0}</td>` +
        `<td class="num">${wr == null ? '-' : fmtNum(wr, 1) + '%'}</td>` +
        `<td class="num">${stopRate == null ? '-' : fmtNum(stopRate, 1) + '%'}</td>` +
        `<td class="num neg">-$${fmtNum(risk.maxDrawdown, 2)}</td>` +
        `<td class="num pos">${formatPnl(risk.bestDay)}</td>` +
        `<td class="num neg">${formatPnl(risk.worstDay)}</td>` +
        `<td class="num">${risk.sharpe == null ? '-' : fmtNum(risk.sharpe, 2)}</td>` +
        `<td class="num">${formatPnl(per.avgPnlPerExit)}</td>` +
        `<td class="num">$${fmtNum(per.avgCostPerEntry, 2)}</td>` +
        `<td class="num pos">${formatPnl(per.avgWin)}</td>` +
        `<td class="num neg">${formatPnl(per.avgLoss)}</td>` +
        `<td class="num">${per.payoffRatio == null ? '-' : fmtNum(per.payoffRatio, 2)}</td>` +
        `<td>${escapeHtml(per.streak)}</td>` +
        `</tr>`;
    }).join('');
    return `<div class="compare-table-wrap">` +
      `<table class="compare-table"><thead><tr>` +
        `<th>Variant</th>` +
        `<th title="Total realized PnL in window">PnL</th>` +
        `<th title="PnL / Deployed capital">ROI</th>` +
        `<th>Entries</th>` +
        `<th>Exits</th>` +
        `<th>Open</th>` +
        `<th title="Wins / Exits">WR</th>` +
        `<th title="Stop-outs / Exits">Stops</th>` +
        `<th title="Max peak-to-trough $ decline">MaxDD</th>` +
        `<th title="Best UTC day in window">Best day</th>` +
        `<th title="Worst UTC day in window">Worst day</th>` +
        `<th title="Mean(daily PnL) / stddev(daily PnL)">Sharpe-ish</th>` +
        `<th title="PnL / Exits">Avg PnL/exit</th>` +
        `<th title="Deployed / Entries">Avg cost/entry</th>` +
        `<th title="Mean win PnL">Avg win</th>` +
        `<th title="Mean loss PnL (negative)">Avg loss</th>` +
        `<th title="|Avg win / Avg loss|">Payoff</th>` +
        `<th title="Current consecutive W/L streak">Streak</th>` +
      `</tr></thead><tbody>${rows}</tbody></table>` +
      `</div>`;
  }

  return {
    parseHash, formatPnl, escapeHtml,
    liveArmState, liveArmBadge,
    buildOverviewRow, buildOverviewSection, buildVariantSpec, buildLedgerTable, buildPositionsTable, buildLogsList,
    resolveSince, windowTotals, buildRangePicker, buildRangeLabel,
    computeRiskMetrics, computePerTradeMetrics,
    buildCompareView, buildCompareSelector, buildCompareSpecs, buildCompareTable,
  };
}));
