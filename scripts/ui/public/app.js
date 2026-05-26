// polyBOT UI orchestration. Browser-only. Uses globals from render.js (window.polybotRender).
(function () {
  if (typeof window === 'undefined') return;
  const R = window.polybotRender;
  const POLL_MS = 15000;

  let state = null;
  let pollTimer = null;
  let chart = null;
  let consecutiveFails = 0;

  // Persisted set of legend labels the user has hidden on the overview chart.
  // Survives the 15s polling rebuild AND full page reloads.
  const HIDDEN_KEY = 'polybot.ui.hiddenLabels';
  function loadHidden() {
    try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]')); }
    catch { return new Set(); }
  }
  function saveHidden(set) {
    try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...set])); } catch {}
  }
  let hiddenLabels = loadHidden();

  // Persisted PnL "since" range spec. One of 'all' | '24h' | '7d' | '30d' |
  // '<datetime-local-string>'. See render.js resolveSince().
  const SINCE_KEY = 'polybot.ui.since';
  function loadSince() {
    try { return localStorage.getItem(SINCE_KEY) || 'all'; }
    catch { return 'all'; }
  }
  function saveSince(s) {
    try { localStorage.setItem(SINCE_KEY, s || 'all'); } catch {}
  }
  let sinceSpec = loadSince();

  // Returns a shallow copy of `v` with totals/cumulativePnl recomputed over
  // [sinceTs, now]. When sinceTs is null, returns `v` unchanged.
  function applyRangeToVariant(v, sinceTs) {
    if (sinceTs == null) return v;
    const { totals, cumulativePnl } = R.windowTotals(v.rangeRecords || [], sinceTs);
    return Object.assign({}, v, { totals, cumulativePnl });
  }

  // Returns the variants array with the current range window applied.
  function applyRange(state) {
    const ts = R.resolveSince(sinceSpec);
    if (!state || !state.variants) return state;
    return Object.assign({}, state, {
      variants: state.variants.map(v => applyRangeToVariant(v, ts)),
    });
  }

  // Wires the range picker controls inside `container` (an Element). Buttons
  // with data-since switch presets immediately; the Apply button reads the
  // datetime-local input and switches to a custom timestamp.
  function bindRangePicker(container) {
    if (!container) return;
    container.querySelectorAll('button.range-btn[data-since]').forEach(btn => {
      btn.addEventListener('click', () => {
        sinceSpec = btn.getAttribute('data-since');
        saveSince(sinceSpec);
        fetchAndRender();
      });
    });
    const apply = container.querySelector('#range-apply');
    const input = container.querySelector('#range-custom');
    if (apply && input) {
      apply.addEventListener('click', () => {
        if (!input.value) return;
        sinceSpec = input.value;
        saveSince(sinceSpec);
        fetchAndRender();
      });
    }
  }

  async function fetchAndRender() {
    const route = R.parseHash(window.location.hash);
    try {
      if (route.view === 'overview') {
        const r = await fetch('/api/state');
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        state = await r.json();
        renderSidebar(state, route);
        renderOverview(applyRange(state));
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
      R.buildRangePicker(sinceSpec) +
      `<table><thead><tr><th>Variant</th><th>Exits</th><th>WR</th><th>PnL</th><th>Deployed</th><th>Open</th><th>Description</th></tr></thead>` +
      `<tbody>${rows}</tbody></table>` +
      `<h3 style="margin-top:24px">Cumulative PnL</h3>` +
      `<canvas id="chart" height="120"></canvas>`;
    bindRangePicker(document.querySelector('[data-role="range"]'));
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
        // Pre-apply the user's persisted choice so the dataset starts hidden.
        hidden: hiddenLabels.has(v.label.toUpperCase()),
      }));
    if (chart) chart.destroy();
    chart = new window.Chart(ctx, {
      type: 'line',
      data: { datasets },
      options: {
        scales: {
          x: { type: 'time', time: { unit: 'hour' } },
          y: {
            grid: {
              color: (ctx) => ctx.tick.value === 0 ? '#e6edf3' : 'rgba(230,237,243,0.08)',
              lineWidth: (ctx) => ctx.tick.value === 0 ? 2 : 1,
            },
          },
        },
        plugins: {
          legend: {
            labels: { color: '#e6edf3' },
            // Toggle dataset + persist the choice. Mirrors Chart.js default
            // behaviour and additionally writes the resulting set to localStorage
            // so the next 15s poll (which destroys & recreates the chart) and
            // any future page load can restore it.
            onClick: (e, legendItem, legend) => {
              const ci = legend.chart;
              const idx = legendItem.datasetIndex;
              const meta = ci.getDatasetMeta(idx);
              meta.hidden = meta.hidden === null ? !ci.data.datasets[idx].hidden : null;
              const label = legendItem.text;
              const isHiddenNow = meta.hidden === true ||
                (meta.hidden === null && ci.data.datasets[idx].hidden === true);
              if (isHiddenNow) hiddenLabels.add(label);
              else hiddenLabels.delete(label);
              saveHidden(hiddenLabels);
              ci.update();
            },
          },
        },
      },
    });
  }

  function renderVariantDetail(payload) {
    const v = payload.spec || {};
    const allLedger = payload.ledger || [];
    const positions = payload.positions || [];
    const sinceTs = R.resolveSince(sinceSpec);

    // Window the variant's own ledger + totals client-side. When sinceTs is
    // null we keep the server-computed totals and full ledger.
    const windowed = sinceTs == null
      ? { totals: payload.totals || {}, cumulativePnl: null }
      : R.windowTotals(allLedger, sinceTs);
    const ledger = sinceTs == null
      ? allLedger
      : allLedger.filter(r => Number(r.ts || 0) >= sinceTs);

    document.getElementById('root').innerHTML =
      `<h3 style="margin:0 0 8px">${(v.label || '').toUpperCase()} - cumulative PnL</h3>` +
      R.buildRangePicker(sinceSpec) +
      `<canvas id="chart" height="140"></canvas>` +
      R.buildVariantSpec({ ...v, totals: windowed.totals }) +
      R.buildPositionsTable(positions) +
      `<div class="toolbar">` +
      `Filter: ` +
      `<select id="filter">` +
      `<option value="all">all</option>` +
      `<option value="entry">entry</option>` +
      `<option value="mirror">mirror</option>` +
      `<option value="exit">exit</option>` +
      `<option value="skip">skip</option>` +
      `<option value="stops">stops only</option>` +
      `</select>` +
      `<a href="#/logs/${v.label}">View logs -></a>` +
      `</div>` +
      `<div id="ledger">${R.buildLedgerTable(ledger, 'all')}</div>`;
    bindRangePicker(document.querySelector('[data-role="range"]'));
    document.getElementById('filter').addEventListener('change', e => {
      document.getElementById('ledger').innerHTML = R.buildLedgerTable(ledger, e.target.value);
    });
    drawVariantChart(v.label, windowed.cumulativePnl);
  }

  function drawVariantChart(label, windowedSeries) {
    const ctx = document.getElementById('chart');
    if (!ctx || !window.Chart || !state) return;
    const v = (state.variants || []).find(x => x.label === label);
    const series = windowedSeries != null
      ? windowedSeries
      : (v && v.cumulativePnl ? v.cumulativePnl : []);
    const data = series.map(([t, p]) => ({ x: t * 1000, y: p }));
    if (chart) chart.destroy();
    chart = new window.Chart(ctx, {
      type: 'line',
      data: {
        datasets: [{
          label: (label || '').toUpperCase(),
          data,
          borderWidth: 1.5,
          fill: false,
          tension: 0.1,
        }],
      },
      options: {
        scales: {
          x: { type: 'time', time: { unit: 'hour' } },
          y: {
            grid: {
              color: (c) => c.tick.value === 0 ? '#e6edf3' : 'rgba(230,237,243,0.08)',
              lineWidth: (c) => c.tick.value === 0 ? 2 : 1,
            },
          },
        },
        plugins: { legend: { display: false } },
      },
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
