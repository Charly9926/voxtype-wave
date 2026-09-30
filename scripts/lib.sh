#!/usr/bin/env bash
# Funciones compartidas por install.sh y update-voxtype.sh.
# No ejecutar directamente: se hace `source` desde los otros scripts.

VOXTYPE_REPO_API="https://api.github.com/repos/peteonrails/voxtype/releases/latest"
VOXTYPE_DOWNLOAD_BASE="https://github.com/peteonrails/voxtype/releases/download"
VOXTYPE_SIGNING_KEY="A3FC9F33FD209279"

BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
CONF_DIR="${CONF_DIR:-$HOME/.config/voxtype}"

# --- salida ---------------------------------------------------------------
say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
ok()   { printf '    \033[32mok\033[0m %s\n' "$*"; }
warn() { printf '    \033[33m! \033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# confirm "pregunta"  -> 0 si el usuario acepta (o si ASSUME_YES=1)
confirm() {
    [ "${ASSUME_YES:-0}" = 1 ] && return 0
    local answer
    read -r -p "    $1 [y/N] " answer || true
    case "${answer,,}" in
        y|yes|s|si|sí) return 0 ;;
        *) return 1 ;;
    esac
}

# --- detección ------------------------------------------------------------
# Variante del binario ONNX según arquitectura y características del CPU.
detect_variant() {
    local arch variant
    arch="$(uname -m)"
    case "$arch" in
        x86_64)
            if grep -qm1 'avx512f' /proc/cpuinfo; then
                variant="onnx-avx512"
            elif grep -qm1 'avx2' /proc/cpuinfo; then
                variant="onnx-avx2"
            else
                variant="baseline"   # sin AVX2: el motor ONNX (Parakeet) no va a funcionar
            fi
            ;;
        aarch64|arm64)
            arch="aarch64"
            variant="onnx"
            ;;
        *)
            die "arquitectura no soportada: $arch"
            ;;
    esac
    printf '%s %s\n' "$arch" "$variant"
}

# Versión más reciente publicada en GitHub.
latest_voxtype_version() {
    local tag
    tag="$(curl -fsSL "$VOXTYPE_REPO_API" 2>/dev/null \
        | grep -m1 '"tag_name"' \
        | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v?([^"]+)".*/\1/')"
    [ -n "$tag" ] || die "no pude consultar la última versión en GitHub"
    printf '%s\n' "$tag"
}

# --- descarga y verificación ---------------------------------------------
# fetch_binaries <versión> <destino>
# Deja en <destino> los dos binarios verificados y devuelve los nombres en
# las variables VOXTYPE_ASSET y BRIDGE_ASSET.
fetch_binaries() {
    local version="$1" dest="$2" arch variant
    read -r arch variant <<<"$(detect_variant)"

    VOXTYPE_ASSET="voxtype-${version}-linux-${arch}-${variant}"
    BRIDGE_ASSET="voxtype-${version}-linux-${arch}-audio-bridge"
    local base="${VOXTYPE_DOWNLOAD_BASE}/v${version}"

    info "arquitectura ${arch}, variante del binario: ${variant}"
    info "descargando ${VOXTYPE_ASSET} y ${BRIDGE_ASSET} (v${version})"
    mkdir -p "$dest"
    curl -fsSL -o "$dest/SHA256SUMS.txt" "$base/SHA256SUMS.txt" \
        || die "no pude descargar SHA256SUMS.txt"
    curl -fsSL -o "$dest/$VOXTYPE_ASSET" "$base/$VOXTYPE_ASSET" \
        || die "no pude descargar $VOXTYPE_ASSET"
    curl -fsSL -o "$dest/$BRIDGE_ASSET" "$base/$BRIDGE_ASSET" \
        || die "no pude descargar $BRIDGE_ASSET"

    local asset lines
    for asset in "$VOXTYPE_ASSET" "$BRIDGE_ASSET"; do
        lines="$(grep -cF " $asset" "$dest/SHA256SUMS.txt" || true)"
        [ "$lines" = 1 ] || die "el archivo $asset no figura en SHA256SUMS.txt"
        ( cd "$dest" && grep -F " $asset" SHA256SUMS.txt | sha256sum -c - >/dev/null ) \
            || die "el SHA256 de $asset no coincide: descarga corrupta o manipulada"
        ok "SHA256 verificado: $asset"
    done

    # Firma GPG del listado de checksums (opcional: solo si la clave está importada).
    if command -v gpg >/dev/null 2>&1; then
        if curl -fsSL -o "$dest/SHA256SUMS.txt.asc" "$base/SHA256SUMS.txt.asc" 2>/dev/null; then
            if gpg --list-keys "$VOXTYPE_SIGNING_KEY" >/dev/null 2>&1; then
                if gpg --verify "$dest/SHA256SUMS.txt.asc" "$dest/SHA256SUMS.txt" >/dev/null 2>&1; then
                    ok "firma GPG del listado: válida"
                else
                    warn "la firma GPG del listado NO validó"
                fi
            else
                info "para verificar la firma: gpg --keyserver hkps://keys.openpgp.org --recv-keys $VOXTYPE_SIGNING_KEY"
            fi
        fi
    fi
}

# install_binaries <directorio-con-binarios>
install_binaries() {
    local src="$1"
    install -Dm755 "$src/$VOXTYPE_ASSET" "$BIN_DIR/voxtype"
    install -Dm755 "$src/$BRIDGE_ASSET" "$BIN_DIR/voxtype-audio-bridge"
    ok "instalados $BIN_DIR/voxtype y $BIN_DIR/voxtype-audio-bridge"
}

# ¿La sesión tiene WAYLAND_DISPLAY exportado para el servicio de usuario?
wayland_env_ok() {
    systemctl --user show-environment 2>/dev/null | grep -q '^WAYLAND_DISPLAY='
}
