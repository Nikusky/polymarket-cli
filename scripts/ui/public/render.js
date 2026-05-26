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
        const side = r.betSide || r.tradeSide || r.outcome || '';
        let detail = '';
        if (r.kind === 'entry') {
          detail = `@${Number(r.avgFillPrice||0).toFixed(3)} x ${Number(r.paperShares||0).toFixed(1)}sh`;
        } else if (r.kind === 'mirror') {
          const px = r.masterPrice != null ? Number(r.masterPrice) : Number(r.avgFillPrice||0);
          detail = `@${px.toFixed(3)} x ${Number(r.paperShares||0).toFixed(1)}sh`;
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
      const side = p.betSide || p.tradeSide || p.outcome || '';
      const px = p.avgFillPrice != null ? Number(p.avgFillPrice)
               : p.masterPrice != null ? Number(p.masterPrice) : null;
      const shares = Number(p.paperShares || 0);
      const cost = Number(p.paperCost != null ? p.paperCost
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

  return { parseHash, formatPnl, escapeHtml, buildOverviewRow, buildVariantSpec, buildLedgerTable, buildPositionsTable, buildLogsList };
}));
