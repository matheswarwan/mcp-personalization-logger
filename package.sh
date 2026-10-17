#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
VERSION="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['version'])" "$ROOT/manifest.json")"
OUT_DIR="$ROOT/dist"
ZIP_NAME="interaction-studio-mcp-logger-v${VERSION}.zip"
ZIP_PATH="$OUT_DIR/$ZIP_NAME"

mkdir -p "$OUT_DIR"
rm -f "$ZIP_PATH"

# Stage a clean package tree (no tests/dev junk).
STAGE="$(mktemp -d)"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

if command -v rsync >/dev/null 2>&1; then
  rsync -a \
    --exclude '.git/' \
    --exclude '.gitignore' \
    --exclude 'tests/' \
    --exclude 'dist/' \
    --exclude 'data-gen/' \
    --exclude 'devNotes/' \
    --exclude 'gitImages/' \
    --exclude 'docs/' \
    --exclude '.DS_Store' \
    --exclude '**/.DS_Store' \
    --exclude 'node_modules/' \
    --exclude 'package.sh' \
    "$ROOT/" "$STAGE/"
else
  # Fallback without rsync
  cp -a "$ROOT/." "$STAGE/"
  rm -rf "$STAGE/.git" "$STAGE/tests" "$STAGE/dist" "$STAGE/data-gen" \
    "$STAGE/devNotes" "$STAGE/gitImages" "$STAGE/docs" "$STAGE/node_modules" \
    "$STAGE/package.sh" "$STAGE/.gitignore"
  find "$STAGE" -name '.DS_Store' -delete
fi

(
  cd "$STAGE"
  zip -r -q "$ZIP_PATH" .
)

echo "Packaged: $ZIP_PATH"
ls -lh "$ZIP_PATH"
