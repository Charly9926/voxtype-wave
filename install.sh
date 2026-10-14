#!/usr/bin/env bash
#
# voxtype-wave — push-to-talk dictation installer with an on-screen waveform for GNOME Wayland.
#
# What it installs (everything in your HOME; nothing system-wide unless you ask):
#   1. dotool          (keyboard injector; on Fedora from a COPR)
#   2. voxtype         (daemon, standalone binary verified by SHA256)  -> ~/.local/bin
#   3. audio-bridge    (bridges the audio socket to NDJSON)            -> ~/.local/bin
#   4. Parakeet model  (670 MB, skip it with --no-model)
#   5. config          -> ~/.config/voxtype/config.toml  (an existing file is backed up)
#   6. service         -> ~/.config/systemd/user/voxtype.service
#   7. GNOME extension -> ~/.local/share/gnome-shell/extensions/voxtype-wave@charly9926.github.io
#   8. GNOME shortcut  (F9 -> voxtype record toggle), without touching your current shortcuts
#
# Usage: ./install.sh [options]
#   --no-model            do not download the model (670 MB)
#   --no-service          do not install or enable the systemd user service
#   --hotkey KEY          key/shortcut for dictation (default F9; e.g. '<Super><Shift>v')
#   --version X.Y.Z       Voxtype version to install (default 1.1.0)
#   --latest              use the latest version published on GitHub
#   -y, --yes             do not ask anything
#   -h, --help            this help

set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib.sh
source "$REPO_DIR/scripts/lib.sh"

UUID="voxtype-wave@charly9926.github.io"
SHORTCUT_NAME="Voxtype dictation (toggle)"
VOXTYPE_VERSION="1.1.0"
MODEL="parakeet-tdt-0.6b-v3-int8"
HOTKEY="F9"
INSTALL_MODEL=1
INSTALL_SERVICE=1
FETCH_LATEST=0
NEEDS_RELOGIN=0

EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
UNIT_DIR="$HOME/.config/systemd/user"

usage() { sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
    case "$1" in
        --no-model)   INSTALL_MODEL=0 ;;
        --no-service) INSTALL_SERVICE=0 ;;
        --hotkey)     HOTKEY="${2:?--hotkey needs a value}"; shift ;;
        --version)    VOXTYPE_VERSION="${2:?--version needs a value}"; shift ;;
        --latest)     FETCH_LATEST=1 ;;
        -y|--yes)     ASSUME_YES=1 ;;
        -h|--help)    usage; exit 0 ;;
        *)            die "unknown option: $1 (try --help)" ;;
    esac
    shift
done

# --------------------------------------------------------------------------
# 0. Preflight checks
# --------------------------------------------------------------------------
preflight() {
    say "0/8  Checking the environment"
    [ "$(id -u)" = 0 ] && die "do not run this as root: it is meant for your user"
    command -v curl >/dev/null 2>&1 || die "curl is required"
    command -v gsettings >/dev/null 2>&1 || die "gsettings is required (GNOME)"
    command -v systemctl >/dev/null 2>&1 || die "systemd is required (systemctl --user)"
    command -v python3 >/dev/null 2>&1 || die "python3 is required (used by the shortcut helper)"

    if command -v gnome-shell >/dev/null 2>&1; then
        local ver major
        ver="$(gnome-shell --version 2>/dev/null | awk '{print $NF}')"
        major="${ver%%.*}"
        case "$major" in
            50) ok "GNOME Shell $ver" ;;
            *) warn "GNOME Shell $ver: the extension is tested on GNOME 50 (Fedora 44 / GNOME 50.5)" ;;
        esac
    else
        warn "gnome-shell not found; this setup is for GNOME on Wayland"
    fi

    if [ "${XDG_SESSION_TYPE:-unknown}" != "wayland" ]; then
        warn "the session is not Wayland (XDG_SESSION_TYPE=${XDG_SESSION_TYPE:-unknown}); tested on Wayland"
    fi
    ok "environment ready"
}

# --------------------------------------------------------------------------
# 1. dotool (injector) and wl-clipboard
# --------------------------------------------------------------------------
install_dotool() {
    say "1/8  dotool (sends the paste chord) and wl-clipboard"
    if command -v dotool >/dev/null 2>&1; then
        ok "dotool is already installed: $(command -v dotool)"
    else
        # shellcheck disable=SC1091
        . /etc/os-release 2>/dev/null || true
        case "${ID:-}" in
            fedora|rhel)
                if confirm "install dotool from the smallcms/dotool COPR (uses sudo)?"; then
                    sudo dnf -y copr enable smallcms/dotool
                    sudo dnf -y install dotool wl-clipboard
                else
                    warn "without dotool the text will not paste itself: it will stay in the clipboard"
                fi
                ;;
            arch|manjaro|endeavouros)
                if confirm "install dotool and wl-clipboard with pacman (uses sudo)?"; then
                    sudo pacman -S --needed --noconfirm dotool wl-clipboard
                fi
                ;;
            *)
                warn "distro '${ID:-unknown}': install dotool by hand (https://git.sr.ht/~geb/dotool)"
                info "Debian/Ubuntu: sudo apt install libxkbcommon-dev, then build dotool from source"
                info "without dotool the text will not paste itself: it will stay in the clipboard"
                ;;
        esac
    fi

    if command -v dotool >/dev/null 2>&1; then
        if [ -w /dev/uinput ]; then
            ok "your user can already write to /dev/uinput"
        else
            warn "your user CANNOT write to /dev/uinput (dotool needs it)"
            info "fix it by adding yourself to the 'input' group (the udev rule ships with the dotool package)"
            if confirm "run now: sudo usermod -aG input $USER ?"; then
                sudo usermod -aG input "$USER"
                NEEDS_RELOGIN=1
                ok "done: it takes effect after logging out and back in"
            else
                info "run it by hand: sudo usermod -aG input $USER   and then log out and back in"
            fi
        fi
    fi
}

# --------------------------------------------------------------------------
# 2-3. Voxtype + audio-bridge (verified download)
# --------------------------------------------------------------------------
install_voxtype() {
    [ "$FETCH_LATEST" = 1 ] && VOXTYPE_VERSION="$(latest_voxtype_version)"
    say "2/8  Downloading Voxtype $VOXTYPE_VERSION and verifying integrity"
    local tmp
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    fetch_binaries "$VOXTYPE_VERSION" "$tmp"

    say "3/8  Installing the binaries into $BIN_DIR"
    install_binaries "$tmp"
    "$BIN_DIR/voxtype" --version || die "the installed binary does not run"
    [ -x "$BIN_DIR/voxtype-audio-bridge" ] || die "the audio-bridge is missing"
    ok "audio-bridge present"
}

# --------------------------------------------------------------------------
# 4. Configuration
# --------------------------------------------------------------------------
install_config() {
    say "4/8  Configuration in $CONF_DIR/config.toml"
    mkdir -p "$CONF_DIR"
    if [ -f "$CONF_DIR/config.toml" ]; then
        local backup="$CONF_DIR/config.toml.bak.$(date +%Y%m%d-%H%M%S)"
        cp -a "$CONF_DIR/config.toml" "$backup"
        warn "you already had a config: backup saved to $backup"
    fi
    install -Dm644 "$REPO_DIR/config/voxtype-config.toml" "$CONF_DIR/config.toml"
    if "$BIN_DIR/voxtype" -c "$CONF_DIR/config.toml" config >/dev/null 2>&1; then
        ok "the config parses correctly"
    else
        die "the config does not parse; check $CONF_DIR/config.toml"
    fi
}

# --------------------------------------------------------------------------
# 5. Model
# --------------------------------------------------------------------------
install_model() {
    say "5/8  Speech model (${MODEL})"
    if [ "$INSTALL_MODEL" = 0 ]; then
        warn "skipped (--no-model). Run this later:"
        info "$BIN_DIR/voxtype setup --download --model $MODEL"
        return
    fi
    info "downloading ~670 MB from models.voxtype.io (this can take a while)"
    "$BIN_DIR/voxtype" setup --download --model "$MODEL"
    ok "model ready in ~/.local/share/voxtype/models/$MODEL"
}

# --------------------------------------------------------------------------
# 6. User service
# --------------------------------------------------------------------------
install_service() {
    say "6/8  systemd user service"
    if [ "$INSTALL_SERVICE" = 0 ]; then
        warn "skipped (--no-service)"
        return
    fi
    mkdir -p "$UNIT_DIR"
    cat > "$UNIT_DIR/voxtype.service" <<EOF
[Unit]
Description=Voxtype push-to-talk voice-to-text daemon
Documentation=https://github.com/peteonrails/voxtype
PartOf=graphical-session.target
After=graphical-session.target

[Service]
Type=simple
ExecStart=$BIN_DIR/voxtype daemon
Restart=on-failure
RestartSec=5
Environment=XDG_RUNTIME_DIR=%t

[Install]
WantedBy=graphical-session.target
EOF
    ok "unit written to $UNIT_DIR/voxtype.service"

    systemctl --user daemon-reload
    systemctl --user enable --now voxtype.service || die "could not enable the service"
    sleep 1
    if systemctl --user is-active --quiet voxtype.service; then
        ok "daemon running"
    else
        warn "the service did not stay active; check: journalctl --user -u voxtype -n 40"
    fi

    if ! wayland_env_ok; then
        warn "the service cannot see WAYLAND_DISPLAY and clipboard mode needs it (wl-copy)"
        info "create the drop-in:"
        info "  mkdir -p ~/.config/systemd/user/voxtype.service.d"
        info "  printf '[Service]\\nEnvironment=WAYLAND_DISPLAY=wayland-0\\n' > ~/.config/systemd/user/voxtype.service.d/wayland.conf"
        info "  systemctl --user daemon-reload && systemctl --user restart voxtype"
    fi
}

# --------------------------------------------------------------------------
# 7. GNOME extension
# --------------------------------------------------------------------------
install_extension() {
    say "7/8  GNOME extension ($UUID)"
    install -d "$EXT_DIR"
    local f
    for f in extension.js metadata.json stylesheet.css; do
        install -Dm644 "$REPO_DIR/extension/$f" "$EXT_DIR/$f"
    done
    ok "files copied to $EXT_DIR"
    python3 "$REPO_DIR/scripts/gnome-settings.py" extension-enable --uuid "$UUID"
    NEEDS_RELOGIN=1
}

# --------------------------------------------------------------------------
# 8. GNOME shortcut
# --------------------------------------------------------------------------
install_shortcut() {
    say "8/8  GNOME shortcut for dictation ($HOTKEY)"
    python3 "$REPO_DIR/scripts/gnome-settings.py" shortcut-set \
        --name "$SHORTCUT_NAME" \
        --command "$BIN_DIR/voxtype record toggle" \
        --binding "$HOTKEY" \
        --match-command "voxtype record toggle"
    ok "shortcut configured (your other shortcuts were left alone)"
}

summary() {
    say "Done"
    cat <<EOF

    What was installed
      daemon        $BIN_DIR/voxtype  (voxtype.service user service)
      bridge        $BIN_DIR/voxtype-audio-bridge
      config        $CONF_DIR/config.toml
      extension     $EXT_DIR
      shortcut      $HOTKEY  ->  $BIN_DIR/voxtype record toggle

    What to do now
EOF
    if [ "$NEEDS_RELOGIN" = 1 ]; then
        printf '      1. LOG OUT and back in (loads the extension'
        [ -w /dev/uinput ] || printf ' and applies the input group'
        printf ')\n'
        printf '      2. Press %s, speak, and press %s again\n' "$HOTKEY" "$HOTKEY"
    else
        printf '      1. Press %s, speak, and press %s again\n' "$HOTKEY" "$HOTKEY"
    fi
    cat <<EOF

    Useful commands
      gnome-extensions info $UUID
      systemctl --user status voxtype
      journalctl --user -b -g voxtype-wave --no-pager | tail -30
      ./uninstall.sh              uninstall (keeps config and models)
      ./uninstall.sh --purge      uninstall everything, including the model
      ./update-voxtype.sh         update the Voxtype binaries
EOF
}

preflight
install_dotool
install_voxtype
install_config
install_model
install_service
install_extension
install_shortcut
summary
