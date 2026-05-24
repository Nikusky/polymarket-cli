# polyBOT server commands

Copy-paste cheat sheet for inspecting and operating the polyBOT daemons running on the AWS Lightsail Ubuntu instance (us-east-1a Virginia, static IP `44.217.72.62`).

All commands assume you have first SSH'd into the server unless explicitly marked as "from laptop".

## Connect (from laptop)

```powershell
ssh -i C:\Users\nicol\MY_CLAUDE_DATA\auto_tradeBot\autoTradeBot_key.pem ubuntu@44.217.72.62
```

## Current live daemons (2026-05-24)

| Service | Role | Data dir |
|---|---|---|
| `polybot-strategy-d` | BTC 15m directional (control) | `scripts/strategy/data-d/` |
| `polybot-strategy-h` | ETH 15m directional | `scripts/strategy/data-h/` |
| `polybot-mastercopy` | Paper BUY mirror of cE25 / b55fa / Truthful-Firewall | `scripts/mastercopy/data-mc/` |
| `polybot-snapshot` | Orderbook capture | `scripts/research/data/` |

Retired (`inactive / disabled`):
- `polybot-strategy-g` — BTC 5m, bled −$754, stopped 2026-05-24
- `polybot-mastercopy-sells` — paper inverse-mirror of master SELLs, stopped 2026-05-24 after data showed masters never SELL (0 / 600 sampled trades)

## Service health (one-liner)

```bash
for s in polybot-strategy-d polybot-strategy-g polybot-strategy-h polybot-mastercopy polybot-mastercopy-sells polybot-snapshot; do
  echo "$s: $(systemctl is-active $s) / $(systemctl is-enabled $s)"
done
```

## Per-daemon PnL summary

```bash
# BTC 15m control (D)
sudo -u polybot env STRATEGY_DATA_DIR=/opt/polybot/polymarket-cli/scripts/strategy/data-d \
  node /opt/polybot/polymarket-cli/scripts/strategy/status.js

# ETH 15m (H)
sudo -u polybot env STRATEGY_DATA_DIR=/opt/polybot/polymarket-cli/scripts/strategy/data-h \
  node /opt/polybot/polymarket-cli/scripts/strategy/status.js

# Mastercopy BUY paper mirror
sudo -u polybot env STRATEGY_DATA_DIR=/opt/polybot/polymarket-cli/scripts/mastercopy/data-mc \
  node /opt/polybot/polymarket-cli/scripts/strategy/status.js 2>&1 | head -16
```

> Note: `status.js` currently crashes printing the open-positions list for mirror-kind entries (TypeError on `avgFillPrice`). The summary block prints first, so `head -16` truncates safely. Fix tracked separately.

## Live tail (Ctrl-C to exit)

```bash
journalctl -u polybot-strategy-d -f         # BTC 15m
journalctl -u polybot-strategy-h -f         # ETH 15m
journalctl -u polybot-mastercopy -f         # master BUY mirror
journalctl -u polybot-snapshot -f           # orderbook capture
```

## Recent history (no follow)

```bash
journalctl -u polybot-strategy-d -n 50 --no-pager
journalctl -u polybot-mastercopy --since="1 hour ago" --no-pager
```

## Raw ledger inspection

```bash
# Line counts
sudo wc -l /opt/polybot/polymarket-cli/scripts/strategy/data-d/strategy-ledger.jsonl \
           /opt/polybot/polymarket-cli/scripts/strategy/data-h/strategy-ledger.jsonl \
           /opt/polybot/polymarket-cli/scripts/mastercopy/data-mc/strategy-ledger.jsonl

# Last 10 exits with PnL (D)
sudo grep '"event":"exit"' /opt/polybot/polymarket-cli/scripts/strategy/data-d/strategy-ledger.jsonl | tail -10

# Cumulative realized PnL across a ledger (D)
sudo cat /opt/polybot/polymarket-cli/scripts/strategy/data-d/strategy-ledger.jsonl \
  | jq -s '[.[] | select(.event=="exit") | .pnl] | add'
```

## Open positions + state snapshot

```bash
sudo cat /opt/polybot/polymarket-cli/scripts/strategy/data-d/strategy-state.json | jq '.positions'
sudo cat /opt/polybot/polymarket-cli/scripts/mastercopy/data-mc/strategy-state.json | jq '.positions | length'
```

## Master trade feed (direct from data-api, bypasses bot)

```bash
for addr in 0xce25e214d5cfe4f459cf67f08df581885aae7fdc \
            0xb55fa1296e6ec55d0ce53d93b9237389f11764d4 \
            0xa9239c0ca3dee2d03232481212474e1d781b6704; do
  echo "=== $addr ==="
  curl -s "https://data-api.polymarket.com/trades?user=$addr&limit=50" \
    | jq '[.[] | {slug, side, price, size, ts: .timestamp}] | .[0:5]'
done
```

BUY/SELL count for a master over the last ~24h:

```bash
ADDR=0xce25e214d5cfe4f459cf67f08df581885aae7fdc
curl -s "https://data-api.polymarket.com/trades?user=$ADDR&limit=200" \
  | jq '{buys:[.[] | select(.side=="BUY")] | length, sells:[.[] | select(.side=="SELL")] | length, n:length}'
```

## Disk / process snapshot

```bash
df -h /                                                                       # disk
free -m                                                                        # RAM (matters for Rust rebuilds)
ps -u polybot -o pid,etime,cmd | head                                          # bot processes + uptime
sudo du -sh /opt/polybot/polymarket-cli/scripts/*/data-*/ 2>/dev/null          # ledger sizes
```

## Restart / stop / enable

```bash
sudo systemctl restart polybot-strategy-d
sudo systemctl stop    polybot-strategy-h     # stop now (no reboot persistence)
sudo systemctl disable polybot-strategy-h     # don't autostart on reboot
sudo systemctl enable  polybot-strategy-h     # autostart on reboot
```

## Wipe a variant's ledger (start fresh)

```bash
sudo systemctl stop polybot-strategy-d
sudo rm /opt/polybot/polymarket-cli/scripts/strategy/data-d/strategy-*
sudo systemctl start polybot-strategy-d
```

## Redeploy after `git push` from laptop

```bash
sudo bash /opt/polybot/polymarket-cli/deploy/redeploy.sh --skip-build
# flags: --skip-build (JS-only changes), --force-build (Rust), --skip-pull, --no-status
```

> Important: `redeploy.sh` does NOT sync `deploy/*.service` unit files into `/etc/systemd/system/`. After editing env vars or `ExecStart=` in a unit file, manually:
>
> ```bash
> sudo cp /opt/polybot/polymarket-cli/deploy/polybot-X.service /etc/systemd/system/
> sudo systemctl daemon-reload
> sudo systemctl restart polybot-X
> ```
>
> Verify with `systemctl show polybot-X --property=Environment`.

## Pull ledgers back to laptop (from laptop)

```powershell
scp -i C:\Users\nicol\MY_CLAUDE_DATA\auto_tradeBot\autoTradeBot_key.pem `
  ubuntu@44.217.72.62:/opt/polybot/polymarket-cli/scripts/strategy/data-d/strategy-ledger.jsonl `
  C:\Users\nicol\MY_CLAUDE_DATA\polyBOT\polymarket-cli\analysis\
```

## Gotchas

- **Binance is HTTP 451 from this server** (AWS US). Strategy bot uses Coinbase + Kraken median in `scripts/strategy/btc_price.js` — do not switch to Binance without moving region.
- **systemd `ReadWritePaths`:** when adding a new variant, `sudo -u polybot mkdir -p .../data-<X>/` BEFORE first `systemctl start`, otherwise the namespace setup fails (status 226).
- **Rust build needs >1GB RAM.** On 512MB swap was added pre-first-build. After any resize, re-add swap before `--force-build`.
- **scp-deploy residue:** if you scp files to the server then later commit + push the same content, `git pull` rejects fast-forward. Recovery: `sudo -u polybot git -C /opt/polybot/polymarket-cli stash push --include-untracked -m residue && git pull --ff-only && git stash drop`.

See also: `deploy/redeploy.sh`, `scripts/strategy/status.js`, `scripts/mastercopy/main.js`.
