#!/usr/bin/env bash
#
# voxtype-wave — uninstaller.
#
# By default it removes what would leave your desktop half-broken: the service,
# the extension, the shortcut and the binaries. Your configuration and the
# downloaded model (670 MB) are left untouched so reinstalling is instant.
#
# Usage: ./uninstall.sh [--purge] [-y]
#   --purge   also delete the config, the model and (optionally) the input group
#   -y        do not ask

set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib.sh
source "$REPO_DIR/scripts/lib.sh"

UUID="voxtype-wave@charly9926.github.io"
SHORTCUT_NAME="Voxtype dictation (toggle)"
PURGE=0
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
UNIT_DIR="$HOME/.config/systemd/user"

while [ $# -gt 0 ]; do
    case "$1" in
        --purge) PURGE=1 ;;
        -y|--yes) ASSUME_YES=1 ;;
        -h|--help) sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) die "unknown option: $1" ;;
    esac
    shift
done

say "1/5  Stopping and removing the service"
if systemctl --user list-unit-files voxtype.service >/dev/null 2>&1; then
    systemctl --user disable --now voxtype.service >/dev/null 2>&1 || true
fi
rm -f "$UNIT_DIR/voxtype.service"
rm -rf "$UNIT_DIR/voxtype.service.d"
systemctl --user daemon-reload >/dev/null 2>&1 || true
ok "service removed"

say "2/5  Removing the GNOME extension"
python3 "$REPO_DIR/scripts/gnome-settings.py" extension-disable --uuid "$UUID" || true
rm -rf "$EXT_DIR"
ok "extension removed (it disappears from the top bar on next login)"

say "3/5  Removing the GNOME shortcut"
python3 "$REPO_DIR/scripts/gnome-settings.py" shortcut-remove \
    --name "$SHORTCUT_NAME" --match-command "voxtype record toggle" || true
ok "shortcut removed (your other shortcuts were left untouched)"

say "4/5  Removing the binaries from ~/.local/bin"
rm -f "$BIN_DIR/voxtype" "$BIN_DIR/voxtype-audio-bridge"
ok "binaries removed"

if [ "$PURGE" = 1 ]; then
    say "5/5  --purge: config, model and input group"
    rm -rf "$CONF_DIR" "$HOME/.local/share/voxtype"
    ok "config and models deleted"

    if id -nG "$USER" | tr ' ' '\n' | grep -qx input; then
        if confirm "remove yourself from the 'input' group? (sudo gpasswd -d $USER input)"; then
            sudo gpasswd -d "$USER" input
            NEEDS_RELOGIN=1
        fi
    fi
    if command -v dotool >/dev/null 2>&1; then
        if confirm "uninstall the dotool package? (other programs may use it)"; then
            . /etc/os-release 2>/dev/null || true
            case "${ID:-}" in
                fedora|rhel) sudo dnf -y remove dotool || true ;;
                arch|manjaro|endeavouros) sudo pacman -Rns --noconfirm dotool || true ;;
                *) warn "remove dotool by hand" ;;
            esac
        fi
    fi
else
    say "5/5  Keeping config and model (use --purge to delete them)"
    info "config:  $CONF_DIR"
    info "models:  $HOME/.local/share/voxtype/models"
fi

say "Done"
cat <<EOF

    For the top-bar icon to disappear, log out and back in.
    If you want no trace of the dotool repository left on Fedora:
      sudo dnf copr remove smallcms/dotool
EOF
if [ "${NEEDS_RELOGIN:-0}" = 1 ]; then
    printf '    (a re-login is also needed for the group change to take effect)\n'
fi
