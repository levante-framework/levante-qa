#!/usr/bin/env node
/**
 * Fit p_vlm → p_child calibrators using levante-bench human targets and compare
 * to the existing diag-based fit (from screen_*.csv p_human).
 *
 * Usage:
 *   node tools/vlm-panel/fit_bench_calibrator.mjs --task vocab
 *   node tools/vlm-panel/fit_bench_calibrator.mjs --task trog --lang en
 *
 * Writes:
 *   tools/vlm-panel/calibration/<task>_<lang>_bench.json
 *   tools/vlm-panel/calibration/age_item_rates_<task>.json
 *   tools/vlm-panel/calibration/item_pass_rates_<task>.json
 *   tools/vlm-panel/out/bench_calibration_<task>.md
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TASK_TO_BENCH,
  ageItemRatesToJson,
  benchRoot,
  loadBenchTrialStats,
  normalizeItemUid,
  trialsPath,
} from './benchHuman.mjs';
import {
  CALIBRATION_DIR,
  PRED_AGES,
  crossValidate,
  fitCalibrator,
  inSampleMetrics,
  predictChild,
  saveCalibrator,
} from './calibration.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, 'out');

function parseArg(argv, name, fallback = null) {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return fallback;
}

function parseCsv(path) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf-8').trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = splitCsv(lines[0]);
  return lines.slice(1).map((line) => {
    const cols = splitCsv(line);
    const row = {};
    header.forEach((h, i) => {
      row[h] = cols[i] ?? '';
    });
    return row;
  });
}

function splitCsv(line) {
  const parts = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQ = !inQ;
      continue;
    }
    if (c === ',' && !inQ) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

function fmt(x, d = 3) {
  if (x == null || Number.isNaN(x)) return '—';
  return Number(x).toFixed(d);
}

function screenPath(task, lang) {
  const tag = task === 'trog' ? '' : `_${task}`;
  return join(OUT_DIR, `screen${tag}_${lang}.csv`);
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function metricsBlock(label, metrics) {
  if (!metrics || metrics.n < 5) return `- ${label}: too few pairs (n=${metrics?.n ?? 0})`;
  return (
    `- ${label} (n=${metrics.n}): MAE cal **${fmt(metrics.maeCal)}** / raw **${fmt(metrics.maeRaw)}**; ` +
    `Spearman cal **${fmt(metrics.spearmanCal)}** / raw **${fmt(metrics.spearmanRaw)}**`
  );
}

function cvBlock(label, cv) {
  if (!cv || cv.n < 5) return `- ${label}: too few for CV`;
  return (
    `- ${label} (${cv.folds}, n=${cv.n}): MAE cal **${fmt(cv.maeCal)}** / raw **${fmt(cv.maeRaw)}**; ` +
    `Spearman cal **${fmt(cv.spearmanCal)}** / raw **${fmt(cv.spearmanRaw)}**` +
    (cv.biasCal != null ? `; bias ${fmt(cv.biasCal)}` : '')
  );
}

async function main() {
  const task = parseArg(process.argv, 'task', 'vocab');
  const lang = parseArg(process.argv, 'lang', 'en');
  const version = parseArg(process.argv, 'version', 'v1');
  const chance = Number(parseArg(process.argv, 'chance', task === 'stories' ? '0.5' : '0.25'));

  if (!TASK_TO_BENCH[task]) {
    console.error(`Unknown task "${task}". Use one of: ${Object.keys(TASK_TO_BENCH).join(', ')}`);
    process.exit(1);
  }

  const scrPath = screenPath(task, lang);
  if (!existsSync(scrPath)) {
    console.error(`Missing panel screen CSV: ${scrPath}\nRun analyze.mjs --task ${task} first.`);
    process.exit(1);
  }

  const propPath = trialsPath(version);
  if (!existsSync(propPath)) {
    console.error(
      `Missing bench trials at ${propPath}\n` +
        `Set LEVANTE_BENCH_ROOT (currently ${benchRoot()}).`,
    );
    process.exit(1);
  }

  const rows = parseCsv(scrPath);
  console.error(`Streaming trials from ${benchRoot()} (may take ~30s)…`);
  const trialStats = await loadBenchTrialStats(task, version, { minN: 5, minAgeN: 5 });
  const benchP = trialStats.itemPass;

  const diagPairs = [];
  const benchPairs = [];
  let nScreen = 0;
  let nBenchJoin = 0;
  let nDiagJoin = 0;

  for (const r of rows) {
    const pVlm = num(r.p_vlm);
    if (!Number.isFinite(pVlm)) continue;
    nScreen += 1;
    const uid = normalizeItemUid(task, r.item_uid);
    const pDiag = num(r.p_human);
    if (pDiag != null) {
      nDiagJoin += 1;
      diagPairs.push({ p_vlm: pVlm, p_human: pDiag, item_uid: uid });
    }
    if (uid && benchP.has(uid)) {
      nBenchJoin += 1;
      benchPairs.push({ p_vlm: pVlm, p_human: benchP.get(uid), item_uid: uid });
    }
  }

  const diagModel = fitCalibrator(diagPairs);
  const benchModel = fitCalibrator(benchPairs);

  const diagIn = diagModel ? inSampleMetrics(diagPairs, diagModel, chance) : null;
  const benchIn = benchModel ? inSampleMetrics(benchPairs, benchModel, chance) : null;
  const diagCv = crossValidate(diagPairs, chance);
  const benchCv = crossValidate(benchPairs, chance);

  // Cross-target: apply bench-fitted model, score against diag labels where both exist
  const both = [];
  for (const r of rows) {
    const pVlm = num(r.p_vlm);
    const pDiag = num(r.p_human);
    const uid = normalizeItemUid(task, r.item_uid);
    if (!Number.isFinite(pVlm) || pDiag == null || !uid || !benchP.has(uid)) continue;
    both.push({
      p_vlm: pVlm,
      p_diag: pDiag,
      p_bench: benchP.get(uid),
      pred_diag: diagModel ? predictChild(diagModel, pVlm, chance) : null,
      pred_bench: benchModel ? predictChild(benchModel, pVlm, chance) : null,
    });
  }

  function mae(predKey, actualKey) {
    const xs = both.filter((b) => Number.isFinite(b[predKey]) && Number.isFinite(b[actualKey]));
    if (!xs.length) return null;
    return xs.reduce((s, b) => s + Math.abs(b[predKey] - b[actualKey]), 0) / xs.length;
  }

  mkdirSync(CALIBRATION_DIR, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });

  let benchCalPath = null;
  if (benchModel) {
    benchCalPath = saveCalibrator(task, `${lang}_bench`, benchModel, {
      chance,
      nMatched: benchPairs.length,
      humanSource: 'levante-bench-trials',
      trialsPath: propPath,
      cv: benchCv,
      inSample: benchIn,
    });
  }

  const ageRates = trialStats.ageItem;
  const ageJson = ageItemRatesToJson(ageRates);
  const agePath = join(CALIBRATION_DIR, `age_item_rates_${task}.json`);
  writeFileSync(agePath, JSON.stringify(ageJson, null, 2) + '\n', 'utf-8');

  const passPath = join(CALIBRATION_DIR, `item_pass_rates_${task}.json`);
  writeFileSync(
    passPath,
    JSON.stringify(
      {
        source: 'levante-bench-trials',
        task: trialStats.task,
        minN: trialStats.minN,
        nItems: benchP.size,
        items: Object.fromEntries(benchP),
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );

  let ageCoverage = 0;
  for (const p of benchPairs) {
    const rates = ageRates.byItem.get(p.item_uid);
    if (rates && PRED_AGES.some((a) => rates[String(a)] != null)) ageCoverage += 1;
  }

  const md = [];
  md.push(`# Bench vs diag calibrator — ${task} / ${lang}`);
  md.push('');
  md.push(`Generated: ${new Date().toISOString()}`);
  md.push('');
  md.push('## Joins');
  md.push(`- Panel screen items with p_vlm: **${nScreen}** (\`${scrPath}\`)`);
  md.push(`- Matched diag \`p_human\`: **${nDiagJoin}**`);
  md.push(
    `- Matched bench trial pass-rates: **${nBenchJoin}** (\`${propPath}\`; aggregated \`correct\`, not proportions image1)`,
  );
  md.push(`- Items in both human sources: **${both.length}**`);
  md.push(`- Age×item rates: **${ageJson.nItems}** items (minN=${ageJson.minN}) → \`${agePath}\``);
  md.push(`- Item pass-rates cache: \`${passPath}\``);
  md.push(`- Bench-joined items with any p_pred_age coverage: **${ageCoverage}/${benchPairs.length}**`);
  md.push('');
  md.push('## In-sample fit');
  md.push(metricsBlock('Diag target', diagIn));
  md.push(metricsBlock('Bench trials target', benchIn));
  md.push('');
  md.push('## Held-out CV');
  md.push(cvBlock('Diag target', diagCv));
  md.push(cvBlock('Bench trials target', benchCv));
  md.push('');
  md.push('## Cross-check on dual-matched items');
  md.push(`- MAE(pred_diag, p_diag): **${fmt(mae('pred_diag', 'p_diag'))}**`);
  md.push(`- MAE(pred_bench, p_bench): **${fmt(mae('pred_bench', 'p_bench'))}**`);
  md.push(`- MAE(pred_bench, p_diag): **${fmt(mae('pred_bench', 'p_diag'))}** (bench model vs diag labels)`);
  md.push(`- MAE(p_bench, p_diag): **${fmt(mae('p_bench', 'p_diag'))}** (human sources agree?)`);
  md.push('');
  if (benchCalPath) {
    md.push(`## Saved`);
    md.push(`- Bench calibrator: \`${benchCalPath}\``);
    md.push(`- Age×item rates: \`${agePath}\``);
    md.push(`- Item pass-rates: \`${passPath}\``);
    md.push('');
    md.push('Analyze: `--human-source=bench` uses `item_pass_rates_*.json` + `age_item_rates_*.json`.');
  } else {
    md.push('## Saved');
    md.push('- No bench calibrator (too few matched pairs).');
  }
  md.push('');

  const outMd = join(OUT_DIR, `bench_calibration_${task}.md`);
  writeFileSync(outMd, md.join('\n'), 'utf-8');
  console.log(md.join('\n'));
  console.error(`Wrote ${outMd}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
