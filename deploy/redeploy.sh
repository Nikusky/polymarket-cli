#!/usr/bin/env bash
# redeploy.sh — pull latest code, rebuild Rust CLI if needed, restart services.
#
# Usage on the Lightsail server:
#   sudo bash /opt/polybot/polyBOT/polymarket-cli/deploy/redeploy.sh
#
# Flags:
#   --skip-pull    Use whatever is already checked out
#   --skip-build   Skip cargo build even if Rust sources changed
#   --force-build  Always rebuild the Rust binary
#   --no-status    Skip the post-restart status/log dump

set -euo pipefail

REPO_ROOT="/opt/polybot/polymarket-cli"
SERVICE_USER="polybot"
CLI_DIR="${REPO_ROOT}"

# SERVICES discovered from deploy/polybot-strategy-<label>.service in the repo
# (single source of truth). Add/remove a service file → next redeploy picks it up.
discover_services() {
    local svcs=()
    while IFS= read -r f; do
        [[ -n "$f" ]] && svcs+=("$(basename "$f" .service)")
    done < <(ls "${REPO_ROOT}/deploy"/polybot-strategy-[a-z].service 2>/dev/null | sort)
    svcs+=("polybot-snapshot")
    # Non-strategy daemons in deploy/, picked up by name
    for extra in polybot-mastercopy polybot-ui; do
        [[ -f "${REPO_ROOT}/deploy/${extra}.service" ]] && svcs+=("$extra")
    done
    printf '%s\n' "${svcs[@]}"
}
mapfile -t SERVICES < <(discover_services)

SKIP_PULL=0; SKIP_BUILD=0; FORCE_BUILD=0; NO_STATUS=0
for arg in "$@"; do
    case "$arg" in
        --skip-pull)   SKIP_PULL=1 ;;
        --skip-build)  SKIP_BUILD=1 ;;
        --force-build) FORCE_BUILD=1 ;;
        --no-status)   NO_STATUS=1 ;;
        -h|--help)     grep -E '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown flag: $arg" >&2; exit 2 ;;
    esac
done

log() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
ok()  { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
warn(){ printf '\033[1;33m  ! %s\033[0m\n' "$*"; }

if [[ $EUID -ne 0 ]]; then exec sudo bash "$0" "$@"; fi

as_user() { sudo -u "$SERVICE_USER" -H bash -lc "$*"; }

cd "$REPO_ROOT"

# Auto-recovery for scp-residue: an untracked working-tree file that is
# byte-identical to an incoming tracked file blocks `git pull --ff-only`
# with "would be overwritten by merge". When that happens, remove the
# residue and retry — but ONLY after verifying byte-identity, so a real
# local edit is never silently discarded.
safe_pull() {
    local out; out=$(mktemp)
    if as_user "git -C ${REPO_ROOT} pull --ff-only" 2>&1 | tee "$out"; then
        rm -f "$out"; return 0
    fi
    if ! grep -q "would be overwritten by merge" "$out"; then
        rm -f "$out"; return 1
    fi
    warn "Pull blocked by untracked files — checking for scp-residue"
    as_user "git -C ${REPO_ROOT} fetch --quiet"
    local conflicts; conflicts=$(grep -E '^\s+\S+$' "$out" | sed 's/^[[:space:]]*//')
    rm -f "$out"
    local all_match=1
    local file
    for file in $conflicts; do
        if as_user "git -C ${REPO_ROOT} show @{u}:${file} 2>/dev/null" \
                | cmp -s - "${REPO_ROOT}/${file}" 2>/dev/null; then
            ok "  ${file}: byte-identical to upstream — will remove and retry"
        else
            warn "  ${file}: DIFFERS from upstream — manual review required"
            all_match=0
        fi
    done
    if [[ $all_match -ne 1 ]]; then
        warn "Resolve the differing files (review with 'diff <file> <(git show @{u}:<file>)'), then re-run redeploy"
        return 1
    fi
    for file in $conflicts; do
        as_user "rm -f ${REPO_ROOT}/${file}"
    done
    as_user "git -C ${REPO_ROOT} pull --ff-only"
}

if [[ $SKIP_PULL -eq 0 ]]; then
    log "Pulling latest into ${REPO_ROOT}"
    OLD_HEAD=$(as_user "git -C ${REPO_ROOT} rev-parse HEAD")
    safe_pull
    NEW_HEAD=$(as_user "git -C ${REPO_ROOT} rev-parse HEAD")
    if [[ "$OLD_HEAD" == "$NEW_HEAD" ]]; then
        ok "Already up to date ($NEW_HEAD)"
    else
        ok "Updated: $OLD_HEAD → $NEW_HEAD"
        as_user "git -C ${REPO_ROOT} log --oneline ${OLD_HEAD}..${NEW_HEAD}" || true
    fi
else
    OLD_HEAD=""
    NEW_HEAD=$(as_user "git -C ${REPO_ROOT} rev-parse HEAD")
    warn "Skipped git pull (HEAD=$NEW_HEAD)"
fi

if [[ $SKIP_BUILD -eq 1 ]]; then
    warn "Skipped cargo build"
else
    NEED_BUILD=0
    if [[ $FORCE_BUILD -eq 1 ]]; then
        NEED_BUILD=1
    elif [[ -n "$OLD_HEAD" && "$OLD_HEAD" != "$NEW_HEAD" ]]; then
        if as_user "git -C ${REPO_ROOT} diff --name-only ${OLD_HEAD} ${NEW_HEAD}" \
                | grep -E '^(src/|Cargo\.(toml|lock))' -q; then
            NEED_BUILD=1
        fi
    fi
    if [[ $NEED_BUILD -eq 1 ]]; then
        log "Rebuilding polymarket CLI (release)"
        as_user "cd ${CLI_DIR} && \$HOME/.cargo/bin/cargo build --release"
        ok "Build complete"
    else
        ok "Rust sources unchanged — skipping build"
    fi
fi

log "Restarting services: ${SERVICES[*]}"
for svc in "${SERVICES[@]}"; do
    systemctl restart "$svc"
    ok "${svc} restarted"
done

if [[ $NO_STATUS -eq 0 ]]; then
    sleep 2
    log "Service status"
    for svc in "${SERVICES[@]}"; do
        if systemctl is-active --quiet "$svc"; then
            ok "${svc} is active"
        else
            warn "${svc} NOT active — last 20 log lines:"
            journalctl -u "$svc" -n 20 --no-pager || true
        fi
    done
    log "Recent log tail (last 10 lines per service)"
    for svc in "${SERVICES[@]}"; do
        echo "--- ${svc} ---"
        journalctl -u "$svc" -n 10 --no-pager || true
    done
fi

log "Redeploy complete."
