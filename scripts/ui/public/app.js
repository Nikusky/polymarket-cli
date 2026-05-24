// polyBOT UI orchestration. Browser-only. Uses globals from render.js (window.polybotRender).
(function () {
  if (typeof window === 'undefined') return;
  const R = window.polybotRender;
  const POLL_MS = 15000;

  let state = null;
  let pollTimer = null;
  let chart = null;
  let consecutiveFails = 0;

  async function fetchAndRender() {
    const route = R.parseHash(window.location.hash);
    try {
      if (route.view === 'overview') {
        const r = await fetch('/api/state');
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        state = await r.json();
        renderSidebar(state, route);
        renderOverview(state);
      } else if (route.view === 'variant') {
        const [stateRes, vRes] = await Promise.all([
          fetch('/api/state'),
          fetch('/api/variant/' + encodeURIComponent(route.label)),
        ]);
        state = await stateRes.json();
        const v = await vRes.json();
        renderSidebar(state, route);
        renderVariantDetail(v);
      } else if (route.view === 'logs') {
        const [stateRes, lRes] = await Promise.all([
          fetch('/api/state'),
          fetch('/api/logs/' + encodeURIComponent(route.label)),
        ]);
        state = await stateRes.json();
        const logs = await lRes.json();
        renderSidebar(state, route);
        renderLogs(route.label, logs);
      }
      setStatus(`* 15s | ${new Date().toLocaleTimeString()}`, 'fresh');
    } catch (e) {
      setStatus(`stale | ${e.message}`, 'stale');
    }
  }

  function setStatus(text, cls) {
    const s = document.getElementById('status');
    s.textContent = text;
    s.className = 'status ' + (cls || '');
    const banner = document.getElementById('banner');
    if (cls === 'stale') {
      consecutiveFails++;
      if (consecutiveFails >= 3 && !banner) {
        const b = document.createElement('div');
        b.id = 'banner';
        b.className = 'banner';
        b.textContent = 'UI server unreachable - showing last-known-good data';
        document.body.insertBefore(b, document.body.firstChild);
      }
    } else {
      consecutiveFails = 0;
      if (banner) banner.remove();
    }
  }

  function renderSidebar(state, route) {
    const labels = (state.variants || []).map(v => v.label);
    const a = (href, text, active) =>
      `<a href="${href}" ${active ? 'class="active"' : ''}>${text}</a>`;
    document.getElementById('sidebar').innerHTML =
      a('#/', 'Overview', route.view === 'overview') +
      `<div class="group">Variants</div>` +
      labels.map(l => a(`#/variant/${l}`, l.toUpperCase(),
        route.view === 'variant' && route.label === l)).join('') +
      `<div class="group">Other</div>` +
      a(`#/logs/${labels[0] || 'd'}`, 'Logs',
        route.view === 'logs');
  }

  function renderOverview(state) {
    const rows = (state.variants || []).map(R.buildOverviewRow).join('');
    document.getElementById('root').innerHTML =
      `<h2>Overview</h2>` +
      `<p class="muted">Generated ${new Date(state.generatedAt * 1000).toISOString()} | ${state.variants.length} variants</p>` +
      `<table><thead><tr><th>Variant</th><th>Exits</th><th>WR</th><th>PnL</th><th>Deployed</th><th>Open</th><th>Description</th></tr></thead>` +
      `<tbody>${rows}</tbody></table>` +
      `<h3 style="margin-top:24px">Cumulative PnL</h3>` +
      `<canvas id="chart" height="120"></canvas>`;
    drawChart(state);
  }

  function drawChart(state) {
    const ctx = document.getElementById('chart');
    if (!ctx || !window.Chart) return;
    const datasets = state.variants
      .filter(v => v.cumulativePnl && v.cumulativePnl.length)
      .map(v => ({
        label: v.label.toUpperCase(),
        data: v.cumulativePnl.map(([t, p]) => ({ x: t * 1000, y: p })),
        borderWidth: 1.5,
        fill: false,
        tension: 0.1,
      }));
    if (chart) chart.destroy();
    chart = new window.Chart(ctx, {
      type: 'line',
      data: { datasets },
      options: {
        scales: { x: { type: 'time', time: { unit: 'hour' } } },
        plugins: { legend: { labels: { color: '#e6edf3' } } },
      },
    });
  }

  function renderVariantDetail(payload) {
    const v = payload.spec || {};
    const ledger = payload.ledger || [];
    const positions = payload.positions || [];
    document.getElementById('root').innerHTML =
      R.buildVariantSpec({ ...v, totals: payload.totals }) +
      (positions.length ? `<h3>Open positions (${positions.length})</h3>` +
        `<pre>${R.escapeHtml(JSON.stringify(positions, null, 2))}</pre>` : '') +
      `<div class="toolbar">` +
      `Filter: ` +
      `<select id="filter">` +
      `<option value="all">all</option>` +
      `<option value="entry">entry</option>` +
      `<option value="exit">exit</option>` +
      `<option value="skip">skip</option>` +
      `<option value="stops">stops only</option>` +
      `</select>` +
      `<a href="#/logs/${v.label}">View logs -></a>` +
      `</div>` +
      `<div id="ledger">${R.buildLedgerTable(ledger, 'all')}</div>`;
    document.getElementById('filter').addEventListener('change', e => {
      document.getElementById('ledger').innerHTML = R.buildLedgerTable(ledger, e.target.value);
    });
  }

  function renderLogs(label, logsPayload) {
    const opts = (state.variants || []).map(v =>
      `<option value="${v.label}" ${v.label === label ? 'selected' : ''}>${v.label.toUpperCase()}</option>`).join('');
    document.getElementById('root').innerHTML =
      `<h2>Logs - ${label.toUpperCase()}</h2>` +
      `<div class="toolbar"><label>Variant: <select id="varSel">${opts}</select></label></div>` +
      (logsPayload.error ? `<p class="neg">journalctl error: ${R.escapeHtml(logsPayload.error)}</p>` : '') +
      R.buildLogsList(logsPayload.lines || []);
    document.getElementById('varSel').addEventListener('change', e => {
      window.location.hash = '#/logs/' + e.target.value;
    });
  }

  function start() {
    window.addEventListener('hashchange', fetchAndRender);
    fetchAndRender();
    pollTimer = setInterval(fetchAndRender, POLL_MS);
  }

  start();
})();
