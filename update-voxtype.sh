#!/usr/bin/env bash
#
# voxtype-wave — updates the Voxtype binaries.
#
# The binaries are installed as standalone files in ~/.local/bin, so
# `dnf upgrade` never touches them. This script checks the latest GitHub
# release, verifies the SHA256 (and the GPG signature if you have the key
# imported), replaces both binaries and restarts the service.
#
# Usage: ./update-voxtype.sh [--force] [-y]
#        VOXTYPE_VERSION=X.Y.Z ./update-voxtype.sh     # specific version
#   --force   reinstall even if it is the same version
#   -y        do not ask

set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib.sh
source "$REPO_DIR/scripts/lib.sh"

FORCE=0
while [ $# -gt 0 ]; do
    case "$1" in
        --force) FORCE=1 ;;
        -y|--yes) ASSUME_YES=1 ;;
        -h|--help) sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) die "unknown option: $1" ;;
    esac
    shift
done

[ -x "$BIN_DIR/voxtype" ] || die "Voxtype is not installed in $BIN_DIR (run ./install.sh)"

current="$("$BIN_DIR/voxtype" --version 2>/dev/null | awk '{print $NF}')"
target="${VOXTYPE_VERSION:-}"

say "Installed version: ${current:-unknown}"
if [ -z "$target" ]; then
    info "querying the latest release on GitHub"
    target="$(latest_voxtype_version)"
fi
say "Target version:    $target"

if [ "$target" = "$current" ] && [ "$FORCE" = 0 ]; then
    ok "already on that version; nothing to do (use --force to reinstall)"
    exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fetch_binaries "$target" "$tmp"
install_binaries "$tmp"

if systemctl --user is-enabled --quiet voxtype.service 2>/dev/null; then
    if confirm "restart the service now?"; then
        systemctl --user restart voxtype.service
        ok "service restarted"
    fi
else
    info "the user service is not enabled; start it by hand whenever you want"
fi

say "Updated to $target"
info "check with: systemctl --user status voxtype --no-pager"
