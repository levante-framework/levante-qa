#!/usr/bin/env bash
set -euo pipefail
cd /home/david/levante/levante-qa
unset CYPRESS_CACHE_FOLDER ELECTRON_RUN_AS_NODE
MODE="${1:-adaptiveTimingMultiStage}"
RUN_ID="swrqa$(date +%s | tail -c 5)"
export LEVANTE_DASHBOARD_ROOT="${LEVANTE_DASHBOARD_ROOT:-/home/david/levante/levante-dashboard}"
node scripts/e2e-init/patch-roar-swr-usermode.mjs "$MODE"
MODE="$MODE" python3 - <<'PY'
import os, urllib.request, sys
mode = os.environ["MODE"]
url = "http://127.0.0.1:5173/node_modules/.vite/deps/@bdelab_roar-swr.js"
try:
    b = urllib.request.urlopen(url, timeout=30).read().decode("utf-8", "replace")
except Exception as e:
    print("WARN: cannot fetch roar-swr from vite:", e, file=sys.stderr)
    sys.exit(0)
stock = "map(([e10, a3]) => [e10, a3])" in b
merged = "E2[e10] ?? a3" in b and "map(([e10, a3]) => [e10, E2[e10] ?? a3])" in b
print(f"vite-serves-stock-j2={stock} still-merged-j2={merged}")
if not stock:
    print(
        "ERROR: vite is not serving stock-j2 roar-swr patch. "
        "Restart vite (without --force) after patching.",
        file=sys.stderr,
    )
    sys.exit(1)
PY
node scripts/e2e-init/provision-participant.mjs --task swr --language en-US --age-years 8 --run-id "$RUN_ID" > /tmp/swr-qa-prov.out 2>&1
eval "$(node -e "const j=JSON.parse(require('fs').readFileSync('/tmp/swr-qa-prov.out','utf8').split('PROVISION_RESULT=')[1].trim()); console.log('export PARTICIPANT_USER='+JSON.stringify(j.email)); console.log('export PARTICIPANT_PASS='+JSON.stringify(j.password));")"
rm -f cypress/logs/_swr_oracle_live.jsonl
echo "MODE=$MODE"
LAUNCH=dashboard DASHBOARD_URL=http://127.0.0.1:5173 QA_SWR_USER_MODE="$MODE" \
  pnpm cy:run:swr:oracle 2>&1 | tee /tmp/swr-qa-oracle.out
rg -n "Error:|AssertionError|passing|failing|stock-j2|SWR userMode|sawTimedStage|items:" /tmp/swr-qa-oracle.out | head -30
if [ -f cypress/logs/_swr_oracle_live.jsonl ]; then
  node -e "const fs=require('fs');const r=fs.readFileSync('cypress/logs/_swr_oracle_live.jsonl','utf8').trim().split(/\\n+/).filter(Boolean).map(l=>JSON.parse(l));const i=r.filter(x=>x.itemType==='item');console.log(JSON.stringify({items:i.length,modes:[...new Set(i.map(x=>x.userMode))],pts:[...new Set(i.map(x=>String(x.presentationTime)))] }));"
fi
node scripts/e2e-init/patch-roar-swr-usermode.mjs "" || true
