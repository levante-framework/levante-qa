#!/usr/bin/env bash
# Limited 3.x xlang check: EN+DE, 2 repeats, then compare Δ to frozen 2.5 triage.
# Assumes out/review_xlang_de_25.csv already snapshotted from the 2.5 panel.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
mkdir -p tools/vlm-panel/out
LOG=tools/vlm-panel/out/recollect_xlang_limited.log
GRID=tools/vlm-panel/panel_grid_trog_xlang_limited.json

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi
export VLM_MAX_RETRIES="${VLM_MAX_RETRIES:-8}"
unset ELECTRON_RUN_AS_NODE || true

log() { echo "$*" | tee -a "$LOG"; }

log "=== XLANG LIMITED 3.x START $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
log "grid=$GRID langs=en-US,de-DE (resume; no ES/NL)"

# EN r1/r2 mostly done from the aborted full force; DE needs remaining cells.
node tools/vlm-panel/run_langs_trog.mjs \
  --grid "$GRID" \
  --langs en-US,de-DE \
  --no-force \
  2>&1 | tee -a "$LOG"

log "=== analyze 3.x-only (r1–r2) ==="
node tools/vlm-panel/analyze.mjs --task trog --human-source=bench \
  --run-id-re '(35flashlite|36flash).*_r[12]$' \
  2>&1 | tee -a "$LOG"

log "=== compare 3.x Δ vs 2.5 triage ==="
node tools/vlm-panel/compare_xlang_gens.mjs \
  --baseline out/review_xlang_de_25.csv \
  --current out/review_xlang_de.csv \
  2>&1 | tee -a "$LOG"

log "=== smoke ==="
node tools/vlm-panel/check_trog_smoke.mjs 2>&1 | tee -a "$LOG" || true
date -u +%Y-%m-%dT%H:%M:%SZ > tools/vlm-panel/out/xlang_limited_3x_done.txt
log "=== XLANG LIMITED 3.x END $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
