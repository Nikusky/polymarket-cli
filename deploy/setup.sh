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

# ── Service discovery (mirrors redeploy.sh::discover_services) ───────────────
# Auto-picks up polybot-strategy-[a-z].service plus snapshot/mastercopy/ui by
# name. Keep in sync with deploy/redeploy.sh — single source of truth for
# which services run in production.
discover_services() {
    local svcs=()
    while IFS= read -r f; do
        [[ -n "$f" ]] && svcs+=("$(basename "$f" .service)")
    done < <(ls "${REPO_DIR}/deploy"/polybot-strategy-[a-z].service 2>/dev/null | sort)
    svcs+=("polybot-snapshot")
    for extra in polybot-mastercopy polybot-ui; do
        [[ -f "${REPO_DIR}/deploy/${extra}.service" ]] && svcs+=("$extra")
    done
    printf '%s\n' "${svcs[@]}"
}
mapfile -t SERVICES < <(discover_services)

# ── systemd units ────────────────────────────────────────────────────────────
log "Installing systemd units: ${SERVICES[*]}"
for svc in "${SERVICES[@]}"; do
    cp "$REPO_DIR/deploy/${svc}.service" /etc/systemd/system/
done
systemctl daemon-reload
ok "systemd units installed"

# ── Data dirs (persistent across redeploys) ──────────────────────────────────
# systemd ReadWritePaths requires the dir to pre-exist; otherwise the unit
# fails with status=226/NAMESPACE. Extract STRATEGY_DATA_DIR from each unit.
mkdir -p "$REPO_DIR/scripts/strategy/data"
mkdir -p "$REPO_DIR/scripts/research/data"
for svc in "${SERVICES[@]}"; do
    # || true: services without STRATEGY_DATA_DIR (snapshot, ui) make grep
    # return 1, which under `set -o pipefail` would abort the whole script.
    dir=$(grep -oE 'STRATEGY_DATA_DIR=[^ "]+' "$REPO_DIR/deploy/${svc}.service" 2>/dev/null | head -1 | cut -d= -f2- || true)
    [[ -n "$dir" ]] && mkdir -p "$dir"
done
chown -R polybot:polybot "$REPO_DIR"
ok "Data dirs ready"

# ── Secrets directory (live executor wallet key, etc) ────────────────────────
mkdir -p /etc/polybot
chmod 750 /etc/polybot
chown root:polybot /etc/polybot
ok "/etc/polybot ready (root:polybot 750)"

# ── Enable + start services ──────────────────────────────────────────────────
systemctl enable --now "${SERVICES[@]}"
ok "Services enabled and started: ${SERVICES[*]}"

echo ""
echo "✅ Setup complete."
echo ""
echo "  Services:         ${SERVICES[*]}"
echo "  Repo:             $REPO_DIR"
echo "  Secrets dir:      /etc/polybot/"
echo ""
echo "  Status all:       for s in ${SERVICES[*]}; do echo \"\$s: \$(systemctl is-active \$s)\"; done"
echo "  Live tail:        journalctl -u polybot-mastercopy -f   (or any service)"
echo ""
echo "  Redeploy after pushing new commits:"
echo "                    sudo bash $REPO_DIR/deploy/redeploy.sh"
