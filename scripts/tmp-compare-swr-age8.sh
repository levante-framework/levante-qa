#!/usr/bin/env bash
# Clean stock vs adaptiveTimingMultiStage SWR oracle comparison (age 8).
# Saves separate run logs under cypress/logs/runs/<id>/ and prints timing.
set -euo pipefail
cd /home/david/levante/levante-qa
unset CYPRESS_CACHE_FOLDER ELECTRON_RUN_AS_NODE

export LEVANTE_DASHBOARD_ROOT="${LEVANTE_DASHBOARD_ROOT:-/home/david/levante/levante-dashboard}"
DASHBOARD_URL="${DASHBOARD_URL:-http://127.0.0.1:5173}"
OUT_DIR="${OUT_DIR:-/tmp/swr-age8-compare}"
PIN_VARIANT_ID="${PIN_VARIANT_ID:-}"
AGE_YEARS="${AGE_YEARS:-8}"
AGENT="${AGENT:-oracle}" # oracle | vlm
mkdir -p "$OUT_DIR"

# English-only UI + narration (dev dashboard otherwise follows browser/locale defaults).
export QA_LANGUAGE="${QA_LANGUAGE:-en-US}"
export QA_PERSONA_AGE_YEARS="${QA_PERSONA_AGE_YEARS:-$AGE_YEARS}"
if [ "$AGENT" = "vlm" ]; then
  export QA_SWR_PROMPT="${QA_SWR_PROMPT:-v2}"
  export GEMINI_MODEL="${GEMINI_MODEL:-gemini-3.5-flash-lite}"
fi
echo "compare AGENT=$AGENT AGE_YEARS=$AGE_YEARS PIN_VARIANT_ID=${PIN_VARIANT_ID:-none} QA_SWR_PROMPT=${QA_SWR_PROMPT:-} QA_SWR_CHILD_PLAY=${QA_SWR_CHILD_PLAY:-} GEMINI_MODEL=${GEMINI_MODEL:-}"

# Keep Cypress off the user's display (WSL/Linux GUI). Prefer xvfb when available.
CY_SPEC="cy:run:swr:oracle"
LIVE_BASENAME="_swr_oracle_live.jsonl"
if [ "$AGENT" = "vlm" ]; then
  CY_SPEC="cy:run:swr:vlm"
  LIVE_BASENAME="_swr_vlm_live.jsonl"
fi
CY_RUN=(pnpm "$CY_SPEC")
if command -v xvfb-run >/dev/null 2>&1; then
  CY_RUN=(xvfb-run -a -s "-screen 0 1280x720x24" pnpm "$CY_SPEC")
fi

ensure_vite() {
  if curl -sf -o /dev/null --max-time 3 "$DASHBOARD_URL/"; then
    echo "vite ok: $DASHBOARD_URL"
    return 0
  fi
  echo "starting vite on 5173..."
  (
    cd "$LEVANTE_DASHBOARD_ROOT"
    export VITE_LEVANTE=TRUE VITE_FIREBASE_PROJECT=DEV
    nohup npx vite --host 127.0.0.1 --port 5173 > /tmp/vite-swr-compare.log 2>&1 &
  )
  for i in $(seq 1 30); do
    if curl -sf -o /dev/null --max-time 2 "$DASHBOARD_URL/"; then
      echo "vite ready"
      return 0
    fi
    sleep 1
  done
  echo "ERROR: vite did not start" >&2
  exit 1
}

run_one() {
  local label="$1"   # stock | atm
  local mode="${2:-}" # empty or adaptiveTimingMultiStage
  local run_id="swr${label}$(date +%s | tail -c 6)"

  echo "======== RUN $label (mode=${mode:-stock}) run_id=$run_id ========"

  export QA_RUN_ID="$run_id"
  export LAUNCH=dashboard
  export DASHBOARD_URL
  export QA_LANGUAGE
  unset QA_SWR_USER_MODE || true
  if [ -n "$mode" ]; then
    export QA_SWR_USER_MODE="$mode"
  fi

  if [ -n "$mode" ]; then
    node scripts/e2e-init/patch-roar-swr-usermode.mjs "$mode"
    # confirm vite serves stock-j2
    MODE="$mode" python3 - <<'PY'
import os, urllib.request, sys
url = "http://127.0.0.1:5173/node_modules/.vite/deps/@bdelab_roar-swr.js"
b = urllib.request.urlopen(url, timeout=30).read().decode("utf-8", "replace")
stock = "map(([e10, a3]) => [e10, a3])" in b
print(f"vite-serves-stock-j2={stock}")
if not stock:
    print("ERROR: restart vite without --force after patching", file=sys.stderr)
    sys.exit(1)
PY
  else
    node scripts/e2e-init/patch-roar-swr-usermode.mjs "" || true
  fi

  local prov_cmd=(node scripts/e2e-init/provision-participant.mjs --task swr --language en-US --age-years "$AGE_YEARS" --run-id "$run_id")
  if [ -n "$PIN_VARIANT_ID" ]; then
    prov_cmd+=(--variant-id "$PIN_VARIANT_ID")
  fi
  "${prov_cmd[@]}" > "$OUT_DIR/${label}-prov.out" 2>&1
  eval "$(node -e "const j=JSON.parse(require('fs').readFileSync('$OUT_DIR/${label}-prov.out','utf8').split('PROVISION_RESULT=')[1].trim()); console.log('export PARTICIPANT_USER='+JSON.stringify(j.email)); console.log('export PARTICIPANT_PASS='+JSON.stringify(j.password)); console.log('export QA_VARIANT_NAME='+JSON.stringify(j.variantName||'')); console.log('export QA_VARIANT_LANG='+JSON.stringify(j.language||'')); console.log('export QA_VARIANT_ID='+JSON.stringify(j.variantId||'')); console.log('export QA_NUM_ADAPTIVE='+JSON.stringify(j.numAdaptive ?? '')); console.log('export QA_USER_MODE='+JSON.stringify(j.userMode||''));")"
  echo "provision variantId=${QA_VARIANT_ID} variantName=${QA_VARIANT_NAME} language=${QA_VARIANT_LANG} userMode=${QA_USER_MODE} numAdaptive=${QA_NUM_ADAPTIVE}"
  case "${QA_VARIANT_NAME}" in
    en|en-*|en_*|English) ;;
    *)
      echo "ERROR: expected English SWR variant, got variantName=${QA_VARIANT_NAME} language=${QA_VARIANT_LANG}" >&2
      exit 1
      ;;
  esac
  if [ -n "$PIN_VARIANT_ID" ] && [ "${QA_VARIANT_ID}" != "$PIN_VARIANT_ID" ]; then
    echo "ERROR: expected variantId=${PIN_VARIANT_ID}, got ${QA_VARIANT_ID}" >&2
    exit 1
  fi
  if [ -n "${EXPECT_NUM_ADAPTIVE:-}" ]; then
    if [ "${QA_NUM_ADAPTIVE}" != "$EXPECT_NUM_ADAPTIVE" ]; then
      echo "ERROR: expected numAdaptive=${EXPECT_NUM_ADAPTIVE}, got ${QA_NUM_ADAPTIVE}" >&2
      exit 1
    fi
  elif [ -n "${QA_NUM_ADAPTIVE}" ] && [ "${QA_NUM_ADAPTIVE}" != "null" ]; then
    echo "ERROR: expected no numAdaptive on pinned variant, got ${QA_NUM_ADAPTIVE}" >&2
    exit 1
  fi

  export QA_RUN_ID="$run_id"
  export LAUNCH=dashboard
  export DASHBOARD_URL
  export QA_LANGUAGE
  unset QA_SWR_USER_MODE || true
  if [ -n "$mode" ]; then
    export QA_SWR_USER_MODE="$mode"
  fi

  local t0
  t0=$(date +%s%3N)
  set +e
  "${CY_RUN[@]}" > "$OUT_DIR/${label}-run.out" 2>&1
  local ec=$?
  set -e
  local t1
  t1=$(date +%s%3N)
  echo "$ec" > "$OUT_DIR/${label}-exit.txt"
  echo "$((t1 - t0))" > "$OUT_DIR/${label}-wall-ms.txt"

  # copy live log if scoped under runs/
  local live="cypress/logs/runs/${run_id}/${LIVE_BASENAME}"
  if [ ! -f "$live" ]; then
    live="cypress/logs/${LIVE_BASENAME}"
  fi
  if [ -f "$live" ]; then
    cp "$live" "$OUT_DIR/${label}-live.jsonl"
  fi
  echo "label=$label exit=$ec wall_ms=$((t1 - t0)) live=${live}"
  rg -n "Error:|AssertionError|passing|failing|Duration:|items:" "$OUT_DIR/${label}-run.out" | head -20 || true
}

ensure_vite

# 1) stock current (no ATM bridge env)
run_one stock ""

# 2) adaptiveTimingMultiStage — may need vite restart if patch not served
if ! MODE=adaptiveTimingMultiStage python3 - <<'PY'
import urllib.request, sys
url = "http://127.0.0.1:5173/node_modules/.vite/deps/@bdelab_roar-swr.js"
try:
    b = urllib.request.urlopen(url, timeout=10).read().decode("utf-8", "replace")
except Exception as e:
    print(e); sys.exit(1)
sys.exit(0 if "adaptiveTimingMultiStage" in b else 1)
PY
then
  echo "WARN: vite roar-swr missing ATM string" >&2
fi

# Restart vite after applying patch so in-memory deps pick it up
node scripts/e2e-init/patch-roar-swr-usermode.mjs adaptiveTimingMultiStage
fuser -k 5173/tcp 2>/dev/null || true
sleep 2
(
  cd "$LEVANTE_DASHBOARD_ROOT"
  export VITE_LEVANTE=TRUE VITE_FIREBASE_PROJECT=DEV
  nohup npx vite --host 127.0.0.1 --port 5173 > /tmp/vite-swr-compare.log 2>&1 &
)
for i in $(seq 1 30); do
  curl -sf -o /dev/null --max-time 2 "$DASHBOARD_URL/" && break
  sleep 1
done

run_one atm adaptiveTimingMultiStage

# restore stock prebundle
node scripts/e2e-init/patch-roar-swr-usermode.mjs "" || true

python3 - <<'PY'
import json, os
from pathlib import Path
from datetime import datetime

out = Path(os.environ.get("OUT_DIR", "/tmp/swr-age8-compare"))

def load_live(label):
    p = out / f"{label}-live.jsonl"
    if not p.exists():
        return []
    rows = []
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except Exception:
            pass
    return rows

def parse_ts(v):
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            return datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp() * 1000
        except Exception:
            return None
    return None

def summarize(label):
    rows = load_live(label)
    wall = int((out / f"{label}-wall-ms.txt").read_text().strip()) if (out / f"{label}-wall-ms.txt").exists() else None
    exit_c = int((out / f"{label}-exit.txt").read_text().strip()) if (out / f"{label}-exit.txt").exists() else None
    by_type = {}
    for r in rows:
        t = r.get("itemType") or "?"
        by_type[t] = by_type.get(t, 0) + 1
    items = [r for r in rows if r.get("itemType") == "item"]
    practice = [r for r in rows if r.get("itemType") == "practice"]
    ip_instr = [r for r in rows if r.get("itemType") in ("intro", "tutorial")]
    breaks = [r for r in rows if r.get("itemType") == "break"]
    modes = sorted({r.get("userMode") for r in (items + practice) if r.get("userMode")})
    pts = sorted({str(r.get("presentationTime")) for r in (items + practice)})
    ts = [parse_ts(r.get("timestamp")) for r in rows]
    ts = [t for t in ts if t is not None]
    full_span = round((max(ts) - min(ts)) / 1000, 1) if len(ts) >= 2 else None
    item_ts = [parse_ts(r.get("timestamp")) for r in items]
    item_ts = [t for t in item_ts if t is not None]
    item_span = round((max(item_ts) - min(item_ts)) / 1000, 1) if len(item_ts) >= 2 else None
    # Full IP = instructions/tutorial markers + practice trials until first scored item
    ip_rows = ip_instr + practice
    ip_ts = [parse_ts(r.get("timestamp")) for r in ip_rows]
    ip_ts = [t for t in ip_ts if t is not None]
    ip_span = None
    if ip_ts and item_ts:
        ip_span = round((min(item_ts) - min(ip_ts)) / 1000, 1)
    elif ip_ts:
        ip_span = round((max(ip_ts) - min(ip_ts)) / 1000, 1)
    instr_rt = [r.get("rtMs") for r in ip_instr if isinstance(r.get("rtMs"), (int, float))]
    practice_rt = [r.get("rtMs") for r in practice if isinstance(r.get("rtMs"), (int, float))]
    correct = sum(1 for r in items if r.get("correct") is True)
    incorrect = sum(1 for r in items if r.get("correct") is False)
    return {
        "label": label,
        "exit": exit_c,
        "wall_ms": wall,
        "wall_sec": round(wall / 1000, 1) if wall is not None else None,
        "log_span_sec": full_span,
        "ip_span_sec": ip_span,
        "ip_instruction_rt_sum_ms": round(sum(instr_rt), 1) if instr_rt else None,
        "ip_practice_n": len(practice),
        "ip_practice_rt_sum_ms": round(sum(practice_rt), 1) if practice_rt else None,
        "item_span_sec": item_span,
        "counts": by_type,
        "items": len(items),
        "breaks": len(breaks),
        "modes": modes,
        "presentationTimes": pts,
        "correct": correct,
        "incorrect": incorrect,
    }

report = {"stock": summarize("stock"), "atm": summarize("atm")}
(out / "compare-summary.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
if report["stock"]["wall_sec"] is not None and report["atm"]["wall_sec"] is not None:
    saved = report["stock"]["wall_sec"] - report["atm"]["wall_sec"]
    print(f"\nwall_time_saved_sec={saved:.1f} (stock - atm)")
if report["stock"]["log_span_sec"] is not None and report["atm"]["log_span_sec"] is not None:
    saved = report["stock"]["log_span_sec"] - report["atm"]["log_span_sec"]
    print(f"log_span_saved_sec={saved:.1f} (intro→last event)")
PY
