#!/usr/bin/env bash
#
# voxtype-wave — actualiza los binarios de Voxtype.
#
# Los binarios están instalados como standalone en ~/.local/bin, así que
# `dnf upgrade` no los toca. Este script consulta el último release de GitHub,
# verifica el SHA256 (y la firma GPG si tenés la clave importada), reemplaza
# los dos binarios y reinicia el servicio.
#
# Uso: ./update-voxtype.sh [--force] [-y]
#      VOXTYPE_VERSION=X.Y.Z ./update-voxtype.sh     # versión concreta
#   --force   reinstalar aunque sea la misma versión
#   -y        no preguntar

set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib.sh
source "$REPO_DIR/scripts/lib.sh"

FORCE=0
while [ $# -gt 0 ]; do
    case "$1" in
        --force) FORCE=1 ;;
        -y|--yes) ASSUME_YES=1 ;;
        -h|--help) sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) die "opción desconocida: $1" ;;
    esac
    shift
done

[ -x "$BIN_DIR/voxtype" ] || die "no está instalado Voxtype en $BIN_DIR (corré ./install.sh)"

current="$("$BIN_DIR/voxtype" --version 2>/dev/null | awk '{print $NF}')"
target="${VOXTYPE_VERSION:-}"

say "Versión instalada: ${current:-desconocida}"
if [ -z "$target" ]; then
    info "consultando el último release en GitHub"
    target="$(latest_voxtype_version)"
fi
say "Versión objetivo:  $target"

if [ "$target" = "$current" ] && [ "$FORCE" = 0 ]; then
    ok "ya estás en esa versión; nada que hacer (usá --force para reinstalar)"
    exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fetch_binaries "$target" "$tmp"
install_binaries "$tmp"

if systemctl --user is-enabled --quiet voxtype.service 2>/dev/null; then
    if confirm "¿reinicio el servicio ahora?"; then
        systemctl --user restart voxtype.service
        ok "servicio reiniciado"
    fi
else
    info "el servicio de usuario no está habilitado; arrancalo a mano cuando quieras"
fi

say "Actualizado a $target"
info "verificá con: systemctl --user status voxtype --no-pager"
