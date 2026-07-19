#!/usr/bin/env bash
# Oracle A/B: vocab + SDS CAT on main (:8081) vs critical-pack PR (:8080).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/results/critical-pack-oracle-ab"
mkdir -p "$OUT"
SUMMARY="$OUT/summary.json"
: >"$OUT/run.log"

run_one() {
  local label="$1" base="$2" spec="$3"
  local log="$OUT/${label}.log"
  echo "===== $label  BASE_URL=$base =====" | tee -a "$OUT/run.log"
  set +e
  (
    cd "$ROOT"
    # Cursor/agent shells often set ELECTRON_RUN_AS_NODE, which breaks Cypress.
    env -u ELECTRON_RUN_AS_NODE -u ELECTRON_NO_ASAR \
      BASE_URL="$base" QA_CAT=true \
      pnpm exec cypress run --browser chrome --spec "$spec" 2>&1
  ) | tee "$log" | tee -a "$OUT/run.log"
  local code=${PIPESTATUS[0]}
  set -e
  echo "$label exit=$code" | tee -a "$OUT/run.log"
  echo "$code" >"$OUT/${label}.exit"
}

# Without PR 497 (main)
run_one "main-vocab" "http://localhost:8081" "cypress/e2e/vocab/oracle.cy.ts"
run_one "main-sds" "http://localhost:8081" "cypress/e2e/same_different/oracle.cy.ts"
# With PR 497 (critical-pack)
run_one "critical-vocab" "http://localhost:8080" "cypress/e2e/vocab/oracle.cy.ts"
run_one "critical-sds" "http://localhost:8080" "cypress/e2e/same_different/oracle.cy.ts"

node -e "
const fs=require('fs'); const path=require('path');
const dir=process.argv[1];
const labels=['main-vocab','main-sds','critical-vocab','critical-sds'];
const rows=labels.map(label=>{
  const exit=Number(fs.readFileSync(path.join(dir,label+'.exit'),'utf8').trim());
  const log=fs.readFileSync(path.join(dir,label+'.log'),'utf8');
  const passed=/All specs passed/.test(log) || /\\s+passing/.test(log) && !/\\s+[1-9]\\d*\\s+failing/.test(log);
  const failing=(log.match(/(\\d+)\\s+failing/)||[])[1];
  const passing=(log.match(/(\\d+)\\s+passing/)||[])[1];
  const failedStart=/Cypress failed to start|bad option:/.test(log);
  return {label, exit, passed: passed && exit===0 && !failedStart, failing:failing||null, passing:passing||null, failedStart};
});
const summary={finishedAt:new Date().toISOString(), protocol:'oracle CAT A/B main:8081 vs critical-pack:8080', rows};
fs.writeFileSync(path.join(dir,'summary.json'), JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary,null,2));
process.exit(rows.every(r=>r.passed)?0:1);
" "$OUT"
echo "Wrote $SUMMARY"
