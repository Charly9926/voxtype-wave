#!/usr/bin/env bash
#
# voxtype-wave — instalador de dictado push-to-talk con onda en pantalla para GNOME Wayland.
#
# Qué instala (todo en tu HOME, sin tocar nada del sistema salvo lo que pidas):
#   1. dotool          (inyector de teclado; en Fedora desde un COPR)
#   2. voxtype         (daemon, binario standalone verificado por SHA256) -> ~/.local/bin
#   3. audio-bridge    (puente del socket de audio a NDJSON)              -> ~/.local/bin
#   4. modelo Parakeet (670 MB, se puede omitir con --no-model)
#   5. config          -> ~/.config/voxtype/config.toml  (se hace backup si ya existía)
#   6. servicio        -> ~/.config/systemd/user/voxtype.service
#   7. extensión GNOME -> ~/.local/share/gnome-shell/extensions/voxtype-wave@cmj_pc
#   8. atajo de GNOME  (F9 -> voxtype record toggle), sin pisar tus atajos actuales
#
# Uso: ./install.sh [opciones]
#   --no-model            no descargar el modelo (670 MB)
#   --no-service          no instalar ni habilitar el servicio de systemd
#   --hotkey TECLA        tecla/atajo del dictado (por defecto F9; ej: '<Super><Shift>v')
#   --version X.Y.Z       versión de Voxtype a instalar (por defecto 1.1.0)
#   --latest              usar la última versión publicada en GitHub
#   -y, --yes             no preguntar nada
#   -h, --help            esta ayuda

set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib.sh
source "$REPO_DIR/scripts/lib.sh"

UUID="voxtype-wave@cmj_pc"
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

usage() { sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
    case "$1" in
        --no-model)   INSTALL_MODEL=0 ;;
        --no-service) INSTALL_SERVICE=0 ;;
        --hotkey)     HOTKEY="${2:?--hotkey necesita un valor}"; shift ;;
        --version)    VOXTYPE_VERSION="${2:?--version necesita un valor}"; shift ;;
        --latest)     FETCH_LATEST=1 ;;
        -y|--yes)     ASSUME_YES=1 ;;
        -h|--help)    usage; exit 0 ;;
        *)            die "opción desconocida: $1 (probá --help)" ;;
    esac
    shift
done

# --------------------------------------------------------------------------
# 0. Comprobaciones previas
# --------------------------------------------------------------------------
preflight() {
    say "0/8  Comprobando el entorno"
    [ "$(id -u)" = 0 ] && die "no lo ejecutes como root: está pensado para tu usuario"
    command -v curl >/dev/null 2>&1 || die "falta curl"
    command -v gsettings >/dev/null 2>&1 || die "falta gsettings (GNOME)"
    command -v systemctl >/dev/null 2>&1 || die "falta systemd (systemctl --user)"
    command -v python3 >/dev/null 2>&1 || die "falta python3 (lo usa el helper de atajos)"

    if command -v gnome-shell >/dev/null 2>&1; then
        local ver major
        ver="$(gnome-shell --version 2>/dev/null | awk '{print $NF}')"
        major="${ver%%.*}"
        case "$major" in
            4[5-9]|5[0-2]) ok "GNOME Shell $ver" ;;
            *) warn "GNOME Shell $ver: la extensión está probada en 45-52 (Fedora 44 / GNOME 50.5)" ;;
        esac
    else
        warn "no encontré gnome-shell; este setup es para GNOME en Wayland"
    fi

    if [ "${XDG_SESSION_TYPE:-desconocido}" != "wayland" ]; then
        warn "la sesión no es Wayland (XDG_SESSION_TYPE=${XDG_SESSION_TYPE:-desconocido}); probado en Wayland"
    fi
    ok "entorno listo"
}

# --------------------------------------------------------------------------
# 1. dotool (inyector) y wl-clipboard
# --------------------------------------------------------------------------
install_dotool() {
    say "1/8  dotool (manda el acorde de pegado) y wl-clipboard"
    if command -v dotool >/dev/null 2>&1; then
        ok "dotool ya está instalado: $(command -v dotool)"
    else
        # shellcheck disable=SC1091
        . /etc/os-release 2>/dev/null || true
        case "${ID:-}" in
            fedora|rhel)
                if confirm "¿instalo dotool desde el COPR smallcms/dotool (usa sudo)?"; then
                    sudo dnf -y copr enable smallcms/dotool
                    sudo dnf -y install dotool wl-clipboard
                else
                    warn "sin dotool el texto no se pega solo: quedará en el portapapeles"
                fi
                ;;
            arch|manjaro|endeavouros)
                if confirm "¿instalo dotool y wl-clipboard con pacman (usa sudo)?"; then
                    sudo pacman -S --needed --noconfirm dotool wl-clipboard
                fi
                ;;
            *)
                warn "distro '${ID:-desconocida}': instalá dotool a mano (https://git.sr.ht/~geb/dotool)"
                info "Debian/Ubuntu: sudo apt install libxkbcommon-dev y compilar dotool desde el fuente"
                info "sin dotool el texto no se pega solo: quedará en el portapapeles"
                ;;
        esac
    fi

    if command -v dotool >/dev/null 2>&1; then
        if [ -w /dev/uinput ]; then
            ok "tu usuario ya puede escribir en /dev/uinput"
        else
            warn "tu usuario NO puede escribir en /dev/uinput (dotool lo necesita)"
            info "se arregla agregándote al grupo 'input' (la regla udev la trae el paquete dotool)"
            if confirm "¿ejecuto ahora: sudo usermod -aG input $USER ?"; then
                sudo usermod -aG input "$USER"
                NEEDS_RELOGIN=1
                ok "listo: toma efecto al reiniciar sesión"
            else
                info "corré a mano: sudo usermod -aG input $USER   y reiniciá sesión"
            fi
        fi
    fi
}

# --------------------------------------------------------------------------
# 2-3. Voxtype + audio-bridge (descarga verificada)
# --------------------------------------------------------------------------
install_voxtype() {
    [ "$FETCH_LATEST" = 1 ] && VOXTYPE_VERSION="$(latest_voxtype_version)"
    say "2/8  Descargando Voxtype $VOXTYPE_VERSION y verificando integridad"
    local tmp
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    fetch_binaries "$VOXTYPE_VERSION" "$tmp"

    say "3/8  Instalando los binarios en $BIN_DIR"
    install_binaries "$tmp"
    "$BIN_DIR/voxtype" --version || die "el binario instalado no se ejecuta"
    [ -x "$BIN_DIR/voxtype-audio-bridge" ] || die "falta el audio-bridge"
    ok "audio-bridge presente"
}

# --------------------------------------------------------------------------
# 4. Configuración
# --------------------------------------------------------------------------
install_config() {
    say "4/8  Configuración en $CONF_DIR/config.toml"
    mkdir -p "$CONF_DIR"
    if [ -f "$CONF_DIR/config.toml" ]; then
        local backup="$CONF_DIR/config.toml.bak.$(date +%Y%m%d-%H%M%S)"
        cp -a "$CONF_DIR/config.toml" "$backup"
        warn "ya tenías una config: copia de respaldo en $backup"
    fi
    install -Dm644 "$REPO_DIR/config/voxtype-config.toml" "$CONF_DIR/config.toml"
    if "$BIN_DIR/voxtype" -c "$CONF_DIR/config.toml" config >/dev/null 2>&1; then
        ok "la config parsea correctamente"
    else
        die "la config no parsea; revisá $CONF_DIR/config.toml"
    fi
}

# --------------------------------------------------------------------------
# 5. Modelo
# --------------------------------------------------------------------------
install_model() {
    say "5/8  Modelo de voz (${MODEL})"
    if [ "$INSTALL_MODEL" = 0 ]; then
        warn "omitido (--no-model). Después corré:"
        info "$BIN_DIR/voxtype setup --download --model $MODEL"
        return
    fi
    info "descarga de ~670 MB desde models.voxtype.io (puede tardar)"
    "$BIN_DIR/voxtype" setup --download --model "$MODEL"
    ok "modelo listo en ~/.local/share/voxtype/models/$MODEL"
}

# --------------------------------------------------------------------------
# 6. Servicio de usuario
# --------------------------------------------------------------------------
install_service() {
    say "6/8  Servicio de usuario de systemd"
    if [ "$INSTALL_SERVICE" = 0 ]; then
        warn "omitido (--no-service)"
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
    ok "unidad escrita en $UNIT_DIR/voxtype.service"

    systemctl --user daemon-reload
    systemctl --user enable --now voxtype.service || die "no pude habilitar el servicio"
    sleep 1
    if systemctl --user is-active --quiet voxtype.service; then
        ok "daemon corriendo"
    else
        warn "el servicio no quedó activo; mirá: journalctl --user -u voxtype -n 40"
    fi

    if ! wayland_env_ok; then
        warn "el servicio no ve WAYLAND_DISPLAY y el modo clipboard lo necesita (wl-copy)"
        info "creá el drop-in:"
        info "  mkdir -p ~/.config/systemd/user/voxtype.service.d"
        info "  printf '[Service]\\nEnvironment=WAYLAND_DISPLAY=wayland-0\\n' > ~/.config/systemd/user/voxtype.service.d/wayland.conf"
        info "  systemctl --user daemon-reload && systemctl --user restart voxtype"
    fi
}

# --------------------------------------------------------------------------
# 7. Extensión de GNOME
# --------------------------------------------------------------------------
install_extension() {
    say "7/8  Extensión de GNOME ($UUID)"
    install -d "$EXT_DIR"
    local f
    for f in extension.js metadata.json stylesheet.css; do
        install -Dm644 "$REPO_DIR/extension/$f" "$EXT_DIR/$f"
    done
    ok "archivos copiados en $EXT_DIR"
    python3 "$REPO_DIR/scripts/gnome-settings.py" extension-enable --uuid "$UUID"
    NEEDS_RELOGIN=1
}

# --------------------------------------------------------------------------
# 8. Atajo de GNOME
# --------------------------------------------------------------------------
install_shortcut() {
    say "8/8  Atajo de GNOME para dictar ($HOTKEY)"
    python3 "$REPO_DIR/scripts/gnome-settings.py" shortcut-set \
        --name "$SHORTCUT_NAME" \
        --command "$BIN_DIR/voxtype record toggle" \
        --binding "$HOTKEY" \
        --match-command "voxtype record toggle"
    ok "atajo configurado (no se tocaron tus otros atajos)"
}

summary() {
    say "Listo"
    cat <<EOF

    Qué quedó instalado
      daemon        $BIN_DIR/voxtype  (servicio de usuario voxtype.service)
      bridge        $BIN_DIR/voxtype-audio-bridge
      config        $CONF_DIR/config.toml
      extensión     $EXT_DIR
      atajo         $HOTKEY  ->  $BIN_DIR/voxtype record toggle

    Qué hacer ahora
EOF
    if [ "$NEEDS_RELOGIN" = 1 ]; then
        printf '      1. CERRÁ SESIÓN y volvé a entrar (carga la extensión'
        [ -w /dev/uinput ] || printf ' y aplica el grupo input'
        printf ')\n'
        printf '      2. Apretá %s, hablá, y volvé a apretar %s\n' "$HOTKEY" "$HOTKEY"
    else
        printf '      1. Apretá %s, hablá, y volvé a apretar %s\n' "$HOTKEY" "$HOTKEY"
    fi
    cat <<EOF

    Comandos útiles
      gnome-extensions info $UUID
      systemctl --user status voxtype
      journalctl --user -b -g voxtype-wave --no-pager | tail -30
      ./uninstall.sh              desinstalar (deja config y modelos)
      ./uninstall.sh --purge      desinstalar todo, incluido el modelo
      ./update-voxtype.sh         actualizar los binarios de Voxtype
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
