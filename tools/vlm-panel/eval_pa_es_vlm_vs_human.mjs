#!/usr/bin/env node
/**
 * Compare PA ES VLM b_proxy to Bogotá human b.
 *
 *   node tools/vlm-panel/eval_pa_es_vlm_vs_human.mjs
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parseCSV, writeCsv, spearman, bFromP, PA_CHANCE } from './lib/paEs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');
const HUMAN = join(OUT, 'pa_es_human_baseline.csv');
const VLM = join(OUT, 'pa_es_vlm_ratings.csv');

function mae(xs, ys) {
  const n = xs.length;
  if (!n) return null;
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.abs(xs[i] - ys[i]);
  return s / n;
}

function fitLinear(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const slope = den ? num / den : 0;
  return { slope, intercept: my - slope * mx };
}

function fmt(x, d = 3) {
  return Number.isFinite(x) ? x.toFixed(d) : 'n/a';
}

function ageAvg(ratings, variant) {
  const by = new Map();
  for (const r of ratings) {
    if (r.variant !== variant) continue;
    const p = Number(r.p_child);
    if (!Number.isFinite(p)) continue;
    const row = by.get(r.item_uid) || { item_uid: r.item_uid, subtype: r.subtype, ps: [] };
    row.ps.push(p);
    by.set(r.item_uid, row);
  }
  return [...by.values()].map((r) => ({
    item_uid: r.item_uid,
    subtype: r.subtype,
    p_avg: r.ps.reduce((a, b) => a + b, 0) / r.ps.length,
    n_ages: r.ps.length,
  }));
}

function score(label, rows) {
  const xs = rows.map((r) => r.b_proxy);
  const ys = rows.map((r) => r.b_human);
  const fit = fitLinear(xs, ys);
  const cal = rows.map((r) => fit.slope * r.b_proxy + fit.intercept);
  const ceil = rows.filter((r) => r.p_avg >= 0.99).length / Math.max(1, rows.length);
  const bySub = {};
  for (const sub of ['fsm', 'lsm']) {
    const sl = rows.filter((r) => r.subtype === sub);
    if (sl.length >= 3) {
      bySub[sub] = {
        n: sl.length,
        rho: spearman(
          sl.map((r) => r.b_proxy),
          sl.map((r) => r.b_human),
        ),
      };
    }
  }
  return {
    label,
    n: rows.length,
    rho: spearman(xs, ys),
    mae_raw: mae(xs, ys),
    mae_cal: mae(cal, ys),
    fit,
    ceil,
    n_unique_p: new Set(rows.map((r) => r.p_avg)).size,
    bySub,
  };
}

function main() {
  if (!existsSync(HUMAN) || !existsSync(VLM)) {
    console.error('Need pa_es_human_baseline.csv and pa_es_vlm_ratings.csv');
    process.exit(1);
  }
  mkdirSync(OUT, { recursive: true });
  const human = new Map(parseCSV(readFileSync(HUMAN, 'utf8')).map((r) => [r.item_uid, r]));
  const ratings = parseCSV(readFileSync(VLM, 'utf8'));
  const variants = [...new Set(ratings.map((r) => r.variant))];
  const stats = [];
  const joinedRows = [];

  for (const v of variants) {
    const avg = ageAvg(ratings, v);
    const rows = avg
      .map((a) => {
        const h = human.get(a.item_uid);
        if (!h || !Number.isFinite(Number(h.b_human))) return null;
        const b_proxy = bFromP(a.p_avg, PA_CHANCE);
        return {
          item_uid: a.item_uid,
          subtype: a.subtype,
          variant: v,
          p_avg: a.p_avg,
          b_proxy,
          b_human: Number(h.b_human),
          n_human: Number(h.n),
        };
      })
      .filter(Boolean);
    joinedRows.push(...rows);
    stats.push(score(`${v}_age_avg`, rows));
  }

  writeCsv(join(OUT, 'pa_es_vlm_vs_human.csv'), joinedRows, [
    'item_uid',
    'subtype',
    'variant',
    'p_avg',
    'b_proxy',
    'b_human',
    'n_human',
  ]);

  const best = [...stats].sort((a, b) => (b.rho ?? -1) - (a.rho ?? -1))[0];
  const verdict =
    (best?.rho ?? 0) >= 0.4
      ? '**LEAN-GO** for draft ES PA ranking (ρ≳0.4). Not a bank overwrite.'
      : '**ITERATE** — VLM ranking below ρ=0.4 vs human p→b.';

  const table = stats
    .map((s) => {
      const fsm = s.bySub.fsm ? fmt(s.bySub.fsm.rho) : 'n/a';
      const lsm = s.bySub.lsm ? fmt(s.bySub.lsm.rho) : 'n/a';
      return `| ${s.label} | ${s.n} | **${fmt(s.rho)}** | ${fmt(s.ceil)} | ${s.n_unique_p} | ${fmt(s.mae_cal)} | ${fsm} | ${lsm} |`;
    })
    .join('\n');

  const report = `# PA ES VLM vs human difficulty

**Date:** ${new Date().toISOString().slice(0, 10)}  
**Human:** Bogotá \`pilot_uniandes_co\` empirical \`b_human=-z(p)\` (3AFC).  
**VLM:** text-only Gemini on stim/goal/foils (no audio / no Cypress).

## Results (age-avg)

| Condition | n | ρ(b_proxy, b_human) | ceil% | n_p | MAE cal | ρ FSM | ρ LSM |
|-----------|--:|--------------------:|------:|----:|--------:|------:|------:|
${table}

**Winner:** \`${best?.label}\` ρ=${fmt(best?.rho)}.

${verdict}

Human coverage (all 53 items n≥394) is **enough** for this comparison — see \`REPORT_pa_es_human_baseline.md\`.

CSVs: \`out/pa_es_vlm_ratings.csv\`, \`out/pa_es_vlm_vs_human.csv\`
`;

  writeFileSync(join(OUT, 'REPORT_pa_es_vlm_vs_human.md'), report);
  console.log(
    JSON.stringify(
      {
        stats: stats.map((s) => ({
          label: s.label,
          n: s.n,
          rho: s.rho,
          ceil: s.ceil,
          mae_cal: s.mae_cal,
          fsm: s.bySub.fsm?.rho,
          lsm: s.bySub.lsm?.rho,
        })),
        winner: best?.label,
        report: 'tools/vlm-panel/out/REPORT_pa_es_vlm_vs_human.md',
      },
      null,
      2,
    ),
  );
}

main();
