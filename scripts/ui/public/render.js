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

  function buildOverviewRow(v) {
    const t = v.totals || {};
    const wr = t.exits > 0 ? `${(t.wins / t.exits * 100).toFixed(1)}%` : '-';
    const pnlClass = (t.pnl || 0) >= 0 ? 'pos' : 'neg';
    const errBadge = v.error ? `<span class="badge err" title="${escapeHtml(v.error)}">${escapeHtml(v.error.slice(0,8))}</span>` : '';
    return `<tr data-label="${escapeHtml(v.label)}">` +
      `<td class="label-cell">${escapeHtml(v.label.toUpperCase())} ${errBadge}</td>` +
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
    return `<section class="spec">` +
      `<h3>${escapeHtml((v.label || '').toUpperCase())} - ${escapeHtml(v.service || '')}</h3>` +
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
        } else {
          detail = `reason=${escapeHtml(r.reason || '?')}`;
        }
        return `<tr><td>${ts}</td><td>${escapeHtml(r.kind)}</td><td class="muted">${escapeHtml(slug)}</td><td>${escapeHtml(side)}</td><td class="num">${detail}</td></tr>`;
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
    return { entries: 0, exits: 0, wins: 0, losses: 0, stopExits: 0, pnl: 0, deployed: 0 };
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

  return {
    parseHash, formatPnl, escapeHtml,
    buildOverviewRow, buildVariantSpec, buildLedgerTable, buildPositionsTable, buildLogsList,
    resolveSince, windowTotals, buildRangePicker, buildRangeLabel,
  };
}));
