# polyBOT UI v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a read-only browser dashboard that shows config + history + live logs for every polyBOT paper-trading variant, polling every 15 seconds, served by a Node daemon on `127.0.0.1:8080` accessed via SSH tunnel.

**Architecture:** One Node process (`polybot-ui.service`) on the Lightsail server. Pure-function reader module parses `.service` files, JSONL ledgers, state JSON, and `journalctl` output. HTTP server exposes JSON endpoints. Vanilla-JS frontend with hash routing renders three views (overview, variant detail, logs). No npm dependencies — only Node built-ins and a single CDN script tag for Chart.js.

**Tech Stack:** Node.js built-ins (`http`, `fs`, `path`, `child_process`, `util`), vanilla JS in the browser, Chart.js 4.x from jsdelivr CDN, systemd for process management.

**Spec reference:** `polymarket-cli/docs/superpowers/specs/2026-05-24-polybot-ui-design.md` (commit `f6cd4f7`).

---

## File structure

```
polymarket-cli/
├── scripts/ui/
│   ├── readers.js              # Pure parse fns: parseServiceFile, listVariants,
│   │                           # readLedger, readState, parseJournalOutput, readJournal
│   ├── server.js               # HTTP server, route table
│   ├── public/
│   │   ├── index.html          # Static shell with sidebar + #root + Chart.js CDN tag
│   │   ├── render.js           # Pure DOM-free helpers
│   │   ├── app.js              # Browser orchestration: boot, polling, dispatch
│   │   └── styles.css          # Dark theme, monospace numbers, sidebar layout
│   ├── test_readers.js         # Unit tests for readers.js
│   ├── test_render.js          # Unit tests for render.js
│   ├── test_server.js          # Integration tests: spin up server.js against fixtures
│   └── __fixtures__/
│       ├── deploy/
│       │   ├── polybot-strategy-d.service        # valid baseline
│       │   ├── polybot-strategy-malformed.service # missing ExecStart
│       │   └── polybot-mastercopy.service        # mastercopy schema
│       ├── scripts/strategy/data-d/
│       │   ├── strategy-ledger.jsonl              # 5 entries + 5 exits + 2 skips
│       │   └── strategy-state.json                # 1 open position
│       ├── scripts/mastercopy/data-mc/
│       │   └── strategy-ledger.jsonl              # 1 mirror + 1 exit
│       └── fake-journalctl.js                    # canned output for journalctl tests
└── deploy/
    └── polybot-ui.service       # systemd unit
```

**Conventions:**
- `polybot` user owns all files on the server. Tests run as the laptop user — they only touch repo-relative paths and `__fixtures__/`.
- All `ts` fields in records are unix epoch seconds (per `CLAUDE.md`).
- Variant labels match `/^[a-z]{1,12}(-[a-z]+)?$/` (e.g. `d`, `h`, `mc`, `mastercopy`, `mc-sells`).
- Commits use Conventional Commit format (`feat:`, `chore:`, `test:`).
- Each commit is staged with **explicit file paths**, never `git add .` or `git add -A`.

---

## Phase A — readers.js (5 tasks)

The reader module is pure: every function takes its root path as an argument and returns plain JS objects. No global state, no side effects beyond file reads. This is the unit most worth TDD'ing because it has the most numerical logic.

### Task 1: Set up readers.js with `parseServiceFile`

**Files:**
- Create: `polymarket-cli/scripts/ui/readers.js`
- Create: `polymarket-cli/scripts/ui/test_readers.js`

- [ ] **Step 1: Write the failing test**

Create `scripts/ui/test_readers.js`:

```js
const assert = require('assert');
const { parseServiceFile } = require('./readers');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n    ${e.message}`); failed++; }
}

console.log('== parseServiceFile ==');

test('parses Environment vars into env object', () => {
  const src = [
    '[Unit]',
    'Description=test bot',
    '[Service]',
    'Environment=MAX_FILL_PRICE=0.85',
    'Environment=STRATEGY_BLACKOUT_HOURS=13,17,22',
    'ExecStart=/usr/bin/node /opt/polybot/polymarket-cli/scripts/strategy/main.js 9 6 100 168',
    '[Install]',
    'WantedBy=multi-user.target',
  ].join('\n');
  const r = parseServiceFile(src);
  assert.strictEqual(r.description, 'test bot');
  assert.deepStrictEqual(r.env, { MAX_FILL_PRICE: '0.85', STRATEGY_BLACKOUT_HOURS: '13,17,22' });
  assert.deepStrictEqual(r.execStart, ['/usr/bin/node', '/opt/polybot/polymarket-cli/scripts/strategy/main.js', '9', '6', '100', '168']);
  assert.deepStrictEqual(r.args, { observeMin: 9, threshBps: 6, positionUsd: 100, runtimeHours: 168 });
});

test('returns {error} when ExecStart missing', () => {
  const r = parseServiceFile('[Unit]\nDescription=x\n[Service]\n');
  assert.ok(r.error, 'expected error field');
  assert.match(r.error, /ExecStart/);
});

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} - ${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/ui/test_readers.js`
Expected: `Cannot find module './readers'` error from `require('./readers')`.

- [ ] **Step 3: Create readers.js with `parseServiceFile`**

Create `scripts/ui/readers.js`:

```js
// Pure parsers for polyBOT UI. No global state, no I/O assumptions —
// every function takes its root path or data buffer as an argument.

function parseServiceFile(src) {
  const lines = src.split('\n').map(l => l.trim()).filter(Boolean);
  const env = {};
  let description = '';
  let execStart = null;

  for (const line of lines) {
    if (line.startsWith('Description=')) {
      description = line.slice('Description='.length);
    } else if (line.startsWith('Environment=')) {
      const kv = line.slice('Environment='.length);
      const eq = kv.indexOf('=');
      if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (line.startsWith('ExecStart=')) {
      execStart = line.slice('ExecStart='.length).split(/\s+/);
    }
  }

  if (!execStart) return { description, env, error: 'ExecStart missing' };

  const a = execStart;
  const args = a.length >= 6 ? {
    observeMin: parseInt(a[a.length - 4], 10),
    threshBps: parseFloat(a[a.length - 3]),
    positionUsd: parseFloat(a[a.length - 2]),
    runtimeHours: parseFloat(a[a.length - 1]),
  } : null;

  return { description, env, execStart, args };
}

module.exports = { parseServiceFile };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/ui/test_readers.js`
Expected: `PASS - 0 failure(s)`.

- [ ] **Step 5: Commit**

```bash
git add scripts/ui/readers.js scripts/ui/test_readers.js
git commit -m "feat(ui): add parseServiceFile reader + test scaffold"
```

---

### Task 2: `listVariants` discovery

**Files:**
- Modify: `polymarket-cli/scripts/ui/readers.js`
- Modify: `polymarket-cli/scripts/ui/test_readers.js`
- Create: `polymarket-cli/scripts/ui/__fixtures__/deploy/polybot-strategy-d.service`
- Create: `polymarket-cli/scripts/ui/__fixtures__/deploy/polybot-strategy-malformed.service`
- Create: `polymarket-cli/scripts/ui/__fixtures__/deploy/polybot-mastercopy.service`

- [ ] **Step 1: Create fixture service files**

Create `scripts/ui/__fixtures__/deploy/polybot-strategy-d.service`:

```ini
[Unit]
Description=polyBOT strategy paper bot - variant D test fixture
[Service]
User=polybot
WorkingDirectory=/opt/polybot/polymarket-cli
Environment=STRATEGY_DATA_DIR=/opt/polybot/polymarket-cli/scripts/strategy/data-d
Environment=MAX_FILL_PRICE=0.92
Environment=STRATEGY_BLACKOUT_HOURS=13,17,22
ExecStart=/usr/bin/node /opt/polybot/polymarket-cli/scripts/strategy/main.js 11 6 100 168
[Install]
WantedBy=multi-user.target
```

Create `scripts/ui/__fixtures__/deploy/polybot-strategy-malformed.service`:

```ini
[Unit]
Description=intentionally broken - missing ExecStart
[Service]
User=polybot
[Install]
WantedBy=multi-user.target
```

Create `scripts/ui/__fixtures__/deploy/polybot-mastercopy.service`:

```ini
[Unit]
Description=polyBOT mastercopy paper mirror test fixture
[Service]
User=polybot
WorkingDirectory=/opt/polybot/polymarket-cli
Environment=MASTERCOPY_DATA_DIR=/opt/polybot/polymarket-cli/scripts/mastercopy/data-mc
Environment=MASTER_ADDRESSES=0xce25e214d5cfe4f459cf67f08df581885aae7fdc
ExecStart=/usr/bin/node /opt/polybot/polymarket-cli/scripts/mastercopy/main.js 168
[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Add the failing test**

Append to `scripts/ui/test_readers.js` (before the final `console.log` summary):

```js
const path = require('path');
const { listVariants } = require('./readers');

console.log('\n== listVariants ==');

const FIX = path.join(__dirname, '__fixtures__');

test('discovers all .service files under deployDir', () => {
  const v = listVariants(path.join(FIX, 'deploy'));
  const labels = v.map(x => x.label).sort();
  assert.deepStrictEqual(labels, ['d', 'malformed', 'mastercopy']);
});

test('parses ok variant correctly', () => {
  const v = listVariants(path.join(FIX, 'deploy'));
  const d = v.find(x => x.label === 'd');
  assert.strictEqual(d.service, 'polybot-strategy-d');
  assert.strictEqual(d.env.MAX_FILL_PRICE, '0.92');
  assert.deepStrictEqual(d.args, { observeMin: 11, threshBps: 6, positionUsd: 100, runtimeHours: 168 });
  assert.strictEqual(d.dataDir, 'scripts/strategy/data-d');
});

test('flags malformed variant with error but does not throw', () => {
  const v = listVariants(path.join(FIX, 'deploy'));
  const m = v.find(x => x.label === 'malformed');
  assert.ok(m.error, 'expected error field on malformed variant');
});

test('parses mastercopy variant data dir', () => {
  const v = listVariants(path.join(FIX, 'deploy'));
  const mc = v.find(x => x.label === 'mastercopy');
  assert.strictEqual(mc.dataDir, 'scripts/mastercopy/data-mc');
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node scripts/ui/test_readers.js`
Expected: `listVariants is not a function` (or similar).

- [ ] **Step 4: Implement `listVariants`**

Append to `scripts/ui/readers.js`:

```js
const fs = require('fs');
const path = require('path');

function listVariants(deployDir) {
  let entries;
  try { entries = fs.readdirSync(deployDir); }
  catch { return []; }

  const out = [];
  for (const name of entries) {
    if (!name.endsWith('.service')) continue;
    const m = name.match(/^polybot-(strategy-([a-z]+)|mastercopy(-sells)?)\.service$/);
    if (!m) continue;

    let label;
    const service = name.replace('.service', '');
    if (m[2]) label = m[2];                              // strategy-d -> d
    else if (m[3]) label = 'mc-sells';                   // mastercopy-sells -> mc-sells
    else label = 'mastercopy';                           // mastercopy alone -> mastercopy

    const src = fs.readFileSync(path.join(deployDir, name), 'utf8');
    const parsed = parseServiceFile(src);

    let dataDir = null;
    if (parsed.env && parsed.env.STRATEGY_DATA_DIR) {
      dataDir = parsed.env.STRATEGY_DATA_DIR.replace('/opt/polybot/polymarket-cli/', '');
    } else if (parsed.env && parsed.env.MASTERCOPY_DATA_DIR) {
      dataDir = parsed.env.MASTERCOPY_DATA_DIR.replace('/opt/polybot/polymarket-cli/', '');
    }

    out.push({
      label,
      service,
      description: parsed.description,
      env: parsed.env || {},
      args: parsed.args || null,
      dataDir,
      error: parsed.error || null,
    });
  }
  return out;
}

module.exports = { parseServiceFile, listVariants };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node scripts/ui/test_readers.js`
Expected: `PASS - 0 failure(s)` with all four new `listVariants` cases ok.

- [ ] **Step 6: Commit**

```bash
git add scripts/ui/readers.js scripts/ui/test_readers.js scripts/ui/__fixtures__/deploy/
git commit -m "feat(ui): add listVariants + service-file fixtures"
```

---

### Task 3: `readLedger` with totals derivation

**Files:**
- Modify: `polymarket-cli/scripts/ui/readers.js`
- Modify: `polymarket-cli/scripts/ui/test_readers.js`
- Create: `polymarket-cli/scripts/ui/__fixtures__/scripts/strategy/data-d/strategy-ledger.jsonl`

- [ ] **Step 1: Create the fixture ledger**

Create `scripts/ui/__fixtures__/scripts/strategy/data-d/strategy-ledger.jsonl` — 5 entries + 5 exits + 2 skips, totals are easy to verify by hand. Each line is one JSON object, no trailing comma, file ends with `\n`.

Content (paste exactly):

```jsonl
{"kind":"entry","ts":1779000000,"slug":"btc-updown-15m-1779000000","betSide":"Up","avgFillPrice":0.86,"paperShares":116.28,"paperCost":100,"observeBps":8.2}
{"kind":"exit","ts":1779000900,"slug":"btc-updown-15m-1779000000","betSide":"Up","won":true,"winner":"Up","pnl":16.28,"avgFillPrice":0.86,"paperShares":116.28,"paperCost":100,"observeBps":8.2}
{"kind":"entry","ts":1779001000,"slug":"btc-updown-15m-1779000900","betSide":"Down","avgFillPrice":0.90,"paperShares":111.11,"paperCost":100,"observeBps":-7.0}
{"kind":"exit","ts":1779001900,"slug":"btc-updown-15m-1779000900","betSide":"Down","won":true,"winner":"Down","pnl":11.11,"avgFillPrice":0.90,"paperShares":111.11,"paperCost":100,"observeBps":-7.0}
{"kind":"skip","ts":1779002000,"slug":"btc-updown-15m-1779001800","reason":"below_threshold","retBps":2.1}
{"kind":"entry","ts":1779003000,"slug":"btc-updown-15m-1779002700","betSide":"Up","avgFillPrice":0.88,"paperShares":113.64,"paperCost":100,"observeBps":9.5}
{"kind":"exit","ts":1779003900,"slug":"btc-updown-15m-1779002700","betSide":"Up","won":false,"winner":"Down","pnl":-100,"avgFillPrice":0.88,"paperShares":113.64,"paperCost":100,"observeBps":9.5}
{"kind":"skip","ts":1779004000,"slug":"btc-updown-15m-1779003600","reason":"fill_too_high","avgPrice":0.95}
{"kind":"entry","ts":1779005000,"slug":"btc-updown-15m-1779004500","betSide":"Up","avgFillPrice":0.85,"paperShares":117.65,"paperCost":100,"observeBps":7.0}
{"kind":"exit","ts":1779005900,"slug":"btc-updown-15m-1779004500","betSide":"Up","won":false,"winner":"stopped","stoppedOut":true,"pnl":-58,"avgFillPrice":0.85,"paperShares":117.65,"paperCost":100,"observeBps":7.0,"stopExitPrice":0.35,"entryRetBps":7.0,"stopRetBps":-4.0}
{"kind":"entry","ts":1779006000,"slug":"btc-updown-15m-1779005400","betSide":"Down","avgFillPrice":0.87,"paperShares":114.94,"paperCost":100,"observeBps":-8.0}
{"kind":"exit","ts":1779006900,"slug":"btc-updown-15m-1779005400","betSide":"Down","won":true,"winner":"Down","pnl":14.94,"avgFillPrice":0.87,"paperShares":114.94,"paperCost":100,"observeBps":-8.0}
```

Hand-verified totals: 5 entries, 5 exits, 3 wins, 2 losses, 1 stop-exit, gross PnL = 16.28 + 11.11 − 100 − 58 + 14.94 = **−115.67**, deployed = 5 × 100 = **500**, 2 skips, total records = 12.

- [ ] **Step 2: Add the failing test**

Append to `scripts/ui/test_readers.js`:

```js
const { readLedger } = require('./readers');

console.log('\n== readLedger ==');

test('reads ledger and parses every line', () => {
  const r = readLedger(path.join(FIX, 'scripts/strategy/data-d'));
  assert.strictEqual(r.records.length, 12, `got ${r.records.length}`);
});

test('derives totals correctly', () => {
  const r = readLedger(path.join(FIX, 'scripts/strategy/data-d'));
  assert.strictEqual(r.totals.entries, 5);
  assert.strictEqual(r.totals.exits, 5);
  assert.strictEqual(r.totals.wins, 3);
  assert.strictEqual(r.totals.losses, 2);
  assert.strictEqual(r.totals.stopExits, 1);
  assert.strictEqual(r.totals.deployed, 500);
  assert.ok(Math.abs(r.totals.pnl - (-115.67)) < 0.01, `pnl was ${r.totals.pnl}`);
});

test('cumulativePnl is array of [ts, runningTotal]', () => {
  const r = readLedger(path.join(FIX, 'scripts/strategy/data-d'));
  assert.ok(Array.isArray(r.cumulativePnl));
  assert.strictEqual(r.cumulativePnl.length, 5);  // one point per exit
  assert.strictEqual(r.cumulativePnl[0][0], 1779000900);
  assert.ok(Math.abs(r.cumulativePnl[0][1] - 16.28) < 0.01);
  assert.ok(Math.abs(r.cumulativePnl[4][1] - (-115.67)) < 0.01);
});

test('returns empty record set when dir missing', () => {
  const r = readLedger(path.join(FIX, 'scripts/strategy/does-not-exist'));
  assert.deepStrictEqual(r.records, []);
  assert.strictEqual(r.totals.exits, 0);
  assert.strictEqual(r.error, 'no ledger yet');
});

test('parseErrors is 0 on clean fixture', () => {
  const r = readLedger(path.join(FIX, 'scripts/strategy/data-d'));
  assert.strictEqual(r.parseErrors, 0);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node scripts/ui/test_readers.js`
Expected: failures on `readLedger` undefined.

- [ ] **Step 4: Implement `readLedger`**

Append to `scripts/ui/readers.js`:

```js
function readLedger(dataDir, _opts = {}) {
  const ledgerPath = path.join(dataDir, 'strategy-ledger.jsonl');
  let raw;
  try { raw = fs.readFileSync(ledgerPath, 'utf8'); }
  catch { return { records: [], totals: emptyTotals(), cumulativePnl: [], parseErrors: 0, error: 'no ledger yet' }; }

  const records = [];
  let parseErrors = 0;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { records.push(JSON.parse(line)); }
    catch { parseErrors++; }
  }

  const totals = emptyTotals();
  for (const r of records) {
    if (r.kind === 'entry') {
      totals.entries++;
      totals.deployed += Number(r.paperCost || 0);
    } else if (r.kind === 'exit') {
      totals.exits++;
      if (r.won === true) totals.wins++;
      else totals.losses++;
      if (r.stoppedOut === true) totals.stopExits++;
      totals.pnl += Number(r.pnl || 0);
    }
  }

  const cumulativePnl = [];
  let running = 0;
  for (const r of records) {
    if (r.kind !== 'exit') continue;
    running += Number(r.pnl || 0);
    cumulativePnl.push([r.ts, Math.round(running * 100) / 100]);
  }

  // Round pnl to 2 decimals to absorb fp noise.
  totals.pnl = Math.round(totals.pnl * 100) / 100;

  return { records, totals, cumulativePnl, parseErrors };
}

function emptyTotals() {
  return { entries: 0, exits: 0, wins: 0, losses: 0, stopExits: 0, pnl: 0, deployed: 0 };
}

module.exports = { parseServiceFile, listVariants, readLedger };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node scripts/ui/test_readers.js`
Expected: all readLedger tests pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/ui/readers.js scripts/ui/test_readers.js scripts/ui/__fixtures__/scripts/
git commit -m "feat(ui): add readLedger with totals + cumulativePnl"
```

---

### Task 4: `readState` with open-position filtering

**Files:**
- Modify: `polymarket-cli/scripts/ui/readers.js`
- Modify: `polymarket-cli/scripts/ui/test_readers.js`
- Create: `polymarket-cli/scripts/ui/__fixtures__/scripts/strategy/data-d/strategy-state.json`

- [ ] **Step 1: Create the fixture state file**

Create `scripts/ui/__fixtures__/scripts/strategy/data-d/strategy-state.json`:

```json
{
  "decisions": {
    "btc-updown-15m-1779000000": { "reason": "entered" },
    "btc-updown-15m-1779001800": { "reason": "below_threshold" }
  },
  "positions": {
    "btc-updown-15m-1779999000": {
      "slug": "btc-updown-15m-1779999000",
      "openTs": 1779999000,
      "resolveTs": 1779999900,
      "betSide": "Up",
      "avgFillPrice": 0.88,
      "paperShares": 113.64,
      "paperCost": 100,
      "observeBps": 9.0,
      "settled": false
    },
    "btc-updown-15m-1779000000": {
      "slug": "btc-updown-15m-1779000000",
      "betSide": "Up",
      "settled": true,
      "actualWinner": "Up",
      "realizedPnl": 16.28
    }
  }
}
```

- [ ] **Step 2: Add the failing test**

Append to `scripts/ui/test_readers.js`:

```js
const { readState } = require('./readers');

console.log('\n== readState ==');

test('filters to open positions only', () => {
  const s = readState(path.join(FIX, 'scripts/strategy/data-d'));
  assert.strictEqual(s.positions.length, 1);
  assert.strictEqual(s.positions[0].slug, 'btc-updown-15m-1779999000');
});

test('aggregates decision counts by reason', () => {
  const s = readState(path.join(FIX, 'scripts/strategy/data-d'));
  assert.strictEqual(s.decisionCounts.below_threshold, 1);
  assert.strictEqual(s.decisionCounts.entered, 1);
});

test('returns empty shape when missing', () => {
  const s = readState(path.join(FIX, 'scripts/strategy/does-not-exist'));
  assert.deepStrictEqual(s.positions, []);
  assert.deepStrictEqual(s.decisionCounts, {});
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node scripts/ui/test_readers.js`
Expected: `readState is not a function`.

- [ ] **Step 4: Implement `readState`**

Append to `scripts/ui/readers.js`:

```js
function readState(dataDir) {
  const statePath = path.join(dataDir, 'strategy-state.json');
  let raw;
  try { raw = fs.readFileSync(statePath, 'utf8'); }
  catch { return { positions: [], decisionCounts: {} }; }

  let st;
  try { st = JSON.parse(raw); }
  catch { return { positions: [], decisionCounts: {}, error: 'state parse failed' }; }

  const positions = Object.values(st.positions || {}).filter(p => !p.settled);
  const decisionCounts = {};
  for (const d of Object.values(st.decisions || {})) {
    const r = d.reason || 'unknown';
    decisionCounts[r] = (decisionCounts[r] || 0) + 1;
  }
  return { positions, decisionCounts };
}

module.exports = { parseServiceFile, listVariants, readLedger, readState };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node scripts/ui/test_readers.js`
Expected: all readState tests pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/ui/readers.js scripts/ui/test_readers.js scripts/ui/__fixtures__/scripts/strategy/data-d/strategy-state.json
git commit -m "feat(ui): add readState for open positions and decision counts"
```

---

### Task 5: `readJournal` with injectable binary path

**Files:**
- Modify: `polymarket-cli/scripts/ui/readers.js`
- Modify: `polymarket-cli/scripts/ui/test_readers.js`
- Create: `polymarket-cli/scripts/ui/__fixtures__/fake-journalctl.js`

- [ ] **Step 1: Create the fake journalctl binary**

Create `scripts/ui/__fixtures__/fake-journalctl.js`:

```js
#!/usr/bin/env node
// Stand-in for `journalctl`. Prints two canned lines in short-iso format
// so readJournal can parse them. We honor `-n N` by clamping; everything
// else is ignored.
const args = process.argv.slice(2);
const nFlag = args.indexOf('-n');
const limit = nFlag >= 0 ? parseInt(args[nFlag + 1], 10) : 100;

const lines = [
  '2026-05-24T16:00:00+0000 ip-172-26-3-45 polybot-strategy-d[123]: [16:00:00] info  tick',
  '2026-05-24T16:00:02+0000 ip-172-26-3-45 polybot-strategy-d[123]: [16:00:02] info  tick',
];
for (const l of lines.slice(0, limit)) console.log(l);
```

- [ ] **Step 2: Restructure test_readers.js for async**

`readJournal` is async; the existing test runner is sync. Convert by wrapping everything in an async IIFE. Replace the top of `scripts/ui/test_readers.js`:

```js
const assert = require('assert');
const path = require('path');
const { parseServiceFile, listVariants, readLedger, readState, readJournal, parseJournalOutput } = require('./readers');

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n    ${e.message}`); failed++; }
}

const FIX = path.join(__dirname, '__fixtures__');

(async () => {
```

Then move all `test(...)` calls so they live inside the IIFE. At the bottom add:

```js
  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} - ${failed} failure(s)`);
  process.exit(failed === 0 ? 0 : 1);
})();
```

Remove the old final `console.log` + `process.exit` lines that were outside the IIFE.

- [ ] **Step 3: Add the failing test**

Append inside the IIFE (after the readState tests):

```js
console.log('\n== readJournal ==');

await test('parseJournalOutput extracts ts and message', () => {
  const out = '2026-05-24T16:00:00+0000 host pol[1]: [16:00:00] info  tick';
  const r = parseJournalOutput(out);
  assert.strictEqual(r.length, 1);
  assert.ok(r[0].ts > 1779000000, `ts not parsed: ${r[0].ts}`);
  assert.ok(r[0].message.includes('tick'));
});

await test('readJournal via fake binary returns lines', async () => {
  const fakeBin = path.join(FIX, 'fake-journalctl.js');
  const r = await readJournal('polybot-strategy-d', { bin: 'node', extraArgs: [fakeBin], lines: 200 });
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.lines.length, 2);
  assert.ok(r.lines[0].message.includes('tick'));
});

await test('readJournal returns error field on failure', async () => {
  const r = await readJournal('polybot-strategy-d', { bin: '/path/does/not/exist', lines: 200 });
  assert.strictEqual(r.lines.length, 0);
  assert.ok(r.error, 'expected error field');
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `node scripts/ui/test_readers.js`
Expected: `readJournal is not a function`.

- [ ] **Step 5: Implement `readJournal` + `parseJournalOutput`**

Append to `scripts/ui/readers.js`:

```js
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

function parseJournalOutput(stdout) {
  return stdout.split('\n').filter(Boolean).map(line => {
    // short-iso: "2026-05-24T16:00:00+0000 host unit[pid]: message..."
    const m = line.match(/^(\S+)\s+\S+\s+\S+\s+(.+)$/);
    if (!m) return { ts: 0, message: line };
    const d = new Date(m[1]);
    const ts = isNaN(d.getTime()) ? 0 : Math.floor(d.getTime() / 1000);
    return { ts, message: m[2] };
  });
}

async function readJournal(unitName, opts = {}) {
  const {
    lines = 200,
    bin = process.env.JOURNALCTL_BIN || 'journalctl',
    extraArgs = [],
    timeoutMs = 3000,
  } = opts;
  const args = extraArgs.length
    ? [...extraArgs, '-u', unitName, '-n', String(lines), '--no-pager', '--output=short-iso']
    : ['-u', unitName, '-n', String(lines), '--no-pager', '--output=short-iso'];
  try {
    const { stdout } = await execFileP(bin, args, { timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024 });
    return { lines: parseJournalOutput(stdout), error: null };
  } catch (e) {
    return { lines: [], error: e.signal === 'SIGTERM' ? 'timeout' : (e.stderr || e.message || 'spawn failed') };
  }
}

module.exports = { parseServiceFile, listVariants, readLedger, readState, readJournal, parseJournalOutput };
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node scripts/ui/test_readers.js`
Expected: `PASS - 0 failure(s)`.

- [ ] **Step 7: Commit**

```bash
git add scripts/ui/readers.js scripts/ui/test_readers.js scripts/ui/__fixtures__/fake-journalctl.js
git commit -m "feat(ui): add readJournal with parseJournalOutput + fake bin injection"
```

---

## Phase B — server.js + integration tests (6 tasks)

### Task 6: HTTP server scaffolding + `/api/health`

**Files:**
- Create: `polymarket-cli/scripts/ui/server.js`
- Create: `polymarket-cli/scripts/ui/test_server.js`

- [ ] **Step 1: Write the failing integration test**

Create `scripts/ui/test_server.js`:

```js
const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n    ${e.message}`); failed++; }
}

const FIX = path.join(__dirname, '__fixtures__');

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      env: {
        ...process.env,
        POLYBOT_UI_ROOT: FIX,
        POLYBOT_UI_PORT: '0',
        POLYBOT_UI_JOURNALCTL_ARGS: path.join(FIX, 'fake-journalctl.js'),
        JOURNALCTL_BIN: 'node',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', c => { stderr += c.toString(); });
    proc.stdout.on('data', chunk => {
      const m = chunk.toString().match(/listening on http:\/\/(\S+)/);
      if (m) resolve({ proc, url: 'http://' + m[1] });
    });
    proc.on('exit', code => reject(new Error(`server exited (${code}) stderr:\n${stderr}`)));
    setTimeout(() => reject(new Error(`server didn't start within 5s; stderr:\n${stderr}`)), 5000);
  });
}

(async () => {
  console.log('== server: /api/health ==');

  let srv;
  await test('server starts on ephemeral port', async () => {
    srv = await startServer();
    assert.ok(srv.url.startsWith('http://'));
  });

  await test('/api/health returns ok=true', async () => {
    const r = await fetch(srv.url + '/api/health');
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.strictEqual(j.ok, true);
    assert.ok(typeof j.uptime === 'number');
  });

  if (srv) srv.proc.kill();
  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} - ${failed} failure(s)`);
  process.exit(failed === 0 ? 0 : 1);
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/ui/test_server.js`
Expected: `Cannot find module .../server.js`.

- [ ] **Step 3: Create `server.js`**

Create `scripts/ui/server.js`:

```js
// polyBOT UI server. Read-only HTTP API + static file server on 127.0.0.1.
// Spec: docs/superpowers/specs/2026-05-24-polybot-ui-design.md

const http = require('http');
const path = require('path');
const fs = require('fs');
const readers = require('./readers');

const ROOT = path.resolve(process.env.POLYBOT_UI_ROOT || path.join(__dirname, '..', '..'));
const PORT = parseInt(process.env.POLYBOT_UI_PORT || '8080', 10);
const HOST = process.env.POLYBOT_UI_HOST || '127.0.0.1';
const START_TS = Date.now();

function json(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': buf.length });
  res.end(buf);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/api/health') return json(res, 200, {
      ok: true,
      uptime: Math.floor((Date.now() - START_TS) / 1000),
      memoryUsage: process.memoryUsage(),
      root: ROOT,
    });
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    process.stderr.write(`handler error: ${e.stack}\n`);
    return json(res, 500, { error: e.message });
  }
}

const server = http.createServer((req, res) => { handle(req, res); });
server.listen(PORT, HOST, () => {
  const addr = server.address();
  process.stdout.write(`listening on http://${HOST}:${addr.port}\n`);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/ui/test_server.js`
Expected: `PASS - 0 failure(s)`.

- [ ] **Step 5: Commit**

```bash
git add scripts/ui/server.js scripts/ui/test_server.js
git commit -m "feat(ui): add HTTP server skeleton with /api/health"
```

---

### Task 7: `/api/state` endpoint

**Files:**
- Modify: `polymarket-cli/scripts/ui/server.js`
- Modify: `polymarket-cli/scripts/ui/test_server.js`

- [ ] **Step 1: Add the failing test**

Append in `test_server.js` (inside the IIFE, before `srv.proc.kill()`):

```js
  console.log('\n== server: /api/state ==');

  await test('/api/state returns aggregate with all fixture variants', async () => {
    const r = await fetch(srv.url + '/api/state');
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.ok(typeof j.generatedAt === 'number');
    const labels = j.variants.map(v => v.label).sort();
    assert.deepStrictEqual(labels, ['d', 'malformed', 'mastercopy']);
  });

  await test('/api/state d variant has correct totals', async () => {
    const r = await fetch(srv.url + '/api/state');
    const j = await r.json();
    const d = j.variants.find(v => v.label === 'd');
    assert.strictEqual(d.totals.entries, 5);
    assert.strictEqual(d.totals.exits, 5);
    assert.ok(Math.abs(d.totals.pnl - (-115.67)) < 0.01);
    assert.strictEqual(d.totals.stopExits, 1);
  });

  await test('/api/state malformed variant carries error, no crash', async () => {
    const r = await fetch(srv.url + '/api/state');
    const j = await r.json();
    const m = j.variants.find(v => v.label === 'malformed');
    assert.ok(m.error, 'expected error on malformed variant');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/ui/test_server.js`
Expected: `/api/state` returns 404.

- [ ] **Step 3: Implement `/api/state`**

In `scripts/ui/server.js`, add above `async function handle`:

```js
function buildStateAggregate() {
  const variants = readers.listVariants(path.join(ROOT, 'deploy'));
  const out = [];
  for (const v of variants) {
    const dataDir = v.dataDir ? path.join(ROOT, v.dataDir) : null;
    const ledger = dataDir
      ? readers.readLedger(dataDir)
      : { records: [], totals: { entries:0, exits:0, wins:0, losses:0, stopExits:0, pnl:0, deployed:0 }, cumulativePnl: [], error: 'no dataDir' };
    const state = dataDir ? readers.readState(dataDir) : { positions: [], decisionCounts: {} };
    const latestExit = (ledger.records || []).slice().reverse().find(r => r.kind === 'exit');
    out.push({
      label: v.label,
      service: v.service,
      description: v.description,
      env: v.env,
      args: v.args,
      dataDir: v.dataDir,
      totals: ledger.totals,
      openCount: state.positions.length,
      latestExit: latestExit ? { ts: latestExit.ts, pnl: latestExit.pnl, betSide: latestExit.betSide, won: latestExit.won } : null,
      cumulativePnl: ledger.cumulativePnl || [],
      error: v.error || ledger.error || state.error || null,
    });
  }
  return { generatedAt: Math.floor(Date.now() / 1000), variants: out };
}
```

Add inside `handle()`, above the existing `/api/health` block (so `/api/state` is matched first — order doesn't actually matter as both are exact-match, but keep blocks grouped):

```js
    if (p === '/api/state') return json(res, 200, buildStateAggregate());
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/ui/test_server.js`
Expected: PASS with three new `/api/state` tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/ui/server.js scripts/ui/test_server.js
git commit -m "feat(ui): add /api/state aggregate endpoint"
```

---

### Task 8: `/api/variant/:label` endpoint

**Files:**
- Modify: `polymarket-cli/scripts/ui/server.js`
- Modify: `polymarket-cli/scripts/ui/test_server.js`

- [ ] **Step 1: Add the failing test**

Append in `test_server.js`:

```js
  console.log('\n== server: /api/variant/:label ==');

  await test('/api/variant/d returns full data', async () => {
    const r = await fetch(srv.url + '/api/variant/d');
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.strictEqual(j.spec.label, 'd');
    assert.ok(j.ledger.length > 0, 'expected non-empty ledger');
    assert.strictEqual(j.totals.entries, 5);
    assert.strictEqual(j.positions.length, 1);
  });

  await test('/api/variant/unknown returns 404 with error JSON', async () => {
    const r = await fetch(srv.url + '/api/variant/unknown');
    assert.strictEqual(r.status, 404);
    const j = await r.json();
    assert.ok(j.error);
  });

  await test('/api/variant/<<bad>> rejects invalid label', async () => {
    const r = await fetch(srv.url + '/api/variant/' + encodeURIComponent('../etc'));
    assert.strictEqual(r.status, 400);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/ui/test_server.js`
Expected: 404 for `/api/variant/d`.

- [ ] **Step 3: Implement `/api/variant/:label`**

Add to `handle()` in `server.js`, above the `/api/state` line:

```js
    const variantMatch = p.match(/^\/api\/variant\/([^/]+)$/);
    if (variantMatch) {
      const label = decodeURIComponent(variantMatch[1]);
      if (!/^[a-z]{1,12}(-[a-z]+)?$/.test(label)) return json(res, 400, { error: 'invalid label' });
      const variants = readers.listVariants(path.join(ROOT, 'deploy'));
      const v = variants.find(x => x.label === label);
      if (!v) return json(res, 404, { error: 'unknown variant' });
      const dataDir = v.dataDir ? path.join(ROOT, v.dataDir) : null;
      const ledger = dataDir ? readers.readLedger(dataDir) : { records: [], totals: {}, error: 'no dataDir' };
      const state = dataDir ? readers.readState(dataDir) : { positions: [] };
      return json(res, 200, {
        spec: v,
        totals: ledger.totals,
        ledger: (ledger.records || []).slice(-200),
        positions: state.positions,
        decisionCounts: state.decisionCounts,
        parseErrors: ledger.parseErrors || 0,
        error: ledger.error || null,
      });
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/ui/test_server.js`
Expected: PASS with three new variant tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/ui/server.js scripts/ui/test_server.js
git commit -m "feat(ui): add /api/variant/:label endpoint with input validation"
```

---

### Task 9: `/api/logs/:label` endpoint

**Files:**
- Modify: `polymarket-cli/scripts/ui/server.js`
- Modify: `polymarket-cli/scripts/ui/test_server.js`

- [ ] **Step 1: Add the failing test**

Append in `test_server.js`:

```js
  console.log('\n== server: /api/logs/:label ==');

  await test('/api/logs/d returns parsed lines via fake journalctl', async () => {
    const r = await fetch(srv.url + '/api/logs/d');
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.strictEqual(j.error, null);
    assert.strictEqual(j.lines.length, 2);
    assert.ok(j.lines[0].message.includes('tick'));
  });

  await test('/api/logs/<<bad>> rejects invalid label', async () => {
    const r = await fetch(srv.url + '/api/logs/' + encodeURIComponent('../oops'));
    assert.strictEqual(r.status, 400);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/ui/test_server.js`
Expected: 404 for `/api/logs/d`.

- [ ] **Step 3: Implement `/api/logs/:label`**

Add to `handle()` in `server.js`:

```js
    const logsMatch = p.match(/^\/api\/logs\/([^/]+)$/);
    if (logsMatch) {
      const label = decodeURIComponent(logsMatch[1]);
      if (!/^[a-z]{1,12}(-[a-z]+)?$/.test(label)) return json(res, 400, { error: 'invalid label' });
      const variants = readers.listVariants(path.join(ROOT, 'deploy'));
      const v = variants.find(x => x.label === label);
      if (!v) return json(res, 404, { error: 'unknown variant' });
      const lines = parseInt(url.searchParams.get('lines') || '200', 10);
      const extraArgs = process.env.POLYBOT_UI_JOURNALCTL_ARGS
        ? [process.env.POLYBOT_UI_JOURNALCTL_ARGS]
        : [];
      const result = await readers.readJournal(v.service, { lines, extraArgs });
      return json(res, 200, result);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/ui/test_server.js`
Expected: PASS with two new logs tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/ui/server.js scripts/ui/test_server.js
git commit -m "feat(ui): add /api/logs/:label with injectable journalctl bin"
```

---

### Task 10: Static file serving (`/` and `/static/*`)

**Files:**
- Modify: `polymarket-cli/scripts/ui/server.js`
- Modify: `polymarket-cli/scripts/ui/test_server.js`
- Create: `polymarket-cli/scripts/ui/public/index.html` (minimal placeholder)
- Create: `polymarket-cli/scripts/ui/public/app.js` (placeholder)
- Create: `polymarket-cli/scripts/ui/public/styles.css` (placeholder)

- [ ] **Step 1: Create placeholder static files**

Create `scripts/ui/public/index.html`:

```html
<!doctype html>
<meta charset="utf-8">
<title>polyBOT</title>
<link rel="stylesheet" href="/static/styles.css">
<div id="root">loading...</div>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<script src="/static/render.js"></script>
<script src="/static/app.js"></script>
```

Create `scripts/ui/public/app.js`:

```js
// Placeholder. Real orchestration arrives in Phase C.
document.getElementById('root').textContent = 'polyBOT UI placeholder';
```

Create `scripts/ui/public/styles.css`:

```css
/* Placeholder. Real styles arrive in Phase C. */
body { font-family: ui-monospace, monospace; background: #111; color: #eee; }
```

- [ ] **Step 2: Add the failing test**

Append in `test_server.js`:

```js
  console.log('\n== server: static files ==');

  await test('GET / returns index.html', async () => {
    const r = await fetch(srv.url + '/');
    assert.strictEqual(r.status, 200);
    assert.ok((r.headers.get('content-type') || '').includes('html'));
    const body = await r.text();
    assert.ok(body.includes('<div id="root">'));
  });

  await test('GET /static/styles.css returns css', async () => {
    const r = await fetch(srv.url + '/static/styles.css');
    assert.strictEqual(r.status, 200);
    assert.ok((r.headers.get('content-type') || '').includes('css'));
  });

  await test('GET /static/../etc/passwd is rejected', async () => {
    const r = await fetch(srv.url + '/static/' + encodeURIComponent('../../../etc/passwd'));
    assert.strictEqual(r.status, 400);
  });
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node scripts/ui/test_server.js`
Expected: 404 for `/` and `/static/*`.

- [ ] **Step 4: Implement static file serving in `server.js`**

Add at the top of `handle()` (before any other route checks):

```js
    if (p === '/' || p === '/index.html') {
      const buf = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': buf.length });
      return res.end(buf);
    }
    const staticMatch = p.match(/^\/static\/([A-Za-z0-9._-]+)$/);
    if (staticMatch) {
      const name = staticMatch[1];
      const file = path.join(__dirname, 'public', name);
      const publicDir = path.join(__dirname, 'public');
      if (!file.startsWith(publicDir + path.sep) && file !== publicDir) {
        return json(res, 400, { error: 'invalid path' });
      }
      let buf;
      try { buf = fs.readFileSync(file); } catch { return json(res, 404, { error: 'not found' }); }
      const ct = name.endsWith('.css') ? 'text/css' :
                 name.endsWith('.js')  ? 'application/javascript' :
                 name.endsWith('.html') ? 'text/html; charset=utf-8' :
                 'application/octet-stream';
      res.writeHead(200, { 'content-type': ct, 'content-length': buf.length });
      return res.end(buf);
    }
```

The `[A-Za-z0-9._-]+` regex already rejects `..` and `/`; the path-startsWith check is belt-and-braces.

- [ ] **Step 5: Run test to verify it passes**

Run: `node scripts/ui/test_server.js`
Expected: PASS with three new static-file tests.

- [ ] **Step 6: Commit**

```bash
git add scripts/ui/server.js scripts/ui/test_server.js scripts/ui/public/
git commit -m "feat(ui): add static file serving for / and /static/*"
```

---

### Task 11: Integration cross-check against `compare.js`

**Files:**
- Modify: `polymarket-cli/scripts/ui/test_server.js`

This task asserts that for strategy variants, `/api/state` totals match `compare.js`. `compare.js` discovers `polybot-strategy-*.service` only — so the cross-check covers `d` in our fixtures.

- [ ] **Step 1: Add the cross-check test**

Append in `test_server.js`:

```js
  console.log('\n== cross-check: /api/state vs compare.js ==');

  const { spawnSync } = require('child_process');

  await test('strategy-d totals match compare.js output', async () => {
    const r = await fetch(srv.url + '/api/state');
    const j = await r.json();
    const dApi = j.variants.find(v => v.label === 'd');

    const cmpOut = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'strategy', 'compare.js'),
    ], {
      env: {
        ...process.env,
        STRATEGY_COMPARE_DIRS: `d:${path.join(FIX, 'scripts/strategy/data-d')}`,
      },
      encoding: 'utf8',
    });
    assert.strictEqual(cmpOut.status, 0, cmpOut.stderr);

    const pnlMatch = cmpOut.stdout.match(/Realized PnL\s+\$(-?\d+\.\d+)/);
    assert.ok(pnlMatch, `couldn't find Realized PnL in:\n${cmpOut.stdout}`);
    const cmpPnl = parseFloat(pnlMatch[1]);
    assert.ok(Math.abs(cmpPnl - dApi.totals.pnl) < 0.01,
      `UI says ${dApi.totals.pnl}, compare.js says ${cmpPnl}`);
  });
```

- [ ] **Step 2: Run test to verify it passes**

Run: `node scripts/ui/test_server.js`
Expected: cross-check passes. If `compare.js` errors because `STRATEGY_COMPARE_DIRS` parsing differs from what's documented, read `scripts/strategy/compare.js:18-25` and adjust the env-var format.

- [ ] **Step 3: Commit**

```bash
git add scripts/ui/test_server.js
git commit -m "test(ui): cross-check /api/state totals against compare.js"
```

---

## Phase C — Frontend (6 tasks)

### Task 12: `render.js` pure helpers + `test_render.js`

**Files:**
- Create: `polymarket-cli/scripts/ui/public/render.js`
- Create: `polymarket-cli/scripts/ui/test_render.js`

- [ ] **Step 1: Write the failing test**

Create `scripts/ui/test_render.js`:

```js
const assert = require('assert');
const render = require('./public/render');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n    ${e.message}`); failed++; }
}

console.log('== render.parseHash ==');
test('default empty hash is overview', () => {
  assert.deepStrictEqual(render.parseHash(''), { view: 'overview' });
});
test('"#/" is overview', () => {
  assert.deepStrictEqual(render.parseHash('#/'), { view: 'overview' });
});
test('"#/variant/d" parses', () => {
  assert.deepStrictEqual(render.parseHash('#/variant/d'), { view: 'variant', label: 'd' });
});
test('"#/logs/k" parses', () => {
  assert.deepStrictEqual(render.parseHash('#/logs/k'), { view: 'logs', label: 'k' });
});
test('invalid hash falls back to overview', () => {
  assert.deepStrictEqual(render.parseHash('#/garbage/path/here'), { view: 'overview' });
});

console.log('\n== render.formatPnl ==');
test('positive pnl gets + prefix', () => {
  assert.strictEqual(render.formatPnl(16.56), '+$16.56');
});
test('negative pnl gets - prefix without double-sign', () => {
  assert.strictEqual(render.formatPnl(-100), '-$100.00');
});
test('zero pnl is $0.00', () => {
  assert.strictEqual(render.formatPnl(0), '$0.00');
});

console.log('\n== render.buildOverviewRow ==');
test('returns a tr string with WR and PnL', () => {
  const v = {
    label: 'd', description: 'BTC 15m', totals: { exits: 36, wins: 31, losses: 5, pnl: 16.56, deployed: 3600 },
    args: { observeMin: 11, threshBps: 6 }, env: { MAX_FILL_PRICE: '0.92' }, openCount: 0, error: null,
  };
  const row = render.buildOverviewRow(v);
  assert.ok(row.includes('<tr'), row);
  assert.ok(row.includes('D'));
  assert.ok(row.includes('86.1%'), `expected WR 86.1% in row: ${row}`);
  assert.ok(row.includes('+$16.56'));
});

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} - ${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/ui/test_render.js`
Expected: `Cannot find module './public/render'`.

- [ ] **Step 3: Implement `render.js`**

Create `scripts/ui/public/render.js`:

```js
// Pure helpers for the polyBOT UI frontend. DOM-free so they can be unit-tested
// in Node. Loaded in the browser via <script src="/static/render.js"> and exposed
// on `window.polybotRender`.

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
        let detail = '';
        if (r.kind === 'entry') detail = `@${(r.avgFillPrice||0).toFixed(3)} x ${(r.paperShares||0).toFixed(1)}sh`;
        else if (r.kind === 'exit') detail = `${r.won ? 'WIN' : 'LOSS'} ${formatPnl(r.pnl||0)}${r.stoppedOut ? ' STOP' : ''}`;
        else detail = `reason=${escapeHtml(r.reason || '?')}`;
        return `<tr><td>${ts}</td><td>${escapeHtml(r.kind)}</td><td class="muted">${escapeHtml(slug)}</td><td>${escapeHtml(r.betSide || '')}</td><td class="num">${detail}</td></tr>`;
      }).join('') +
      `</tbody></table>`;
  }

  function buildLogsList(lines) {
    if (!lines || !lines.length) return `<p class="muted">No log lines.</p>`;
    return `<pre class="logs">` + lines.map(l => {
      const t = new Date((l.ts || 0) * 1000).toISOString().slice(11, 19);
      return `<span class="ts">${t}</span>  ${escapeHtml(l.message)}`;
    }).join('\n') + `</pre>`;
  }

  return { parseHash, formatPnl, escapeHtml, buildOverviewRow, buildVariantSpec, buildLedgerTable, buildLogsList };
}));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/ui/test_render.js`
Expected: `PASS - 0 failure(s)`.

- [ ] **Step 5: Commit**

```bash
git add scripts/ui/public/render.js scripts/ui/test_render.js
git commit -m "feat(ui): add pure render helpers (parseHash, formatPnl, buildOverviewRow)"
```

---

### Task 13: HTML shell + sidebar + CSS

**Files:**
- Modify: `polymarket-cli/scripts/ui/public/index.html`
- Modify: `polymarket-cli/scripts/ui/public/styles.css`

No automated tests for HTML/CSS — manual smoke check at the end.

- [ ] **Step 1: Replace `index.html` with the real shell**

Replace `scripts/ui/public/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=1200">
  <title>polyBOT</title>
  <link rel="stylesheet" href="/static/styles.css">
</head>
<body>
<header>
  <strong>polyBOT</strong>
  <span id="status" class="status">connecting...</span>
</header>
<main>
  <nav id="sidebar"></nav>
  <section id="root">loading...</section>
</main>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<script src="/static/render.js"></script>
<script src="/static/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Replace `styles.css` with the dark theme**

Replace `scripts/ui/public/styles.css`:

```css
:root {
  --bg: #0d1117;
  --panel: #161b22;
  --border: #30363d;
  --fg: #e6edf3;
  --muted: #8b949e;
  --pos: #3fb950;
  --neg: #f85149;
  --accent: #58a6ff;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; height: 100%; background: var(--bg); color: var(--fg);
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 13px; }
header { display: flex; align-items: center; gap: 16px; padding: 8px 16px; border-bottom: 1px solid var(--border); }
header strong { font-size: 15px; letter-spacing: 0.5px; }
.status { margin-left: auto; color: var(--muted); }
.status.fresh { color: var(--pos); }
.status.stale { color: var(--neg); }
main { display: flex; height: calc(100% - 40px); }
nav { width: 180px; border-right: 1px solid var(--border); padding: 12px 0; background: var(--panel); overflow-y: auto; }
nav a { display: block; padding: 6px 16px; color: var(--fg); text-decoration: none; }
nav a:hover { background: rgba(255,255,255,0.04); }
nav a.active { background: rgba(88,166,255,0.15); border-left: 2px solid var(--accent); padding-left: 14px; }
nav .group { padding: 12px 16px 4px; font-size: 11px; text-transform: uppercase; color: var(--muted); letter-spacing: 0.5px; }
#root { flex: 1; padding: 16px 24px; overflow: auto; }

table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--border); }
th { color: var(--muted); font-weight: normal; font-size: 11px; text-transform: uppercase; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.pos { color: var(--pos); }
.neg { color: var(--neg); }
.muted { color: var(--muted); }

.badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 11px; background: var(--border); color: var(--muted); margin-left: 6px; }
.badge.err { background: rgba(248,81,73,0.15); color: var(--neg); }

.spec dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; }
.spec dt { color: var(--muted); }
.spec dd { margin: 0; }

.ledger tbody tr:hover { background: rgba(255,255,255,0.03); }
.logs { background: #010409; padding: 12px; border-radius: 4px; overflow-x: auto;
  font-size: 12px; line-height: 1.4; max-height: 70vh; }
.logs .ts { color: var(--muted); }

.toolbar { display: flex; gap: 8px; padding: 8px 0; align-items: center; }
.toolbar select, .toolbar button { background: var(--panel); color: var(--fg); border: 1px solid var(--border);
  padding: 4px 8px; border-radius: 4px; font: inherit; }

.banner { background: var(--neg); color: white; padding: 6px 16px; text-align: center; font-weight: bold; }
.empty { padding: 40px; text-align: center; color: var(--muted); }
```

- [ ] **Step 3: Manual smoke check**

Run locally:
```bash
POLYBOT_UI_ROOT=scripts/ui/__fixtures__ node scripts/ui/server.js
```

Open `http://localhost:8080`. Expect:
- Header with "polyBOT" text and a "connecting..." status
- Sidebar on the left (initially empty - populated when app.js runs)
- `loading...` placeholder in the main pane

Stop the server (Ctrl-C).

- [ ] **Step 4: Commit**

```bash
git add scripts/ui/public/index.html scripts/ui/public/styles.css
git commit -m "feat(ui): add HTML shell and dark-theme styles"
```

---

### Task 14: `app.js` orchestration (boot, polling, view dispatch)

**Files:**
- Replace: `polymarket-cli/scripts/ui/public/app.js`

- [ ] **Step 1: Replace `app.js`**

Replace `scripts/ui/public/app.js`:

```js
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
```

- [ ] **Step 2: Manual smoke check**

Start server against fixtures:
```bash
POLYBOT_UI_ROOT=scripts/ui/__fixtures__ JOURNALCTL_BIN=node \
  POLYBOT_UI_JOURNALCTL_ARGS=scripts/ui/__fixtures__/fake-journalctl.js \
  node scripts/ui/server.js
```

Open `http://localhost:8080`. Verify:
- Header status flips to `* 15s | <time>` (green)
- Sidebar shows: Overview / D / MALFORMED / MASTERCOPY / Logs
- Overview table has 3 rows; D shows `5 (3W/2L)` exits, `-$115.67` PnL
- Click `D` -> variant detail page shows env vars + ledger table
- Change filter to "stops only" -> only the 1 stop-out row remains
- Click "View logs ->" -> logs page shows 2 fake-journalctl lines
- Wait 15s -> header timestamp updates
- Stop server (Ctrl-C) -> within ~45s the red banner appears at the top
- Restart server -> banner clears within 15s

If any step fails, fix and re-test before committing.

- [ ] **Step 3: Commit**

```bash
git add scripts/ui/public/app.js
git commit -m "feat(ui): add app.js orchestration with hash router, polling, chart, banner"
```

---

### Task 15: Run the full local test suite

**Files:** none (CI-style verification)

- [ ] **Step 1: Run all three test files**

```bash
node scripts/ui/test_readers.js && node scripts/ui/test_render.js && node scripts/ui/test_server.js
```

Expected: each script prints `PASS - 0 failure(s)` and exits 0.

If any failure: fix the root cause, don't paper over by adjusting tests to match buggy code. Re-run until all green.

- [ ] **Step 2: Confirm**

This is a verification gate, not a code change. Once green, proceed to Phase D.

---

## Phase D — Deployment (1 task)

### Task 16: Add `polybot-ui.service`, deploy on server, smoke test

**Files:**
- Create: `polymarket-cli/deploy/polybot-ui.service`
- Modify: `polymarket-cli/deploy/redeploy.sh` (one-line addition to `discover_services()`)
- Modify: `polymarket-cli/docs/server-commands.md`

- [ ] **Step 1: Create the systemd unit**

Create `polymarket-cli/deploy/polybot-ui.service`:

```ini
[Unit]
Description=polyBOT UI - read-only dashboard server on 127.0.0.1:8080
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=polybot
Group=polybot
WorkingDirectory=/opt/polybot/polymarket-cli
Environment=POLYBOT_UI_ROOT=/opt/polybot/polymarket-cli
Environment=POLYBOT_UI_PORT=8080
Environment=POLYBOT_UI_HOST=127.0.0.1
ExecStart=/usr/bin/node /opt/polybot/polymarket-cli/scripts/ui/server.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=polybot-ui
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=read-only

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Update `redeploy.sh`'s service discovery**

Open `polymarket-cli/deploy/redeploy.sh` and find the `discover_services()` function. The existing `extra` loop currently iterates `polybot-snapshot polybot-mastercopy polybot-mastercopy-sells` (the exact list may differ — match what's there). Add `polybot-ui` to that list.

Read the function first to find the exact location. Replicate the existing pattern; the change is one token added to a space-separated list.

- [ ] **Step 3: Document the new daemon in `docs/server-commands.md`**

Open `polymarket-cli/docs/server-commands.md` and:
1. Add a row for `polybot-ui` in the "Current live daemons" table — Role: `Read-only browser dashboard on 127.0.0.1:8080 via SSH tunnel`.
2. Append `polybot-ui` to the service-health one-liner's `for s in ...` list.
3. Add a new section "Browser dashboard (UI)" near the top, with the SSH tunnel command:

   ```bash
   ssh -i C:\Users\nicol\MY_CLAUDE_DATA\auto_tradeBot\autoTradeBot_key.pem \
       -L 8080:127.0.0.1:8080 ubuntu@44.217.72.62
   # then open http://localhost:8080 in a browser on the laptop
   ```

- [ ] **Step 4: Commit and push**

```bash
git add deploy/polybot-ui.service deploy/redeploy.sh docs/server-commands.md
git commit -m "feat(deploy): add polybot-ui.service systemd unit + redeploy hook + docs"
git push origin main
```

- [ ] **Step 5: Deploy on the server**

```bash
ssh -i C:/Users/nicol/MY_CLAUDE_DATA/auto_tradeBot/autoTradeBot_key.pem ubuntu@44.217.72.62 \
  'sudo -u polybot git -C /opt/polybot/polymarket-cli pull --ff-only && \
   sudo cp /opt/polybot/polymarket-cli/deploy/polybot-ui.service /etc/systemd/system/ && \
   sudo systemctl daemon-reload && \
   sudo systemctl enable --now polybot-ui && \
   sleep 3 && \
   systemctl is-active polybot-ui && \
   curl -s http://127.0.0.1:8080/api/health'
```

Expected: `active` printed, then JSON with `"ok":true`.

- [ ] **Step 6: SSH tunnel + browser smoke**

From the laptop, in a new terminal that you keep open:
```bash
ssh -i C:/Users/nicol/MY_CLAUDE_DATA/auto_tradeBot/autoTradeBot_key.pem \
    -L 8080:127.0.0.1:8080 ubuntu@44.217.72.62
```

In a browser, open `http://localhost:8080`. Verify:

- [ ] Sidebar shows D, H, I, J, K, mastercopy (+ any retired daemons with badges)
- [ ] Overview totals for D match `node scripts/strategy/compare.js` output on the server
- [ ] Click K -> spec shows `stopLoss=10bps` env var
- [ ] Click "View logs ->" on K -> live tail of `journalctl -u polybot-strategy-k`
- [ ] Wait 15s on overview -> updates if new exit, otherwise unchanged
- [ ] Rename a ledger on the server: `sudo mv /opt/polybot/polymarket-cli/scripts/strategy/data-d/strategy-ledger.jsonl{,.bak}` -> within 15s, D row shows "no ledger yet" badge. Restore: `sudo mv ...{.bak,}` -> row recovers within 15s.

- [ ] **Step 7: If all smoke items pass, the v1 ship is done.**

If any item fails, document the failure. Rollback: `sudo systemctl disable --now polybot-ui` then debug.

---

## Self-review checklist

**1. Spec coverage:** Each spec section maps to one or more tasks.
- § 1 purpose / § 2 goals -> covered by overall plan
- § 3 architecture -> Task 6 (server skeleton), Task 16 (systemd unit)
- § 4.1 readers -> Tasks 1-5
- § 4.2 endpoints -> Tasks 6-10 (health, state, variant, logs, static)
- § 4.3 frontend -> Tasks 12, 14
- § 4.4 layout -> Tasks 13, 14
- § 5 data flow -> Tasks 7, 14 (polling, render dispatch)
- § 6 error handling -> Tasks 7, 8, 9 (per-endpoint), Task 14 (banner)
- § 7 testing -> Tasks 1-12 (each TDD'd), Task 11 (cross-check), Task 15 (full suite)
- § 8 acceptance criteria -> Task 15 + Task 16 smoke
- § 9 deployment -> Task 16
- § 10 future work -> out of scope by design

**2. Placeholder scan:** No "TBD" / "TODO" / "implement later" anywhere; every code block is complete.

**3. Type / name consistency:**
- `parseHash`, `formatPnl`, `buildOverviewRow`, `buildVariantSpec`, `buildLedgerTable`, `buildLogsList`, `escapeHtml` used consistently between render.js, app.js, and tests
- `listVariants` returns `{label, service, description, env, args, dataDir, error}` — matches consumption in server.js (`buildStateAggregate`, `/api/variant`, `/api/logs`)
- `readLedger` returns `{records, totals, cumulativePnl, parseErrors, error?}` — matches `/api/state` and `/api/variant`
- `readJournal` returns `{lines, error}` — matches `/api/logs`
- Env vars `POLYBOT_UI_ROOT`, `POLYBOT_UI_PORT`, `POLYBOT_UI_HOST`, `POLYBOT_UI_JOURNALCTL_ARGS`, `JOURNALCTL_BIN` used consistently across server.js, test_server.js, and polybot-ui.service

**4. Build order:** readers (testable, no deps) -> server (depends on readers) -> frontend (depends on server) -> deploy (depends on everything). Tasks 1->16 in strict dependency order. Tests are written **before** the code they test in every task.
