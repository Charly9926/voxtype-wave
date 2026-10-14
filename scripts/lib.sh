#!/usr/bin/env bash
# Shared functions for install.sh and update-voxtype.sh.
# Do not run directly: it is `source`d by the other scripts.

VOXTYPE_REPO_API="https://api.github.com/repos/peteonrails/voxtype/releases/latest"
VOXTYPE_DOWNLOAD_BASE="https://github.com/peteonrails/voxtype/releases/download"
VOXTYPE_SIGNING_KEY="A3FC9F33FD209279"

BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
CONF_DIR="${CONF_DIR:-$HOME/.config/voxtype}"

# --- output ---------------------------------------------------------------
say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
ok()   { printf '    \033[32mok\033[0m %s\n' "$*"; }
warn() { printf '    \033[33m! \033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# confirm "question"  -> 0 if the user accepts (or if ASSUME_YES=1)
confirm() {
    [ "${ASSUME_YES:-0}" = 1 ] && return 0
    local answer
    read -r -p "    $1 [y/N] " answer || true
    case "${answer,,}" in
        y|yes) return 0 ;;
        *) return 1 ;;
    esac
}

# --- detection ------------------------------------------------------------
# ONNX binary variant, based on the architecture and the CPU features.
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
                variant="baseline"   # no AVX2: the ONNX engine (Parakeet) will not work
            fi
            ;;
        aarch64|arm64)
            arch="aarch64"
            variant="onnx"
            ;;
        *)
            die "unsupported architecture: $arch"
            ;;
    esac
    printf '%s %s\n' "$arch" "$variant"
}

# Latest version published on GitHub.
latest_voxtype_version() {
    local tag
    tag="$(curl -fsSL "$VOXTYPE_REPO_API" 2>/dev/null \
        | grep -m1 '"tag_name"' \
        | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v?([^"]+)".*/\1/')"
    [ -n "$tag" ] || die "could not query the latest version on GitHub"
    printf '%s\n' "$tag"
}

# --- download and verification -------------------------------------------
# fetch_binaries <version> <destination>
# Leaves the two verified binaries in <destination> and returns their names in
# the VOXTYPE_ASSET and BRIDGE_ASSET variables.
fetch_binaries() {
    local version="$1" dest="$2" arch variant
    read -r arch variant <<<"$(detect_variant)"

    VOXTYPE_ASSET="voxtype-${version}-linux-${arch}-${variant}"
    BRIDGE_ASSET="voxtype-${version}-linux-${arch}-audio-bridge"
    local base="${VOXTYPE_DOWNLOAD_BASE}/v${version}"

    info "architecture ${arch}, binary variant: ${variant}"
    info "downloading ${VOXTYPE_ASSET} and ${BRIDGE_ASSET} (v${version})"
    mkdir -p "$dest"
    curl -fsSL -o "$dest/SHA256SUMS.txt" "$base/SHA256SUMS.txt" \
        || die "could not download SHA256SUMS.txt"
    curl -fsSL -o "$dest/$VOXTYPE_ASSET" "$base/$VOXTYPE_ASSET" \
        || die "could not download $VOXTYPE_ASSET"
    curl -fsSL -o "$dest/$BRIDGE_ASSET" "$base/$BRIDGE_ASSET" \
        || die "could not download $BRIDGE_ASSET"

    local asset lines
    for asset in "$VOXTYPE_ASSET" "$BRIDGE_ASSET"; do
        lines="$(grep -cF " $asset" "$dest/SHA256SUMS.txt" || true)"
        [ "$lines" = 1 ] || die "file $asset is not listed in SHA256SUMS.txt"
        ( cd "$dest" && grep -F " $asset" SHA256SUMS.txt | sha256sum -c - >/dev/null ) \
            || die "SHA256 mismatch for $asset: corrupt or tampered download"
        ok "SHA256 verified: $asset"
    done

    # GPG signature of the checksum list (optional: only if the key is imported).
    if command -v gpg >/dev/null 2>&1; then
        if curl -fsSL -o "$dest/SHA256SUMS.txt.asc" "$base/SHA256SUMS.txt.asc" 2>/dev/null; then
            if gpg --list-keys "$VOXTYPE_SIGNING_KEY" >/dev/null 2>&1; then
                if gpg --verify "$dest/SHA256SUMS.txt.asc" "$dest/SHA256SUMS.txt" >/dev/null 2>&1; then
                    ok "GPG signature of the checksum list: valid"
                else
                    warn "the GPG signature of the checksum list did NOT validate"
                fi
            else
                info "to verify the signature: gpg --keyserver hkps://keys.openpgp.org --recv-keys $VOXTYPE_SIGNING_KEY"
            fi
        fi
    fi
}

# install_binaries <directory-with-binaries>
install_binaries() {
    local src="$1"
    install -Dm755 "$src/$VOXTYPE_ASSET" "$BIN_DIR/voxtype"
    install -Dm755 "$src/$BRIDGE_ASSET" "$BIN_DIR/voxtype-audio-bridge"
    ok "installed $BIN_DIR/voxtype and $BIN_DIR/voxtype-audio-bridge"
}

# Does the session export WAYLAND_DISPLAY for the user service?
wayland_env_ok() {
    systemctl --user show-environment 2>/dev/null | grep -q '^WAYLAND_DISPLAY='
}
