# Lightsail deployment

Runs the polyBOT strategy bot + orderbook snapshot daemon as systemd services on Ubuntu (22.04 or 24.04). Mirrors the layout of the existing `/opt/tradebot/` deployment.

## What you'll end up with

```
/opt/polybot/polymarket-cli/                 ← git clone
└── polymarket-cli/
    ├── target/release/polymarket     ← Rust binary, built on first deploy
    ├── scripts/
    │   ├── strategy/data/            ← strategy-ledger.jsonl, strategy-state.json
    │   └── research/data/            ← orderbook_snapshots.jsonl, snapshot_schedule.json
    └── deploy/
        ├── setup.sh                  ← one-time provisioning
        ├── redeploy.sh               ← pull + rebuild + restart
        ├── polybot-strategy.service  ← strategy bot unit
        └── polybot-snapshot.service  ← orderbook snapshot unit
```

Two long-lived systemd services run as user `polybot`:

| Service | Command (paraphrased) | Restart |
|---|---|---|
| `polybot-strategy` | `node scripts/strategy/main.js 13 5 100 168` | always |
| `polybot-snapshot` | `node scripts/research/snapshot_orderbooks.js 11 168` | always |

## One-time deploy

### 1. Push polyBOT to a private git remote (laptop)

```powershell
# from the polyBOT root (parent of polymarket-cli/)
cd C:\Users\nicol\MY_CLAUDE_DATA\polyBOT
git init                     # if not already a repo
git add -A
git commit -m "initial commit: polyBOT phase 2"
# create a private GitHub repo first, then:
git remote add origin git@github.com:<you>/polyBOT.git
git push -u origin main
```

The repo root must be the parent of `polymarket-cli/` so the deploy paths resolve as `/opt/polybot/polymarket-cli/...`.

### 2. SSH into Lightsail

```bash
ssh -i /c/Users/nicol/MY_CLAUDE_DATA/auto_tradeBot/autoTradeBot_key.pem ubuntu@<lightsail-ip>
```

### 3. Run setup

```bash
curl -fsSL https://raw.githubusercontent.com/<you>/polyBOT/main/polymarket-cli/deploy/setup.sh -o /tmp/setup.sh
sudo bash /tmp/setup.sh https://github.com/<you>/polyBOT.git
```

This will:
- install Node.js 24, Rust toolchain
- create `polybot` user
- clone repo to `/opt/polybot/polyBOT`
- run `cargo build --release` (5–15 min first time)
- install the two systemd units
- enable + start both services

### 4. Verify

```bash
sudo systemctl status polybot-strategy polybot-snapshot
journalctl -u polybot-strategy -n 20 --no-pager
journalctl -u polybot-snapshot -n 20 --no-pager
sudo -u polybot node /opt/polybot/polymarket-cli/scripts/strategy/status.js
```

Confirm Polymarket reachability before debugging anything else:
```bash
curl -s 'https://gamma-api.polymarket.com/markets?limit=1' | head -c 200
```
(Should return JSON. If empty/timeout, it's a network issue specific to the server — usually fine from US-region Lightsail.)

## Updating after code changes

On laptop:
```powershell
git add -A && git commit -m "tweak strategy params" && git push
```

On server:
```bash
sudo bash /opt/polybot/polymarket-cli/deploy/redeploy.sh
```

Flags: `--skip-build`, `--force-build`, `--skip-pull`, `--no-status`.

## Day-to-day operations

| Action | Command |
|---|---|
| Live tail strategy log | `journalctl -u polybot-strategy -f` |
| Live tail snapshot log | `journalctl -u polybot-snapshot -f` |
| Summary (entries/PnL) | `sudo -u polybot node /opt/polybot/polymarket-cli/scripts/strategy/status.js` |
| Restart strategy only | `sudo systemctl restart polybot-strategy` |
| Stop everything | `sudo systemctl stop polybot-strategy polybot-snapshot` |
| Disable on boot | `sudo systemctl disable polybot-strategy polybot-snapshot` |
| Wipe ledger (start fresh) | `sudo systemctl stop polybot-strategy && sudo rm /opt/polybot/polymarket-cli/scripts/strategy/data/strategy-* && sudo systemctl start polybot-strategy` |

## Pull ledger back to laptop for analysis

```bash
# from laptop
scp -i autoTradeBot_key.pem ubuntu@<ip>:/opt/polybot/polymarket-cli/scripts/strategy/data/strategy-ledger.jsonl ./
scp -i autoTradeBot_key.pem ubuntu@<ip>:/opt/polybot/polymarket-cli/scripts/research/data/orderbook_snapshots.jsonl ./
```

## Notes

- **No private key needed yet.** Paper mode reads only public endpoints. When live trading is added, drop a `.env` into `/opt/polybot/polymarket-cli/.env` (chown polybot:polybot, chmod 600) containing `POLYMARKET_PRIVATE_KEY=0x...`. Both scripts inherit env via systemd.
- **First build takes 5–15 minutes.** Mostly compiling `aws-lc-sys` and `alloy` crates. Subsequent rebuilds are fast (~30s) unless `Cargo.lock` changed.
- **Disk usage:** each ledger grows ~1MB/day. After a month, ~30MB. Logrotate isn't needed at this scale.
- **Don't kill the laptop bots until the server is running and producing entries.** Either run both in parallel for a day as a cross-check, or stop the laptop bot and start fresh on the server.
- **Optional: migrate existing ledger to server** so PnL is continuous:
  ```bash
  scp -i key.pem scripts/strategy/data/strategy-* ubuntu@<ip>:/tmp/
  ssh ... 'sudo mv /tmp/strategy-* /opt/polybot/polymarket-cli/scripts/strategy/data/ && sudo chown polybot:polybot /opt/polybot/polymarket-cli/scripts/strategy/data/*'
  ```
