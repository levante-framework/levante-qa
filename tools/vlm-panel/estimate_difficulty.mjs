#!/usr/bin/env node
/**
 * Map calibrated panel pass-rates (+ item features) to bank-scale IRT difficulty.
 *
 * Hybrid model (v2):
 *   z = logit( clip( (p − c) / (1 − c) ) )   from p_pred_child (fallback p_vlm)
 *   d_est = X β   via standardized ridge + Huber IRLS
 * Features: z; TROG construction tags; vocab Kuperman AoA (not Zipf).
 *
 * Held-out CV scores recovery of the fit referee (TROG: bank `d`;
 * vocab: kids IRT `difficulty`, not old CAT `d`). Reports p-only Spearman
 * ceiling so multivariate gains are explicit.
 *
 * Usage:
 *   node tools/vlm-panel/estimate_difficulty.mjs --task trog
 *   node tools/vlm-panel/estimate_difficulty.mjs --task vocab --lang en
 *   node tools/vlm-panel/estimate_difficulty.mjs --task trog --baseline out/d_est_trog_en_baseline.json
 *   node tools/vlm-panel/estimate_difficulty.mjs --task stories --lang en
 *   node tools/vlm-panel/estimate_difficulty.mjs --task matrix --lang en
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tagResidual } from './audit_residuals.mjs';
import { vocabIrtD, vocabCorpusFile } from './vocab_bank_d.mjs';
import { lookupAoa } from './lib/aoa.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, 'out');
const CALIBRATION_DIR = join(HERE, 'calibration');
const CACHE_DIR = join(HERE, '..', '..', 'cypress', 'cache');
const VOCAB_CORPORA_DIR = join(HERE, 'corpora', 'vocab');
const LEXICON_PATH = join(HERE, 'vocab_lexicon.json');
const BENCH_IRT = join(
  HERE,
  '..',
  '..',
  '..',
  'levante-bench',
  'data',
  'responses',
  'v2',
  'irt_models',
);

const MIN_ANCHORS = 20;
const EPS = 1e-4;
const DEFAULT_CHANCE = 0.25;
const RIDGE_LAMBDA = 1e-2;
const HUBER_K = 1.345;
const IRLS_ITERS = 25;

/** Construction tags kept as separate binary features (else collapsed). */
const TROG_TAG_FEATURES = [
  'passive',
  'comparative',
  'reverse_agent',
  'disjunctive',
  'negation',
  'spatial',
  'relative_clause',
];

const TASK_CFG = {
  trog: {
    bankFile: 'sim-item-bank-trog.csv',
    defaultScreen: (lang) =>
      lang === 'en' ? 'screen_en.csv' : `screen_${lang}.csv`,
    passRates: 'item_pass_rates_trog.json',
    benchParams: 'trog_item_params.csv',
    toBankUid: (uid) => uid,
  },
  vocab: {
    bankFile: 'sim-item-bank-vocab.csv',
    bankPath: (lang) => join(VOCAB_CORPORA_DIR, vocabCorpusFile(lang)),
    defaultScreen: (lang) => `screen_vocab_${lang}.csv`,
    passRates: 'item_pass_rates_vocab.json',
    benchParams: 'vocab_item_params.csv',
    toBankUid: (uid) => {
      const m = /^vocab_word_(.+)$/.exec(uid);
      return m ? `vocab__${m[1]}` : uid;
    },
  },
  /** QA task id `stories` = theory-of-mind bank; UIDs `tom_*`. */
  stories: {
    bankFile: 'sim-item-bank-theory-of-mind.csv',
    defaultScreen: (lang) => `screen_stories_${lang}.csv`,
    passRates: 'item_pass_rates_stories.json',
    benchParams: 'theory-of-mind_item_params.csv',
    // Bench IRT rows are tom_storyN_*; bank/screen use tom_*.
    toBankUid: (uid) => {
      const m = /^tom_story\d+_(.+)$/i.exec(String(uid || ''));
      return m ? `tom_${m[1]}` : uid;
    },
    // Bank has no shipped difficulty — seed fit anchors from bench IRT
    // (easiness-coded export → flip so higher = harder, like CAT d).
    seedAnchorsFromBench: true,
    flipBenchDifficulty: true,
  },
  /** Matrix Reasoning — bank `difficulty` is filled; features = z only. */
  matrix: {
    bankFile: 'sim-item-bank-matrix-reasoning.csv',
    defaultScreen: (lang) => `screen_matrix_${lang}.csv`,
    passRates: 'item_pass_rates_matrix.json',
    benchParams: 'matrix-reasoning_item_params.csv',
    toBankUid: (uid) => uid,
  },
};

function parseArg(argv, name, fallback = null) {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return fallback;
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

function readCsv(path) {
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

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseBankD(raw) {
  const s = String(raw ?? '').trim();
  if (!s || s === 'NA' || s === 'None' || s === 'null') return null;
  return num(s);
}

function clip(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function logit(p) {
  const x = clip(p, EPS, 1 - EPS);
  return Math.log(x / (1 - x));
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function mae(pred, actual) {
  if (!pred.length) return null;
  let s = 0;
  for (let i = 0; i < pred.length; i++) s += Math.abs(pred[i] - actual[i]);
  return s / pred.length;
}

function rmse(pred, actual) {
  if (!pred.length) return null;
  let s = 0;
  for (let i = 0; i < pred.length; i++) {
    const e = pred[i] - actual[i];
    s += e * e;
  }
  return Math.sqrt(s / pred.length);
}

function bias(pred, actual) {
  if (!pred.length) return null;
  let s = 0;
  for (let i = 0; i < pred.length; i++) s += pred[i] - actual[i];
  return s / pred.length;
}

function ranks(xs) {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j < idx.length && idx[j][0] === idx[i][0]) j++;
    const avg = (i + j - 1) / 2 + 1;
    for (let k = i; k < j; k++) r[idx[k][1]] = avg;
    i = j;
  }
  return r;
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den > 0 ? num / den : null;
}

function spearman(xs, ys) {
  if (xs.length < 2) return null;
  return pearson(ranks(xs), ranks(ys));
}

function fmt(x, d = 3) {
  if (x == null || Number.isNaN(x)) return '—';
  return Number(x).toFixed(d);
}

function passToZ(p, c) {
  if (!Number.isFinite(p) || !Number.isFinite(c) || c >= 1) return null;
  const adj = (p - c) / (1 - c);
  if (!Number.isFinite(adj)) return null;
  return logit(adj);
}

function fitAffine(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    sxx += dx * dx;
    sxy += dx * (ys[i] - my);
  }
  if (sxx <= 0) return { a: my, b: 0 };
  const b = sxy / sxx;
  const a = my - b * mx;
  return { a, b };
}

function predictAffine(model, z) {
  if (!model || !Number.isFinite(z)) return null;
  return model.a + model.b * z;
}

function makeFolds(n, k = 5) {
  const folds = Array.from({ length: Math.min(k, n) }, () => []);
  for (let i = 0; i < n; i++) folds[i % folds.length].push(i);
  return folds;
}

/** Gaussian elimination for Ax = b (A is p×p, mutated). */
function solveLinear(A, b) {
  const p = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < p; col++) {
    let piv = col;
    for (let r = col + 1; r < p; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    if (piv !== col) {
      const tmp = M[col];
      M[col] = M[piv];
      M[piv] = tmp;
    }
    const div = M[col][col];
    for (let j = col; j <= p; j++) M[col][j] /= div;
    for (let r = 0; r < p; r++) {
      if (r === col) continue;
      const f = M[r][col];
      for (let j = col; j <= p; j++) M[r][j] -= f * M[col][j];
    }
  }
  return M.map((row) => row[p]);
}

/**
 * Weighted ridge: (X'WX + λI) β = X'Wy.
 * X is n×p (includes intercept column). W diagonal via weights array.
 */
function fitWeightedRidge(X, y, weights, lambda = RIDGE_LAMBDA) {
  const n = y.length;
  const p = X[0].length;
  const XtWX = Array.from({ length: p }, () => Array(p).fill(0));
  const XtWy = Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    const w = weights[i];
    const xi = X[i];
    const yi = y[i];
    for (let a = 0; a < p; a++) {
      XtWy[a] += w * xi[a] * yi;
      for (let b = 0; b < p; b++) XtWX[a][b] += w * xi[a] * xi[b];
    }
  }
  for (let a = 0; a < p; a++) {
    // Do not ridge the intercept (column 0).
    if (a > 0) XtWX[a][a] += lambda;
  }
  return solveLinear(XtWX, XtWy);
}

function madScale(residuals) {
  const abs = residuals.map((r) => Math.abs(r)).sort((a, b) => a - b);
  const med = abs[Math.floor(abs.length / 2)] || 1;
  return Math.max(1e-6, 1.4826 * med);
}

/** Huber IRLS around standardized features. Returns {names, betaRaw, means, sds}. */
function fitHuberRidge(featureRows, y, featureNames) {
  const n = y.length;
  const pFeat = featureNames.length;
  const means = featureNames.map((_, j) => mean(featureRows.map((r) => r[j])));
  const sds = featureNames.map((_, j) => {
    const m = means[j];
    const v = mean(featureRows.map((r) => (r[j] - m) ** 2));
    return Math.sqrt(v) || 1;
  });
  // X: intercept + standardized features
  const X = featureRows.map((row) => {
    const x = [1];
    for (let j = 0; j < pFeat; j++) x.push((row[j] - means[j]) / sds[j]);
    return x;
  });
  let weights = Array(n).fill(1);
  let beta = fitWeightedRidge(X, y, weights);
  if (!beta) return null;

  for (let iter = 0; iter < IRLS_ITERS; iter++) {
    const resid = y.map((yi, i) => {
      let yh = 0;
      for (let j = 0; j < beta.length; j++) yh += X[i][j] * beta[j];
      return yi - yh;
    });
    const s = madScale(resid);
    const delta = HUBER_K * s;
    weights = resid.map((r) => {
      const a = Math.abs(r);
      return a <= delta ? 1 : delta / a;
    });
    const next = fitWeightedRidge(X, y, weights);
    if (!next) break;
    let maxDiff = 0;
    for (let j = 0; j < beta.length; j++) {
      maxDiff = Math.max(maxDiff, Math.abs(next[j] - beta[j]));
    }
    beta = next;
    if (maxDiff < 1e-8) break;
  }

  // Unstandardize: y = b0' + Σ b_j' * (x_j - m_j)/s_j
  //            = (b0' - Σ b_j' m_j/s_j) + Σ (b_j'/s_j) x_j
  const betaRaw = Array(pFeat + 1).fill(0);
  betaRaw[0] = beta[0];
  for (let j = 0; j < pFeat; j++) {
    const bj = beta[j + 1] / sds[j];
    betaRaw[j + 1] = bj;
    betaRaw[0] -= beta[j + 1] * (means[j] / sds[j]);
  }
  return { names: ['intercept', ...featureNames], betaRaw, means, sds, betaStd: beta };
}

function predictMultivar(model, featRow) {
  if (!model || !featRow) return null;
  let y = model.betaRaw[0];
  for (let j = 0; j < featRow.length; j++) {
    y += model.betaRaw[j + 1] * featRow[j];
  }
  return y;
}

function aliasVocabUids(uid) {
  const out = [uid];
  const word = /^vocab_word_(.+)$/.exec(uid);
  const bare = /^vocab__(.+)$/.exec(uid);
  if (word) out.push(`vocab__${word[1]}`);
  if (bare) out.push(`vocab_word_${bare[1]}`);
  return out;
}

function loadBank(task, cfg, lang) {
  const path =
    typeof cfg.bankPath === 'function' ? cfg.bankPath(lang) : join(CACHE_DIR, cfg.bankFile);
  if (!existsSync(path)) {
    throw new Error(`Missing item bank cache: ${path}`);
  }
  const byUid = new Map();
  let nRows = 0;
  for (const r of readCsv(path)) {
    const uid = (r.item_uid || '').trim();
    if (!uid) continue;
    nRows += 1;
    const d = task === 'vocab' ? vocabIrtD(r) : parseBankD(r.d) ?? parseBankD(r.difficulty);
    const chance = num(r.chance_level);
    const rec = {
      d_bank: d,
      chance: chance != null ? chance : DEFAULT_CHANCE,
      answer: (r.answer || '').trim(),
    };
    const keys = task === 'vocab' ? aliasVocabUids(uid) : [uid];
    for (const k of keys) byUid.set(k, rec);
  }
  return { path, byUid, nRows };
}

function loadBenchParams(cfg) {
  const path = join(BENCH_IRT, cfg.benchParams);
  if (!existsSync(path)) return { path: null, byUid: new Map() };
  const byUid = new Map();
  for (const r of readCsv(path)) {
    const uid = (r.item_uid || '').trim();
    const d = parseBankD(r.difficulty) ?? parseBankD(r.d);
    if (!uid || d == null) continue;
    byUid.set(uid, d);
    const bankUid = cfg.toBankUid(uid);
    if (bankUid && bankUid !== uid) byUid.set(bankUid, d);
  }
  return { path, byUid };
}

/** When bank d is blank, use bench IRT as in-memory anchors for the hybrid fit. */
function seedBankAnchorsFromBench(bank, bench, cfg) {
  if (!cfg.seedAnchorsFromBench || !bench?.byUid?.size) return { seeded: 0 };
  let seeded = 0;
  for (const [uid, row] of bank.byUid) {
    if (row.d_bank != null) continue;
    const raw = bench.byUid.get(uid);
    if (raw == null) continue;
    row.d_bank = cfg.flipBenchDifficulty ? -raw : raw;
    row.d_bank_source = 'bench_irt';
    seeded += 1;
  }
  return { seeded };
}

function loadPassRates(cfg) {
  const path = join(CALIBRATION_DIR, cfg.passRates);
  if (!existsSync(path)) return { path: null, byUid: new Map() };
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  const items = raw.items && typeof raw.items === 'object' ? raw.items : {};
  const byUid = new Map();
  for (const [uid, v] of Object.entries(items)) {
    const p = num(v);
    if (p != null) byUid.set(uid, p);
  }
  return { path, byUid };
}

function loadZipfLexicon() {
  if (!existsSync(LEXICON_PATH)) return { path: null, byUid: new Map(), median: 3.5 };
  const raw = JSON.parse(readFileSync(LEXICON_PATH, 'utf-8'));
  const byUid = new Map();
  const vals = [];
  for (const [, info] of Object.entries(raw.words || {})) {
    const z = num(info.zipf);
    if (z == null) continue;
    vals.push(z);
    for (const uid of info.item_uids || []) byUid.set(uid, z);
  }
  vals.sort((a, b) => a - b);
  const median = vals.length ? vals[Math.floor(vals.length / 2)] : 3.5;
  return { path: LEXICON_PATH, byUid, median };
}

function aoaFromWord(word) {
  const w = String(word || '')
    .replace(/^the\s+/i, '')
    .trim()
    .toLowerCase();
  if (!w) return null;
  const direct = lookupAoa(w);
  if (direct != null) return direct;
  const last = w.split(/\s+/).pop();
  return last && last !== w ? lookupAoa(last) : null;
}

/** Kuperman 2012 AoA (years; higher = learned later). Median-fill misses. */
function loadAoaLexicon() {
  const byUid = new Map();
  const vals = [];
  if (existsSync(LEXICON_PATH)) {
    const raw = JSON.parse(readFileSync(LEXICON_PATH, 'utf-8'));
    for (const [word, info] of Object.entries(raw.words || {})) {
      const aoa = aoaFromWord(word);
      if (aoa == null) continue;
      vals.push(aoa);
      for (const uid of info.item_uids || []) byUid.set(uid, aoa);
    }
  }
  vals.sort((a, b) => a - b);
  const median = vals.length ? vals[Math.floor(vals.length / 2)] : 6;
  return { path: 'data/aoa_kuperman.csv', byUid, median, n: vals.length };
}

function resolveHuman(screenP, passRates, bankUid, screenUid) {
  if (screenP != null) return screenP;
  return passRates.get(screenUid) ?? passRates.get(bankUid) ?? null;
}

function featureNamesFor(task) {
  if (task === 'trog') return ['z', ...TROG_TAG_FEATURES];
  if (task === 'stories' || task === 'matrix') return ['z']; // pass-rate → difficulty
  return ['z', 'aoa'];
}

function buildFeatureRow(task, row, extraLex) {
  const names = featureNamesFor(task);
  const feats = [];
  feats.push(row.z);
  if (task === 'trog') {
    const tags = new Set(tagResidual(row.item_uid, row.transcript));
    for (const t of TROG_TAG_FEATURES) feats.push(tags.has(t) ? 1 : 0);
  } else if (task === 'stories' || task === 'matrix') {
    // z only
  } else {
    const fromUid = extraLex.byUid.get(row.item_uid);
    const fromText = aoaFromWord(row.transcript);
    feats.push(fromUid ?? fromText ?? extraLex.median);
  }
  return { names, feats };
}

function main() {
  const task = (parseArg(process.argv, 'task', 'trog') || 'trog').toLowerCase();
  const lang = (parseArg(process.argv, 'lang', 'en') || 'en').toLowerCase();
  const baselineArg = parseArg(process.argv, 'baseline', null);
  const saveBaseline = parseArg(process.argv, 'save-baseline', null);
  const cfg = TASK_CFG[task];
  if (!cfg) {
    console.error(`Unknown task '${task}'. Use: ${Object.keys(TASK_CFG).join(', ')}`);
    process.exit(1);
  }

  const screenArg = parseArg(process.argv, 'screen', null);
  const screenPath = screenArg
    ? resolve(process.cwd(), screenArg)
    : join(OUT_DIR, cfg.defaultScreen(lang));

  if (!existsSync(screenPath)) {
    console.error(`Missing screen CSV: ${screenPath}`);
    console.error(`Run: node tools/vlm-panel/analyze.mjs --task ${task} --human-source=bench`);
    process.exit(1);
  }

  const screen = readCsv(screenPath);
  const hasPred = screen.some((r) => num(r.p_pred_child) != null);
  if (!hasPred) {
    console.error(
      `Screen ${screenPath} has no p_pred_child. Re-run analyze.mjs with a calibrator.`,
    );
    process.exit(1);
  }

  const bank = loadBank(task, cfg, lang);
  const bench = loadBenchParams(cfg);
  const seedInfo = seedBankAnchorsFromBench(bank, bench, cfg);
  if (cfg.seedAnchorsFromBench) {
    console.log(
      `Seeded ${seedInfo.seeded} bank anchors from bench IRT` +
        (cfg.flipBenchDifficulty ? ' (flipped easiness→harder-higher)' : ''),
    );
  }
  const passRates = loadPassRates(cfg);
  const zipfLex = task === 'vocab' ? loadZipfLexicon() : { path: null, byUid: new Map(), median: 3.5 };
  const aoaLex = task === 'vocab' ? loadAoaLexicon() : { path: null, byUid: new Map(), median: 6 };

  const featNames = featureNamesFor(task);
  const rows = [];
  for (const r of screen) {
    const item_uid = (r.item_uid || '').trim();
    if (!item_uid) continue;
    const bankUid = cfg.toBankUid(item_uid);
    const bankRow = bank.byUid.get(bankUid) || bank.byUid.get(item_uid) || null;
    const p_vlm = num(r.p_vlm);
    const p_pred_child = num(r.p_pred_child);
    const p = p_pred_child ?? p_vlm;
    const chance = bankRow?.chance ?? DEFAULT_CHANCE;
    const d_bank = bankRow?.d_bank ?? null;
    const d_bench = bench.byUid.get(bankUid) ?? bench.byUid.get(item_uid) ?? null;
    const p_human = resolveHuman(num(r.p_human), passRates.byUid, bankUid, item_uid);
    const z = p != null ? passToZ(p, chance) : null;
    const base = {
      item_uid,
      bank_uid: bankUid,
      transcript: r.transcript || '',
      flag: r.flag || '',
      p_vlm,
      p_pred_child,
      p_human,
      chance,
      d_bank,
      d_bench,
      z,
      anchor: d_bank != null && z != null,
      tags: tagResidual(item_uid, r.transcript || '').join('+'),
    };
    if (z != null) {
      const { feats } = buildFeatureRow(task, base, task === 'vocab' ? aoaLex : zipfLex);
      base.feats = feats;
    } else {
      base.feats = null;
    }
    if (task === 'vocab') {
      base.zipf = zipfLex.byUid.get(item_uid) ?? zipfLex.median;
      base.aoa = aoaLex.byUid.get(item_uid) ?? aoaFromWord(base.transcript) ?? aoaLex.median;
    }
    rows.push(base);
  }

  const anchors = rows.filter((r) => r.anchor && r.feats);
  if (anchors.length < MIN_ANCHORS) {
    console.error(
      `Too few anchors with bank d + features (${anchors.length} < ${MIN_ANCHORS}).`,
    );
    process.exit(1);
  }

  // p-only affine (ceiling reference)
  const affineFull = fitAffine(
    anchors.map((r) => r.z),
    anchors.map((r) => r.d_bank),
  );
  for (const r of rows) {
    r.d_est_p_only = predictAffine(affineFull, r.z);
  }

  const fullModel = fitHuberRidge(
    anchors.map((r) => r.feats),
    anchors.map((r) => r.d_bank),
    featNames,
  );
  if (!fullModel) {
    console.error('Multivariate fit failed (singular design).');
    process.exit(1);
  }
  for (const r of rows) {
    r.d_est = r.feats ? predictMultivar(fullModel, r.feats) : null;
  }

  const folds = makeFolds(anchors.length, anchors.length <= 60 ? anchors.length : 5);
  const d_est_cv = new Array(anchors.length).fill(null);
  const d_est_p_only_cv = new Array(anchors.length).fill(null);
  const foldMetrics = [];
  for (let f = 0; f < folds.length; f++) {
    const testIdx = new Set(folds[f]);
    const trainFeats = [];
    const trainZ = [];
    const trainD = [];
    for (let i = 0; i < anchors.length; i++) {
      if (testIdx.has(i)) continue;
      trainFeats.push(anchors[i].feats);
      trainZ.push(anchors[i].z);
      trainD.push(anchors[i].d_bank);
    }
    const model = fitHuberRidge(trainFeats, trainD, featNames);
    const aff = fitAffine(trainZ, trainD);
    const pred = [];
    const actual = [];
    const predP = [];
    for (const i of folds[f]) {
      const yhat = model ? predictMultivar(model, anchors[i].feats) : null;
      const yP = predictAffine(aff, anchors[i].z);
      d_est_cv[i] = yhat;
      d_est_p_only_cv[i] = yP;
      if (yhat != null) {
        pred.push(yhat);
        actual.push(anchors[i].d_bank);
      }
      if (yP != null) predP.push(yP);
    }
    foldMetrics.push({
      fold: f + 1,
      n_test: folds[f].length,
      n_train: anchors.length - folds[f].length,
      spearman: spearman(pred, actual),
      mae: mae(pred, actual),
      spearman_p_only: spearman(predP, actual),
      mae_p_only: mae(predP, actual),
    });
  }
  for (let i = 0; i < anchors.length; i++) {
    anchors[i].d_est_cv = d_est_cv[i];
    anchors[i].d_est_p_only_cv = d_est_p_only_cv[i];
  }
  const cvByUid = new Map(
    anchors.map((a) => [a.item_uid, { d_est_cv: a.d_est_cv, d_est_p_only_cv: a.d_est_p_only_cv }]),
  );
  for (const r of rows) {
    const cv = cvByUid.get(r.item_uid);
    r.d_est_cv = cv?.d_est_cv ?? null;
    r.d_est_p_only_cv = cv?.d_est_p_only_cv ?? null;
  }

  const cvPred = anchors.map((a) => a.d_est_cv).filter((v) => v != null);
  const cvActual = anchors.filter((a) => a.d_est_cv != null).map((a) => a.d_bank);
  const cvPOnly = anchors.filter((a) => a.d_est_p_only_cv != null).map((a) => a.d_est_p_only_cv);
  const cvActualP = anchors.filter((a) => a.d_est_p_only_cv != null).map((a) => a.d_bank);
  const meanD = mean(cvActual);
  const meanBaseline = cvActual.map(() => meanD);

  const vlmPairs = anchors.filter((a) => a.p_vlm != null);
  const negPVlm = vlmPairs.map((a) => -a.p_vlm);
  const dBankForVlm = vlmPairs.map((a) => a.d_bank);
  const predPairs = anchors.filter((a) => a.p_pred_child != null);
  const negPPred = predPairs.map((a) => -a.p_pred_child);
  const dBankForPred = predPairs.map((a) => a.d_bank);

  const spearmanMultivar = spearman(cvPred, cvActual);
  const spearmanPOnly = spearman(cvPOnly, cvActualP);
  const spearmanNegPPred = spearman(negPPred, dBankForPred);
  const maeMultivar = mae(cvPred, cvActual);
  const maePOnly = mae(cvPOnly, cvActualP);
  const maeMean = mae(meanBaseline, cvActual);

  const withHuman = anchors.filter((a) => a.d_est_cv != null && a.p_human != null);
  const negHuman = withHuman.map((a) => -a.p_human);
  const dEstHuman = withHuman.map((a) => a.d_est_cv);
  const dBankHuman = withHuman.map((a) => a.d_bank);

  const residuals = anchors
    .filter((a) => a.d_est_cv != null)
    .map((a) => ({
      item_uid: a.item_uid,
      d_bank: a.d_bank,
      d_est_cv: a.d_est_cv,
      resid: a.d_est_cv - a.d_bank,
      p_pred_child: a.p_pred_child,
      p_human: a.p_human,
      tags: a.tags,
    }))
    .sort((a, b) => Math.abs(b.resid) - Math.abs(a.resid));

  const snapshot = {
    task,
    lang,
    generated: new Date().toISOString(),
    n_anchors: anchors.length,
    spearman_multivar: spearmanMultivar,
    spearman_p_only: spearmanPOnly,
    spearman_neg_p_pred: spearmanNegPPred,
    mae_multivar: maeMultivar,
    mae_p_only: maePOnly,
    mae_mean: maeMean,
    coefficients: Object.fromEntries(fullModel.names.map((n, i) => [n, fullModel.betaRaw[i]])),
  };

  mkdirSync(OUT_DIR, { recursive: true });
  if (saveBaseline) {
    const bp = resolve(process.cwd(), saveBaseline);
    writeFileSync(bp, JSON.stringify(snapshot, null, 2) + '\n');
    console.log(`Wrote baseline snapshot ${bp}`);
  }

  let baseline = null;
  if (baselineArg) {
    const bp = resolve(process.cwd(), baselineArg);
    if (existsSync(bp)) baseline = JSON.parse(readFileSync(bp, 'utf-8'));
  }

  const csvPath = join(OUT_DIR, `d_est_${task}_${lang}.csv`);
  const reportPath = join(OUT_DIR, `d_est_${task}_${lang}_report.md`);

  const csvHeader = [
    'item_uid',
    'bank_uid',
    'p_vlm',
    'p_pred_child',
    'p_human',
    'd_bank',
    'd_bench',
    'd_est',
    'd_est_cv',
    'd_est_p_only_cv',
    'chance',
    'anchor',
    'tags',
    'zipf',
    'aoa',
    'flag',
    'transcript',
  ];
  const csvLines = [csvHeader.join(',')];
  for (const r of rows) {
    csvLines.push(
      [
        r.item_uid,
        r.bank_uid,
        r.p_vlm == null ? '' : fmt(r.p_vlm, 4),
        r.p_pred_child == null ? '' : fmt(r.p_pred_child, 4),
        r.p_human == null ? '' : fmt(r.p_human, 4),
        r.d_bank == null ? '' : fmt(r.d_bank, 6),
        r.d_bench == null ? '' : fmt(r.d_bench, 6),
        r.d_est == null ? '' : fmt(r.d_est, 6),
        r.d_est_cv == null ? '' : fmt(r.d_est_cv, 6),
        r.d_est_p_only_cv == null ? '' : fmt(r.d_est_p_only_cv, 6),
        fmt(r.chance, 4),
        r.anchor ? 'true' : 'false',
        r.tags,
        r.zipf == null ? '' : fmt(r.zipf, 3),
        r.aoa == null ? '' : fmt(r.aoa, 2),
        r.flag,
        r.transcript,
      ]
        .map(csvEscape)
        .join(','),
    );
  }
  writeFileSync(csvPath, csvLines.join('\n') + '\n');

  const foldMode = folds.length === anchors.length ? 'LOO' : `${folds.length}-fold`;
  const lines = [];
  lines.push(`# Bank-scale difficulty estimates — ${task} / ${lang}`);
  lines.push('');
  lines.push(`Generated: ${snapshot.generated}`);
  lines.push('');
  lines.push('## Inputs');
  lines.push('');
  lines.push(`- Screen: \`${screenPath}\` (${rows.length} items)`);
  lines.push(`- Bank: \`${bank.path}\` (${bank.nRows ?? bank.byUid.size} rows)`);
  lines.push(
    `- Bench item_params: ${bench.path ? `\`${bench.path}\` (${bench.byUid.size} d)` : 'not found (optional)'}`,
  );
  if (task === 'vocab') {
    lines.push(
      `- Kuperman AoA: ${aoaLex.n} lexicon hits, median fill ${fmt(aoaLex.median, 2)} (Zipf kept in CSV only).`,
    );
    lines.push(
      '- Referee: kids IRT `difficulty` (skip exact ±5 placeholders). Not old CAT `d`. Locale bank, not `sim-item-bank-vocab.csv`.',
    );
  }
  lines.push('');
  lines.push('## Model (hybrid v2)');
  lines.push('');
  lines.push(
    'Robust multivariate: standardized features → ridge (λ=0.01) + Huber IRLS. Features:',
  );
  lines.push('');
  lines.push(`- \`${featNames.join('`, `')}\``);
  lines.push('');
  lines.push('Coefficients (raw / unstandardized):');
  lines.push('');
  lines.push('| feature | coef |');
  lines.push('|---------|------|');
  for (let i = 0; i < fullModel.names.length; i++) {
    lines.push(`| ${fullModel.names[i]} | ${fmt(fullModel.betaRaw[i], 4)} |`);
  }
  lines.push('');
  lines.push(
    `Anchors: **${anchors.length}** / ${rows.length}. Held-out: **${foldMode}**.`,
  );
  lines.push('');
  lines.push(
    task === 'vocab'
      ? '## Held-out recovery of kids IRT (`difficulty`)'
      : '## Held-out recovery of bank `d`',
  );
  lines.push('');
  lines.push(
    task === 'vocab'
      ? 'Fit target is locale-bank `difficulty` (higher = harder; skip ±5). `−p_*` columns are the p-only ranking ceiling.'
      : 'Bank `d` is difficulty-coded (higher = harder). `−p_*` columns are the p-only ranking ceiling.',
  );
  lines.push('');
  lines.push('| Metric | multivar d_est_cv | p-only affine CV | mean baseline | −p_vlm | −p_pred_child |');
  lines.push('|--------|-------------------|------------------|---------------|--------|---------------|');
  lines.push(
    `| Spearman vs d_bank | **${fmt(spearmanMultivar)}** | ${fmt(spearmanPOnly)} | — | ${fmt(spearman(negPVlm, dBankForVlm))} | ${fmt(spearmanNegPPred)} |`,
  );
  lines.push(
    `| Pearson vs d_bank | ${fmt(pearson(cvPred, cvActual))} | ${fmt(pearson(cvPOnly, cvActualP))} | — | ${fmt(pearson(negPVlm, dBankForVlm))} | ${fmt(pearson(negPPred, dBankForPred))} |`,
  );
  lines.push(
    `| MAE | **${fmt(maeMultivar)}** | ${fmt(maePOnly)} | ${fmt(maeMean)} | — | — |`,
  );
  lines.push(
    `| RMSE | ${fmt(rmse(cvPred, cvActual))} | ${fmt(rmse(cvPOnly, cvActualP))} | ${fmt(rmse(meanBaseline, cvActual))} | — | — |`,
  );
  lines.push(
    `| Bias (est − bank) | ${fmt(bias(cvPred, cvActual))} | ${fmt(bias(cvPOnly, cvActualP))} | ${fmt(bias(meanBaseline, cvActual))} | — | — |`,
  );
  lines.push('');
  const beatCeiling =
    spearmanMultivar != null &&
    spearmanNegPPred != null &&
    spearmanMultivar > spearmanNegPPred + 0.02;
  lines.push(
    beatCeiling
      ? `**Multivar beats p-only ceiling** (Δ Spearman = ${fmt(spearmanMultivar - spearmanNegPPred)}).`
      : `Multivar Spearman ${fmt(spearmanMultivar)} vs p-only ceiling ${fmt(spearmanNegPPred)} (need features to clear ceiling by ≫0).`,
  );
  lines.push('');
  lines.push('### Per-fold');
  lines.push('');
  lines.push('| Fold | n_train | n_test | ρ multivar | MAE | ρ p-only |');
  lines.push('|------|---------|--------|------------|-----|----------|');
  for (const fm of foldMetrics) {
    lines.push(
      `| ${fm.fold} | ${fm.n_train} | ${fm.n_test} | ${fmt(fm.spearman)} | ${fmt(fm.mae)} | ${fmt(fm.spearman_p_only)} |`,
    );
  }
  lines.push('');

  if (baseline) {
    lines.push('## Before / after (baseline snapshot)');
    lines.push('');
    lines.push(`Baseline from ${baseline.generated || 'prior run'}:`);
    lines.push('');
    lines.push('| Metric | baseline | current | Δ |');
    lines.push('|--------|----------|---------|---|');
    const pairs = [
      ['Spearman multivar', baseline.spearman_multivar, spearmanMultivar],
      ['Spearman −p_pred (ceiling)', baseline.spearman_neg_p_pred, spearmanNegPPred],
      ['MAE multivar', baseline.mae_multivar, maeMultivar],
    ];
    for (const [name, b, c] of pairs) {
      const d = b != null && c != null ? c - b : null;
      lines.push(`| ${name} | ${fmt(b)} | ${fmt(c)} | ${fmt(d)} |`);
    }
    lines.push('');
  }

  lines.push('## Sanity vs human pass rates');
  lines.push('');
  if (withHuman.length >= 5) {
    lines.push(`n = ${withHuman.length}`);
    lines.push('');
    lines.push(
      `- Spearman(d_est_cv, −p_human): **${fmt(spearman(dEstHuman, negHuman))}**`,
    );
    lines.push(`- Spearman(d_bank, −p_human): ${fmt(spearman(dBankHuman, negHuman))}`);
  } else {
    lines.push('Insufficient p_human on anchors.');
  }
  lines.push('');
  if (bench.byUid.size) {
    const both = anchors.filter((a) => a.d_bench != null && a.d_est_cv != null);
    lines.push('## Cross-check vs bench `item_params` (report-only)');
    lines.push('');
    lines.push(
      `n = ${both.length}. Spearman(d_est_cv, d_bench)=${fmt(spearman(both.map((a) => a.d_est_cv), both.map((a) => a.d_bench)))}; Spearman(d_bank, d_bench)=${fmt(spearman(both.map((a) => a.d_bank), both.map((a) => a.d_bench)))}.`,
    );
    lines.push('');
  }
  lines.push('## Largest |residuals| (held-out)');
  lines.push('');
  lines.push('| item_uid | d_bank | d_est_cv | resid | p_pred | p_human | tags |');
  lines.push('|----------|--------|----------|-------|--------|---------|------|');
  for (const r of residuals.slice(0, 15)) {
    lines.push(
      `| ${r.item_uid} | ${fmt(r.d_bank, 3)} | ${fmt(r.d_est_cv, 3)} | ${fmt(r.resid, 3)} | ${fmt(r.p_pred_child)} | ${fmt(r.p_human)} | ${r.tags} |`,
    );
  }
  lines.push('');
  lines.push('## Outputs');
  lines.push('');
  lines.push(`- \`${csvPath}\``);
  lines.push(`- \`${reportPath}\``);
  lines.push('');
  lines.push('## How to read this');
  lines.push('');
  lines.push(
    task === 'vocab'
      ? '- **Spearman(d_est_cv, kids IRT)** vs **−p_pred_child**: AoA should help when YES|NO is flat (CEILING / blanks).'
      : '- **Spearman(d_est_cv, d_bank)** vs **−p_pred_child**: multivar should beat the p-only ceiling when construction features help.',
  );
  lines.push(
    '- Prompt changes only move the ceiling after an ungated panel recollect + re-analyze.',
  );
  if (task === 'vocab') {
    lines.push(
      '- **Do not overwrite live CAT `d`.** `d_est` is a research prior for words with no real kids IRT (`difficulty` blank or ±5).',
    );
  }

  writeFileSync(reportPath, lines.join('\n') + '\n');
  // Always refresh the latest metrics json next to the report
  writeFileSync(
    join(OUT_DIR, `d_est_${task}_${lang}_metrics.json`),
    JSON.stringify(snapshot, null, 2) + '\n',
  );

  console.log(`Wrote ${csvPath}`);
  console.log(`Wrote ${reportPath}`);
  console.log(
    `Anchors ${anchors.length} · ${foldMode} ρ_multivar=${fmt(spearmanMultivar)} ρ_p_only=${fmt(spearmanPOnly)} ceiling(−p_pred)=${fmt(spearmanNegPPred)} MAE=${fmt(maeMultivar)}`,
  );
}

main();
