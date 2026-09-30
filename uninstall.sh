#!/usr/bin/env bash
#
# voxtype-wave — desinstalador.
#
# Por defecto quita lo que rompe el escritorio si queda a medias: el servicio,
# la extensión, el atajo y los binarios. Deja intactos tu configuración y el
# modelo descargado (670 MB) para que reinstalar sea instantáneo.
#
# Uso: ./uninstall.sh [--purge] [-y]
#   --purge   borra también la config, el modelo y (opcionalmente) el grupo input
#   -y        no preguntar

set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib.sh
source "$REPO_DIR/scripts/lib.sh"

UUID="voxtype-wave@cmj_pc"
SHORTCUT_NAME="Voxtype dictation (toggle)"
PURGE=0
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
UNIT_DIR="$HOME/.config/systemd/user"

while [ $# -gt 0 ]; do
    case "$1" in
        --purge) PURGE=1 ;;
        -y|--yes) ASSUME_YES=1 ;;
        -h|--help) sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) die "opción desconocida: $1" ;;
    esac
    shift
done

say "1/5  Deteniendo y quitando el servicio"
if systemctl --user list-unit-files voxtype.service >/dev/null 2>&1; then
    systemctl --user disable --now voxtype.service >/dev/null 2>&1 || true
fi
rm -f "$UNIT_DIR/voxtype.service"
rm -rf "$UNIT_DIR/voxtype.service.d"
systemctl --user daemon-reload >/dev/null 2>&1 || true
ok "servicio quitado"

say "2/5  Quitando la extensión de GNOME"
python3 "$REPO_DIR/scripts/gnome-settings.py" extension-disable --uuid "$UUID" || true
rm -rf "$EXT_DIR"
ok "extensión quitada (desaparece de la barra al reiniciar sesión)"

say "3/5  Quitando el atajo de GNOME"
python3 "$REPO_DIR/scripts/gnome-settings.py" shortcut-remove \
    --name "$SHORTCUT_NAME" --match-command "voxtype record toggle" || true
ok "atajo quitado (tus otros atajos quedaron intactos)"

say "4/5  Quitando los binarios de ~/.local/bin"
rm -f "$BIN_DIR/voxtype" "$BIN_DIR/voxtype-audio-bridge"
ok "binarios quitados"

if [ "$PURGE" = 1 ]; then
    say "5/5  --purge: config, modelo y grupo input"
    rm -rf "$CONF_DIR" "$HOME/.local/share/voxtype"
    ok "config y modelos borrados"

    if id -nG "$USER" | tr ' ' '\n' | grep -qx input; then
        if confirm "¿quitarte del grupo 'input'? (sudo gpasswd -d $USER input)"; then
            sudo gpasswd -d "$USER" input
            NEEDS_RELOGIN=1
        fi
    fi
    if command -v dotool >/dev/null 2>&1; then
        if confirm "¿desinstalar el paquete dotool? (lo pueden usar otros programas)"; then
            . /etc/os-release 2>/dev/null || true
            case "${ID:-}" in
                fedora|rhel) sudo dnf -y remove dotool || true ;;
                arch|manjaro|endeavouros) sudo pacman -Rns --noconfirm dotool || true ;;
                *) warn "quitá dotool a mano" ;;
            esac
        fi
    fi
else
    say "5/5  Conservando config y modelo (usá --purge para borrarlos)"
    info "config:  $CONF_DIR"
    info "modelos: $HOME/.local/share/voxtype/models"
fi

say "Listo"
cat <<EOF

    Para que desaparezca el icono de la barra, cerrá sesión y volvé a entrar.
    Si querés que no quede rastro del repositorio de dotool en Fedora:
      sudo dnf copr remove smallcms/dotool
EOF
if [ "${NEEDS_RELOGIN:-0}" = 1 ]; then
    printf '    (también hace falta reiniciar sesión para que se aplique el cambio de grupos)\n'
fi
