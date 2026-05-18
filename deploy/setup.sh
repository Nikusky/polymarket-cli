#!/usr/bin/env bash
# One-time server provisioning for polyBOT on Ubuntu 22.04/24.04.
#
# Usage: sudo bash setup.sh <REPO_URL>
#   REPO_URL is the polyBOT git remote (e.g. https://github.com/you/polyBOT.git)
#
# What this does:
#   - Installs Node.js 24, Rust toolchain, build deps
#   - Creates a dedicated `polybot` user
#   - Clones the repo to /opt/polybot/polymarket-cli
#   - Builds the polymarket Rust CLI (release mode)
#   - Installs systemd units for the strategy bot and orderbook snapshot daemon
#   - Enables and starts both services

set -euo pipefail

REPO_URL="${1:?Usage: setup.sh <REPO_URL>}"

if [[ $EUID -ne 0 ]]; then
    exec sudo bash "$0" "$@"
fi

log() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
ok()  { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }

# ── System packages ──────────────────────────────────────────────────────────
log "Installing system packages"
apt-get update -y
apt-get install -y curl git build-essential pkg-config libssl-dev ca-certificates
ok "Base packages installed"

# ── Node.js 24 ──────────────────────────────────────────────────────────────
if ! node --version 2>/dev/null | grep -q '^v24'; then
    log "Installing Node.js 24"
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
    apt-get install -y nodejs
fi
ok "Node $(node --version) installed"

# ── Dedicated user ───────────────────────────────────────────────────────────
id polybot &>/dev/null || useradd --system --create-home --shell /bin/bash polybot
ok "User polybot exists"

# ── Directory layout ─────────────────────────────────────────────────────────
mkdir -p /opt/polybot
chown polybot:polybot /opt/polybot

# ── Clone repo ───────────────────────────────────────────────────────────────
REPO_DIR=/opt/polybot/polymarket-cli
if [ ! -d "$REPO_DIR" ]; then
    log "Cloning repo"
    sudo -u polybot git clone "$REPO_URL" "$REPO_DIR"
else
    log "Repo already cloned, pulling latest"
    sudo -u polybot git -C "$REPO_DIR" pull --ff-only
fi
ok "Repo at $REPO_DIR"

# ── Rust toolchain (per-user) ────────────────────────────────────────────────
if [ ! -d /home/polybot/.cargo ]; then
    log "Installing Rust toolchain for polybot user"
    sudo -u polybot bash -lc 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal'
fi
ok "Rust toolchain ready"

# ── Build Rust CLI (release) ─────────────────────────────────────────────────
log "Building polymarket CLI in release mode (5-15 min on first run)"
sudo -u polybot bash -lc "cd $REPO_DIR && \$HOME/.cargo/bin/cargo build --release"
ok "Built $REPO_DIR/target/release/polymarket"

# ── systemd units ────────────────────────────────────────────────────────────
log "Installing systemd units"
cp "$REPO_DIR/deploy/polybot-strategy.service" /etc/systemd/system/
cp "$REPO_DIR/deploy/polybot-snapshot.service" /etc/systemd/system/
systemctl daemon-reload
ok "systemd units installed"

# ── Data dirs (persistent across redeploys) ──────────────────────────────────
mkdir -p "$REPO_DIR/scripts/strategy/data"
mkdir -p "$REPO_DIR/scripts/research/data"
chown -R polybot:polybot "$REPO_DIR"
ok "Data dirs ready"

# ── Enable + start services ──────────────────────────────────────────────────
systemctl enable --now polybot-strategy polybot-snapshot
ok "Services enabled and started"

echo ""
echo "✅ Setup complete."
echo ""
echo "  Strategy ledger:  $REPO_DIR/scripts/strategy/data/strategy-ledger.jsonl"
echo "  Snapshot output:  $REPO_DIR/scripts/research/data/orderbook_snapshots.jsonl"
echo ""
echo "  Status:           sudo systemctl status polybot-strategy polybot-snapshot"
echo "  Strategy logs:    journalctl -u polybot-strategy -f"
echo "  Snapshot logs:    journalctl -u polybot-snapshot -f"
echo "  Status summary:   sudo -u polybot node $REPO_DIR/scripts/strategy/status.js"
echo ""
echo "  Redeploy after pushing new commits:"
echo "                    sudo bash $REPO_DIR/deploy/redeploy.sh"
