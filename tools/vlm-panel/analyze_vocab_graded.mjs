#!/usr/bin/env node
/**
 * Vocab graded-confidence (v4) backtest.
 *
 * Reads panel jsonl with DIGIT HIGH|MED|LOW (or YES|NO mapped) and compares:
 *   p_vlm, p_knows, p_graded (mean soft weight), p_model vs bank d.
 *
 *   node tools/vlm-panel/analyze_vocab_graded.mjs
 *   node tools/vlm-panel/analyze_vocab_graded.mjs --run-id-re '...'
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');
const RUNS_DIR = join(ROOT, 'cypress/logs/runs');
const OUT_DIR = join(__dirname, 'out');
const CHANCE = 0.25;
const WEIGHT = { high: 1, med: 0.5, low: CHANCE };

const DEFAULT_RE =
  'panel_vocab_en_(35flashlite|36flash)_a(6|11)_t(05|12)_r\\d+$';

function argValue(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  if (!lines.length) return [];
  const headers = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).filter(Boolean).map((line) => {
    const cols = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        inQ = !inQ;
        continue;
      }
      if (c === ',' && !inQ) {
        cols.push(cur);
        cur = '';
        continue;
      }
      cur += c;
    }
    cols.push(cur);
    const o = {};
    headers.forEach((h, i) => {
      o[h] = (cols[i] ?? '').trim();
    });
    return o;
  });
}

function normText(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function spearman(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const rank = (arr) => {
    const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const ranks = new Array(n);
    for (let i = 0; i < n; ) {
      let j = i;
      while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) ranks[idx[k][1]] = avg;
      i = j + 1;
    }
    return ranks;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  for (let i = 0; i < n; i++) {
    const dx = rx[i] - mx;
    const dy = ry[i] - my;
    sx += dx * dx;
    sy += dy * dy;
    sxy += dx * dy;
  }
  if (!sx || !sy) return null;
  return sxy / Math.sqrt(sx * sy);
}

function parseConfidence(raw, recConfidence) {
  if (recConfidence === 'high' || recConfidence === 'med' || recConfidence === 'low') {
    return recConfidence;
  }
  const text = String(raw ?? '').trim();
  const graded = text.match(/\b(high|med|medium|mid|low)\b/i);
  if (graded) {
    const g = graded[1].toLowerCase();
    return g === 'high' ? 'high' : g === 'low' ? 'low' : 'med';
  }
  const yn = text.match(/\b(yes|no)\b/i);
  if (yn) return yn[1].toLowerCase() === 'yes' ? 'high' : 'low';
  return null;
}

function parseDigit(raw) {
  const m = String(raw ?? '').match(/[1-4]/);
  return m ? Number(m[0]) - 1 : null;
}

function fmt(x, d = 3) {
  return x == null || !Number.isFinite(x) ? '—' : x.toFixed(d);
}

function main() {
  const reStr = argValue('--run-id-re', DEFAULT_RE);
  const runRe = new RegExp(reStr);
  const destPath = join(OUT_DIR, 'd_est_vocab_en.csv');
  if (!existsSync(destPath)) {
    console.error(`Missing ${destPath}`);
    process.exit(1);
  }

  const bankByUid = new Map();
  const humanByUid = new Map();
  const predByUid = new Map();
  const transcriptToUid = new Map();
  for (const r of parseCsv(readFileSync(destPath, 'utf8'))) {
    const uid = r.item_uid;
    if (!uid) continue;
    const d = Number(r.d_bank);
    if (Number.isFinite(d)) bankByUid.set(uid, d);
    const ph = Number(r.p_human);
    if (Number.isFinite(ph)) humanByUid.set(uid, ph);
    const pp = Number(r.p_pred_child);
    if (Number.isFinite(pp)) predByUid.set(uid, pp);
    const tr = normText(r.transcript);
    if (tr) transcriptToUid.set(tr, uid);
  }
  const screenPath = join(OUT_DIR, 'screen_vocab_en.csv');
  if (existsSync(screenPath)) {
    for (const r of parseCsv(readFileSync(screenPath, 'utf8'))) {
      const tr = normText(r.transcript);
      if (tr && r.item_uid) transcriptToUid.set(tr, r.item_uid);
    }
  }

  const runDirs = existsSync(RUNS_DIR)
    ? readdirSync(RUNS_DIR).filter((d) => runRe.test(d))
    : [];
  console.log(`[filter] ${runDirs.length} run dir(s) match ${reStr}`);
  if (!runDirs.length) {
    console.error('No matching runs yet — finish the live smoke first.');
    process.exit(2);
  }

  const byUid = new Map();
  let nTrials = 0;
  let nGraded = 0;
  const confCounts = { high: 0, med: 0, low: 0 };

  for (const runId of runDirs) {
    const dir = join(RUNS_DIR, runId);
    const files = readdirSync(dir).filter((f) => /^vlm_.*\.jsonl?$/.test(f));
    if (!files.length) continue;
    const file = files
      .map((f) => ({ f, size: readFileSync(join(dir, f), 'utf8').length }))
      .sort((a, b) => b.size - a.size)[0].f;
    const seen = new Set();
    for (const line of readFileSync(join(dir, file), 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.itemType !== 'word' || typeof rec.correct !== 'boolean') continue;
      if (rec.chosenIndex == null && rec.chosenIndex !== 0) continue;
      const tr = normText(rec.audioTranscript || rec.targetWord || rec.promptText);
      const uid =
        transcriptToUid.get(tr) ||
        (rec.targetWord ? `vocab_word_${String(rec.targetWord).trim().toLowerCase()}` : null);
      if (!uid || seen.has(uid)) continue;
      seen.add(uid);
      nTrials++;
      const conf = parseConfidence(rec.modelRaw, rec.confidence);
      const modelIndex =
        rec.modelIndex != null && Number.isFinite(Number(rec.modelIndex))
          ? Number(rec.modelIndex)
          : parseDigit(rec.modelRaw);
      if (!byUid.has(uid)) {
        byUid.set(uid, {
          correct: [],
          graded: [],
          knows: [],
          modelOk: [],
          nHigh: 0,
          nMed: 0,
          nLow: 0,
        });
      }
      const b = byUid.get(uid);
      b.correct.push(rec.correct ? 1 : 0);
      if (conf) {
        nGraded++;
        confCounts[conf]++;
        b.graded.push(WEIGHT[conf]);
        b.knows.push(conf === 'low' ? 0 : 1);
        if (conf === 'high') b.nHigh++;
        else if (conf === 'med') b.nMed++;
        else b.nLow++;
      }
      if (modelIndex != null && rec.keyedIndex != null && Number.isFinite(Number(rec.keyedIndex))) {
        b.modelOk.push(modelIndex === Number(rec.keyedIndex) ? 1 : 0);
      }
    }
  }

  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const rows = [];
  for (const [item_uid, b] of byUid) {
    rows.push({
      item_uid,
      n: b.correct.length,
      n_graded: b.graded.length,
      p_vlm: mean(b.correct),
      p_graded: mean(b.graded),
      p_knows: mean(b.knows),
      p_model: mean(b.modelOk),
      frac_high: b.graded.length ? b.nHigh / b.graded.length : null,
      frac_med: b.graded.length ? b.nMed / b.graded.length : null,
      frac_low: b.graded.length ? b.nLow / b.graded.length : null,
      p_pred_child: predByUid.get(item_uid) ?? null,
      p_human: humanByUid.get(item_uid) ?? null,
      d_bank: bankByUid.get(item_uid) ?? null,
    });
  }

  function rhoNegP(getP) {
    const xs = [];
    const ys = [];
    for (const r of rows) {
      const p = getP(r);
      if (!Number.isFinite(p) || !Number.isFinite(r.d_bank)) continue;
      xs.push(-p);
      ys.push(r.d_bank);
    }
    return { n: xs.length, rho: spearman(xs, ys) };
  }
  function rhoPos(getP) {
    const xs = [];
    const ys = [];
    for (const r of rows) {
      const p = getP(r);
      if (!Number.isFinite(p) || !Number.isFinite(r.p_human)) continue;
      xs.push(p);
      ys.push(r.p_human);
    }
    return { n: xs.length, rho: spearman(xs, ys) };
  }
  function ceilCount(getP, cut = 0.9) {
    let n = 0;
    let c = 0;
    for (const r of rows) {
      const p = getP(r);
      if (!Number.isFinite(p)) continue;
      n++;
      if (p >= cut) c++;
    }
    return { n, c, frac: n ? c / n : null };
  }

  const metrics = {
    p_vlm: rhoNegP((r) => r.p_vlm),
    p_graded: rhoNegP((r) => r.p_graded),
    p_knows: rhoNegP((r) => r.p_knows),
    p_model: rhoNegP((r) => r.p_model),
    p_pred: rhoNegP((r) => r.p_pred_child),
    human_vlm: rhoPos((r) => r.p_vlm),
    human_graded: rhoPos((r) => r.p_graded),
  };
  const ceils = {
    p_vlm: ceilCount((r) => r.p_vlm),
    p_graded: ceilCount((r) => r.p_graded),
    p_knows: ceilCount((r) => r.p_knows),
    p_model: ceilCount((r) => r.p_model),
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const csvPath = join(OUT_DIR, 'screen_vocab_en_graded_v4.csv');
  const header = Object.keys(rows[0] || { item_uid: 1 });
  writeFileSync(
    csvPath,
    [header.join(',')]
      .concat(rows.map((r) => header.map((h) => (r[h] == null ? '' : r[h])).join(',')))
      .join('\n') + '\n',
  );

  const gradedRho = metrics.p_graded.rho;
  const vlmRho = metrics.p_vlm.rho;
  let verdict = '**pending**';
  if (gradedRho != null && vlmRho != null) {
    if (gradedRho >= vlmRho + 0.05 && gradedRho >= 0.65)
      verdict = '**GO** — graded confidence clearly beats hard `p_vlm`';
    else if (gradedRho >= vlmRho + 0.02)
      verdict = '**LEAN-GO** — modest gain; consider denser panel / wire into `d_est`';
    else if (
      ceils.p_graded.frac != null &&
      ceils.p_vlm.frac != null &&
      ceils.p_graded.frac < ceils.p_vlm.frac - 0.15
    )
      verdict =
        '**PARTIAL** — less ceiling mass on `p_graded`, but ranking not better than `p_vlm`';
    else verdict = '**NO-GO** — graded HIGH|MED|LOW does not beat hard `p_vlm` on this smoke';
  }

  const totalConf = confCounts.high + confCounts.med + confCounts.low || 1;
  const lines = [];
  lines.push('# Vocab graded-confidence smoke (v4 HIGH|MED|LOW)');
  lines.push('');
  lines.push('**Date:** 2026-08-11');
  lines.push(
    '**Idea:** Three-level age-knows confidence as continuous easiness to fight vocab CEILING.',
  );
  lines.push(
    `**Runs:** \`${reStr}\` (${runDirs.length} dirs; ${nTrials} item×resp; ${nGraded} graded)`,
  );
  lines.push(
    `**Conf mix:** HIGH ${(confCounts.high / totalConf).toFixed(2)} / MED ${(confCounts.med / totalConf).toFixed(2)} / LOW ${(confCounts.low / totalConf).toFixed(2)}`,
  );
  lines.push('');
  lines.push('## Soft map');
  lines.push('');
  lines.push('| Token | Soft p | Click policy |');
  lines.push('|-------|--------|--------------|');
  lines.push('| HIGH | 1.00 | keep digit |');
  lines.push('| MED | 0.50 | keep digit |');
  lines.push('| LOW | 0.25 (chance) | randomize |');
  lines.push('');
  lines.push('## Ranking vs bank `d` (−p Spearman)');
  lines.push('');
  lines.push('| Signal | n | ρ |');
  lines.push('|--------|---|---|');
  lines.push(`| −p_vlm | ${metrics.p_vlm.n} | **${fmt(metrics.p_vlm.rho)}** |`);
  lines.push(`| −p_graded | ${metrics.p_graded.n} | **${fmt(metrics.p_graded.rho)}** |`);
  lines.push(`| −p_knows (not-LOW) | ${metrics.p_knows.n} | **${fmt(metrics.p_knows.rho)}** |`);
  lines.push(`| −p_model | ${metrics.p_model.n} | **${fmt(metrics.p_model.rho)}** |`);
  lines.push(`| −p_pred_child (v3 ref screen) | ${metrics.p_pred.n} | **${fmt(metrics.p_pred.rho)}** |`);
  lines.push('');
  lines.push('## vs human pass-rate');
  lines.push('');
  lines.push('| Signal | n | ρ |');
  lines.push('|--------|---|---|');
  lines.push(`| p_vlm vs p_human | ${metrics.human_vlm.n} | **${fmt(metrics.human_vlm.rho)}** |`);
  lines.push(`| p_graded vs p_human | ${metrics.human_graded.n} | **${fmt(metrics.human_graded.rho)}** |`);
  lines.push('');
  lines.push('## Ceiling mass (p ≥ 0.90)');
  lines.push('');
  lines.push('| Signal | CEILING / n | frac |');
  lines.push('|--------|-------------|------|');
  for (const [k, v] of Object.entries(ceils)) {
    lines.push(`| ${k} | ${v.c} / ${v.n} | **${fmt(v.frac, 2)}** |`);
  }
  lines.push('');
  lines.push('## Verdict');
  lines.push('');
  lines.push(verdict);
  lines.push('');
  lines.push('## Artifacts');
  lines.push('');
  lines.push('- `out/screen_vocab_en_graded_v4.csv`');
  lines.push('- This report');
  lines.push('');

  const reportPath = join(OUT_DIR, 'REPORT_vocab_graded_v4.md');
  writeFileSync(reportPath, lines.join('\n'));
  console.log(lines.join('\n'));
  console.log(`\nWrote ${csvPath}`);
  console.log(`Wrote ${reportPath}`);
}

main();
