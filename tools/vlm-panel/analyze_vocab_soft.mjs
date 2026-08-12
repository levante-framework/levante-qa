#!/usr/bin/env node
/**
 * Vocab soft-score backtest (ceiling mitigation probe).
 *
 * Re-reads v3 panel jsonl (DIGIT YES|NO in modelRaw) and compares:
 *   - p_vlm     : hard correct after knows-word randomization (current)
 *   - p_knows   : fraction of YES (age-knows soft easiness)
 *   - p_model   : model digit correct *before* randomization
 *   - p_soft    : YES→1, NO→chance (0.25) expected child-like hit rate
 *
 * Usage:
 *   node tools/vlm-panel/analyze_vocab_soft.mjs
 *   node tools/vlm-panel/analyze_vocab_soft.mjs --run-id-re 'panel_vocab_en_(35flashlite|36flash)_a(6|8|11)_t(05|12)_r1$'
 */
import { createRequire } from 'module';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');
const RUNS_DIR = join(ROOT, 'cypress/logs/runs');
const OUT_DIR = join(__dirname, 'out');
const CHANCE = 0.25;

const DEFAULT_RE =
  'panel_vocab_en_(35flashlite|36flash)_a(6|8|11)_t(05|12)_r\\d+$';

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

function parseKnows(raw) {
  const text = String(raw ?? '').trim();
  const knowsMatch = text.match(/\b(yes|no)\b/i);
  const knowsWord = knowsMatch ? knowsMatch[1].toLowerCase() === 'yes' : null;
  const digitMatch = text.match(/[1-4]/);
  const modelIndex = digitMatch ? Number(digitMatch[0]) - 1 : null;
  return { knowsWord, modelIndex };
}

function fmt(x, d = 3) {
  return x == null || !Number.isFinite(x) ? '—' : x.toFixed(d);
}

function main() {
  const reStr = argValue('--run-id-re', DEFAULT_RE);
  const runRe = new RegExp(reStr);
  const destPath = join(OUT_DIR, 'd_est_vocab_en.csv');
  const screenPath = join(OUT_DIR, 'screen_vocab_en.csv');
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
  if (existsSync(screenPath)) {
    for (const r of parseCsv(readFileSync(screenPath, 'utf8'))) {
      const tr = normText(r.transcript);
      if (tr && r.item_uid) transcriptToUid.set(tr, r.item_uid);
    }
  }

  if (!existsSync(RUNS_DIR)) {
    console.error(`Missing runs dir ${RUNS_DIR}`);
    process.exit(1);
  }
  const runDirs = readdirSync(RUNS_DIR).filter((d) => runRe.test(d));
  console.log(`[filter] ${runDirs.length} run dir(s) match ${reStr}`);

  /** @type {Map<string, {correct:number[], knows:number[], modelOk:number[], soft:number[], nKnows:number}>} */
  const byUid = new Map();
  let nTrials = 0;
  let nWithKnows = 0;

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
      const { knowsWord, modelIndex } = parseKnows(rec.modelRaw);
      if (!byUid.has(uid)) {
        byUid.set(uid, { correct: [], knows: [], modelOk: [], soft: [], nKnows: 0 });
      }
      const bucket = byUid.get(uid);
      bucket.correct.push(rec.correct ? 1 : 0);
      if (knowsWord != null) {
        nWithKnows++;
        bucket.nKnows++;
        bucket.knows.push(knowsWord ? 1 : 0);
        bucket.soft.push(knowsWord ? 1 : CHANCE);
      }
      if (modelIndex != null && rec.keyedIndex != null && Number.isFinite(Number(rec.keyedIndex))) {
        bucket.modelOk.push(modelIndex === Number(rec.keyedIndex) ? 1 : 0);
      }
    }
  }

  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const rows = [];
  for (const [item_uid, b] of byUid) {
    rows.push({
      item_uid,
      n: b.correct.length,
      n_knows: b.nKnows,
      p_vlm: mean(b.correct),
      p_knows: mean(b.knows),
      p_model: mean(b.modelOk),
      p_soft: mean(b.soft),
      p_pred_child: predByUid.get(item_uid) ?? null,
      p_human: humanByUid.get(item_uid) ?? null,
      d_bank: bankByUid.get(item_uid) ?? null,
    });
  }

  function rhoNegP(getP, getY = (r) => r.d_bank) {
    const xs = [];
    const ys = [];
    for (const r of rows) {
      const p = getP(r);
      const y = getY(r);
      if (!Number.isFinite(p) || !Number.isFinite(y)) continue;
      xs.push(-p);
      ys.push(y);
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

  function rhoPos(getP, getY) {
    const xs = [];
    const ys = [];
    for (const r of rows) {
      const p = getP(r);
      const y = getY(r);
      if (!Number.isFinite(p) || !Number.isFinite(y)) continue;
      xs.push(p);
      ys.push(y);
    }
    return { n: xs.length, rho: spearman(xs, ys) };
  }

  const metrics = {
    p_vlm: rhoNegP((r) => r.p_vlm),
    p_knows: rhoNegP((r) => r.p_knows),
    p_model: rhoNegP((r) => r.p_model),
    p_soft: rhoNegP((r) => r.p_soft),
    p_pred: rhoNegP((r) => r.p_pred_child),
    human_vlm: rhoPos(
      (r) => r.p_vlm,
      (r) => r.p_human,
    ),
    human_knows: rhoPos(
      (r) => r.p_knows,
      (r) => r.p_human,
    ),
  };

  const ceils = {
    p_vlm: ceilCount((r) => r.p_vlm),
    p_knows: ceilCount((r) => r.p_knows),
    p_model: ceilCount((r) => r.p_model),
    p_soft: ceilCount((r) => r.p_soft),
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const csvPath = join(OUT_DIR, 'screen_vocab_en_soft_v3.csv');
  const header = Object.keys(rows[0] || { item_uid: 1 });
  writeFileSync(
    csvPath,
    [header.join(',')]
      .concat(rows.map((r) => header.map((h) => (r[h] == null ? '' : r[h])).join(',')))
      .join('\n') + '\n',
  );

  const bestSoft =
    [metrics.p_knows, metrics.p_soft, metrics.p_model]
      .map((m) => m.rho)
      .filter((x) => Number.isFinite(x))
      .sort((a, b) => b - a)[0] ?? null;
  const baseline = metrics.p_vlm.rho;
  let verdict = '**pending**';
  if (bestSoft != null && baseline != null) {
    if (bestSoft >= baseline + 0.05 && bestSoft >= 0.7) verdict = '**GO** — soft score clearly beats hard `p_vlm`';
    else if (bestSoft >= baseline + 0.02) verdict = '**LEAN-GO** — modest gain over hard `p_vlm`; worth promoting into analyze';
    else if (ceils.p_knows.frac != null && ceils.p_vlm.frac != null && ceils.p_knows.frac < ceils.p_vlm.frac - 0.1)
      verdict = '**PARTIAL** — less ceiling mass, but ranking not better than `p_vlm` / −`p_pred`';
    else verdict = '**NO-GO** — soft YES/NO does not beat hard accuracy ranking on this panel';
  }

  const lines = [];
  lines.push('# Vocab soft-score smoke (YES|NO / pre-randomize digit)');
  lines.push('');
  lines.push('**Date:** 2026-08-11');
  lines.push('**Idea:** Use age-knows YES|NO (and pre-randomize digit) as continuous easiness to fight CEILING on hard 4-AFC accuracy.');
  lines.push(`**Runs:** \`${reStr}\` (${runDirs.length} dirs; ${nTrials} item×resp; ${nWithKnows} with parseable YES|NO)`);
  lines.push('**Join:** transcript → `d_est_vocab_en.csv` / screen UIDs');
  lines.push('');
  lines.push('## Signals');
  lines.push('');
  lines.push('| Signal | Definition |');
  lines.push('|--------|------------|');
  lines.push('| `p_vlm` | P(correct) after v3 randomize-on-NO |');
  lines.push('| `p_knows` | P(YES) — model says child would know the word |');
  lines.push('| `p_soft` | YES→1, NO→0.25 (chance) |');
  lines.push('| `p_model` | P(model digit correct) *before* randomize |');
  lines.push('| `p_pred_child` | Existing calibrated child pass-rate from hard `p_vlm` |');
  lines.push('');
  lines.push('## Ranking vs bank `d` (−p Spearman)');
  lines.push('');
  lines.push('| Signal | n | ρ |');
  lines.push('|--------|---|---|');
  lines.push(`| −p_vlm | ${metrics.p_vlm.n} | **${fmt(metrics.p_vlm.rho)}** |`);
  lines.push(`| −p_knows | ${metrics.p_knows.n} | **${fmt(metrics.p_knows.rho)}** |`);
  lines.push(`| −p_soft | ${metrics.p_soft.n} | **${fmt(metrics.p_soft.rho)}** |`);
  lines.push(`| −p_model | ${metrics.p_model.n} | **${fmt(metrics.p_model.rho)}** |`);
  lines.push(`| −p_pred_child (ref) | ${metrics.p_pred.n} | **${fmt(metrics.p_pred.rho)}** |`);
  lines.push('');
  lines.push('## vs human pass-rate (Spearman, both easiness)');
  lines.push('');
  lines.push('| Signal | n | ρ |');
  lines.push('|--------|---|---|');
  lines.push(`| p_vlm vs p_human | ${metrics.human_vlm.n} | **${fmt(metrics.human_vlm.rho)}** |`);
  lines.push(`| p_knows vs p_human | ${metrics.human_knows.n} | **${fmt(metrics.human_knows.rho)}** |`);
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
  lines.push(`- \`${csvPath.replace(/.*out\//, 'out/')}\``);
  lines.push('- This report');
  lines.push('');

  const reportPath = join(OUT_DIR, 'REPORT_vocab_soft_v3.md');
  writeFileSync(reportPath, lines.join('\n'));
  console.log(lines.join('\n'));
  console.log(`\nWrote ${csvPath}`);
  console.log(`Wrote ${reportPath}`);
}

main();
