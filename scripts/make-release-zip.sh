#!/usr/bin/env bash
#
# voxtype-wave — build the ZIP to upload to extensions.gnome.org.
#
# extensions.gnome.org asks for a ZIP with the extension files at the root and
# nothing else: build/install scripts, docs and unused media are explicitly
# discouraged by the review guidelines.
#
# Usage: ./scripts/make-release-zip.sh [--out DIR]
# Default output: dist/voxtype-wave@charly9926.github.io.zip

set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$REPO_DIR/dist"

while [ $# -gt 0 ]; do
    case "$1" in
        --out) OUT_DIR="${2:?--out needs a directory}"; shift ;;
        -h|--help) sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1" >&2; exit 1 ;;
    esac
    shift
done

UUID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["uuid"])' \
    "$REPO_DIR/extension/metadata.json")"
ZIP="$OUT_DIR/${UUID}.zip"

# Files that must be in the ZIP: the extension itself only.
FILES=(metadata.json extension.js stylesheet.css)

echo "==> building $ZIP"
mkdir -p "$OUT_DIR"
rm -f "$ZIP"

# `-j` flattens paths so the files sit at the ZIP root, as required.
( cd "$REPO_DIR/extension" && zip -q -j "$ZIP" "${FILES[@]}" )

echo "==> contents"
unzip -l "$ZIP"

echo
echo "Upload it at https://extensions.gnome.org/upload/ while logged in,"
echo "then submit the version for review."
