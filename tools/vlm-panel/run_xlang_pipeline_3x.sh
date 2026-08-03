#!/usr/bin/env bash
# Matched en/de/es/nl TROG recollect on the default 3.x panel grid (force all langs).
# Do not mix cells with panel_grid_trog_25.json when computing Δ.
# Progress: tools/vlm-panel/out/recollect_xlang_3x.log
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
mkdir -p tools/vlm-panel/out
LOG=tools/vlm-panel/out/recollect_xlang_3x.log
GRID=tools/vlm-panel/panel_grid.json

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi
export VLM_MAX_RETRIES="${VLM_MAX_RETRIES:-8}"
unset ELECTRON_RUN_AS_NODE || true

log() { echo "$*" | tee -a "$LOG"; }

log "=== XLANG 3.x PIPELINE START $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
log "grid=$GRID (force all: en-US,de-DE,es-CO,nl-NL)"

node tools/vlm-panel/run_langs_trog.mjs \
  --grid "$GRID" \
  --langs en-US,de-DE,es-CO,nl-NL \
  --force-langs en-US,de-DE,es-CO,nl-NL \
  2>&1 | tee -a "$LOG"

log "=== analyze (bench) ==="
node tools/vlm-panel/analyze.mjs --task trog --human-source=bench 2>&1 | tee -a "$LOG"
log "=== smoke check ==="
node tools/vlm-panel/check_trog_smoke.mjs 2>&1 | tee -a "$LOG" || true
date -u +%Y-%m-%dT%H:%M:%SZ > tools/vlm-panel/out/xlang_3x_done.txt
log "=== XLANG 3.x PIPELINE END $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
