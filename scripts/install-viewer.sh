#!/usr/bin/env bash
# Build the Go companion when possible. Safe for npm postinstall:
# missing Go or build tools must not fail package install.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

log() { printf 'piview: %s\n' "$*"; }
warn() { printf 'piview: %s\n' "$*" >&2; }

if [[ "${PIVIEW_SKIP_VIEWER_BUILD:-}" == "1" ]]; then
  log "skipping viewer build (PIVIEW_SKIP_VIEWER_BUILD=1)"
  exit 0
fi

if ! command -v go >/dev/null 2>&1; then
  warn "Go not found — plan GUI binary not built."
  warn "Install Go 1.22+, then run: npm run build:viewer"
  warn "Or set PIVIEW_BIN to an existing piview binary."
  warn "See README.md."
  exit 0
fi

if ! bash "$ROOT/scripts/build-viewer.sh"; then
  warn "viewer build failed — plan GUI may be unavailable until you run: npm run build:viewer"
  exit 0
fi

exit 0
