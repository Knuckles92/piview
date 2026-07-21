#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/viewer"

GOOS="${GOOS:-$(go env GOOS)}"
GOARCH="${GOARCH:-$(go env GOARCH)}"
EXT=""
if [[ "$GOOS" == "windows" ]]; then EXT=".exe"; fi

OUT_DIR="$ROOT/bin"
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/piview-${GOOS}-${GOARCH}${EXT}"
LINK="$OUT_DIR/piview${EXT}"

echo "building piview → $OUT"
go mod tidy
go build -o "$OUT" .
cp "$OUT" "$LINK"
echo "ok: $OUT"
echo "also: $LINK"
