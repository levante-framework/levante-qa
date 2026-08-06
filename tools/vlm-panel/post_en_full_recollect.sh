#!/usr/bin/env bash
# Post-steps after full EN TROG force recollect (out/recollect_en_full_force.log).
# Usage: bash tools/vlm-panel/post_en_full_recollect.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "== analyze (full EN, current prompts) =="
node tools/vlm-panel/analyze.mjs --task trog --human-source=bench

echo "== fit bench calibrator =="
node tools/vlm-panel/fit_bench_calibrator.mjs --task trog

echo "== re-analyze with refreshed calibrator =="
node tools/vlm-panel/analyze.mjs --task trog --human-source=bench

echo "== estimate difficulty vs baseline =="
node tools/vlm-panel/estimate_difficulty.mjs --task trog --lang en \
  --baseline tools/vlm-panel/out/d_est_trog_en_baseline_full.json

echo "== pred MAE snapshot =="
node --input-type=module <<'EOF'
import { readFileSync, writeFileSync } from 'fs';
function parseCsv(text) {
  const lines = text.trim().split(/\n/);
  const split = (line) => {
    const c = []; let cur = '', q = false;
    for (const ch of line) {
      if (ch === '"') { q = !q; continue; }
      if (ch === ',' && !q) { c.push(cur); cur = ''; continue; }
      cur += ch;
    }
    c.push(cur); return c;
  };
  const h = split(lines[0]);
  return lines.slice(1).map((line) => {
    const cols = split(line);
    const row = {};
    h.forEach((k, i) => { row[k] = cols[i] ?? ''; });
    return row;
  });
}
const rows = parseCsv(readFileSync('tools/vlm-panel/out/screen_en.csv', 'utf8'));
const base = JSON.parse(readFileSync('tools/vlm-panel/out/trog_en_pred_baseline.json', 'utf8'));
let n = 0, maeRaw = 0, maeCal = 0, nc = 0;
for (const r of rows) {
  const pv = Number(r.p_vlm), ph = Number(r.p_human), pp = Number(r.p_pred_child);
  if (Number.isFinite(pv) && Number.isFinite(ph)) { n++; maeRaw += Math.abs(pv - ph); }
  if (Number.isFinite(pp) && Number.isFinite(ph)) { nc++; maeCal += Math.abs(pp - ph); }
}
const cur = {
  generated: new Date().toISOString(),
  label: 'post_full_en_recollect',
  n_items_pv_ph: n,
  mae_p_vlm_vs_human: n ? maeRaw / n : null,
  mae_p_pred_vs_human: nc ? maeCal / nc : null,
};
writeFileSync('tools/vlm-panel/out/trog_en_pred_after.json', JSON.stringify(cur, null, 2) + '\n');
const fmt = (x) => (x == null || Number.isNaN(x) ? '—' : x.toFixed(3));
console.log('| Metric | baseline | after | Δ |');
console.log('|--------|----------|-------|---|');
console.log(`| MAE p_vlm vs human | ${fmt(base.mae_p_vlm_vs_human)} | ${fmt(cur.mae_p_vlm_vs_human)} | ${fmt(cur.mae_p_vlm_vs_human - base.mae_p_vlm_vs_human)} |`);
console.log(`| MAE p_pred vs human | ${fmt(base.mae_p_pred_vs_human)} | ${fmt(cur.mae_p_pred_vs_human)} | ${fmt(cur.mae_p_pred_vs_human - base.mae_p_pred_vs_human)} |`);
EOF

echo "Done. See out/d_est_trog_en_report.md (Before/after) and out/trog_en_pred_after.json"
