#!/usr/bin/env bash
# Full cross-lang TROG refresh: EN resume → DE force → analyze → ES force → NL → analyze.
# Progress: tools/vlm-panel/out/recollect_xlang.log (also tee'd by run_langs_trog.mjs)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
mkdir -p tools/vlm-panel/out
LOG=tools/vlm-panel/out/recollect_xlang.log

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi
export VLM_MAX_RETRIES="${VLM_MAX_RETRIES:-8}"
unset ELECTRON_RUN_AS_NODE || true

log() { echo "$*" | tee -a "$LOG"; }

log "=== XLANG PIPELINE START $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

log "=== PHASE1 en-US resume + de-DE force/resume ==="
node tools/vlm-panel/run_langs_trog.mjs --langs en-US,de-DE --force-langs de-DE
log "=== PHASE1 analyze ==="
node tools/vlm-panel/analyze.mjs --task trog --human-source=bench | tee -a "$LOG"
log "=== PHASE1 sanity (expect embedding_cat_cow among strong DE drops) ==="
rg -n "embedding_cat_cow|strong_delta" tools/vlm-panel/out/review_xlang_de.csv | head -n 20 | tee -a "$LOG" || true
date -u +%Y-%m-%dT%H:%M:%SZ > tools/vlm-panel/out/xlang_phase1_done.txt

log "=== PHASE2 es-CO force/resume + nl-NL collect ==="
node tools/vlm-panel/run_langs_trog.mjs --langs es-CO,nl-NL --force-langs es-CO
log "=== PHASE2 final analyze ==="
node tools/vlm-panel/analyze.mjs --task trog --human-source=bench | tee -a "$LOG"
date -u +%Y-%m-%dT%H:%M:%SZ > tools/vlm-panel/out/xlang_phase2_done.txt

log "=== Refresh RESULTS handoff snippet ==="
node <<'NODE' | tee -a "$LOG"
const fs = require('fs');
const path = 'tools/vlm-panel/RESULTS.md';
let md = fs.readFileSync(path, 'utf8');
const m = JSON.parse(fs.readFileSync('tools/vlm-panel/out/manifest.json', 'utf8'));
const counts = {};
for (const r of m) {
  if (r.task !== 'trog') continue;
  const L = r.language || '?';
  counts[L] = counts[L] || { done: 0, failed: 0, other: 0 };
  if (r.status === 'done') counts[L].done++;
  else if (r.status === 'failed') counts[L].failed++;
  else counts[L].other++;
}
const lines = Object.keys(counts)
  .sort()
  .map((L) => `| ${L} | ${counts[L].done} | ${counts[L].failed} | ${counts[L].other} |`);
const block = `## Handoff (live)

**Cross-lang TROG refresh finished** \`${new Date().toISOString()}\` (log: \`out/recollect_xlang.log\`).

| Lang | Done | Failed | Other |
|------|-----:|-------:|------:|
${lines.join('\n')}

Triage: \`out/review_xlang_<lang>.csv\` (\`strong_delta=yes\` ⇒ |Δ|≥0.25 vs EN).
See also \`out/report.md\` cross-language section.

Uncommitted work on \`improve-vlm-fidelity\` (no commit/PR yet).

`;
md = md.replace(/## Handoff \(live\)[\s\S]*?(?=\n## Pipeline\n)/, block);
fs.writeFileSync(path, md);
console.log('Updated RESULTS.md handoff');
NODE

log "=== XLANG PIPELINE END $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
