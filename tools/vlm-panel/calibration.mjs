/**
 * Monotonic calibrator: map ungated VLM item pass-rates (p_vlm) to predicted
 * average child pass-rates (p_pred_child).
 *
 * Prefer isotonic regression (PAV) when enough matched human items exist;
 * fall back to a 1-parameter logistic (Platt-style) link for small n.
 * Predictions are clipped to [chance, 1].
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CALIBRATION_DIR = join(HERE, 'calibration');

/** Minimum matched items for isotonic; below this use logistic (if >= LOGISTIC_MIN). */
export const ISOTONIC_MIN = 20;
/** Below this, refuse to fit — caller should reuse another language's calibrator. */
export const LOGISTIC_MIN = 5;

const AGE_ACCURACY_PATH = join(
  HERE,
  '..',
  '..',
  'cypress',
  'support',
  'persona',
  'age_task_accuracy.json',
);

/** analyze.mjs task name → age_task_accuracy.json key */
export const TASK_TO_ACCURACY_ID = {
  trog: 'trog',
  vocab: 'vocab',
  stories: 'theory-of-mind',
};

/** Ages emitted as approximate p_pred_age_* columns. */
export const PRED_AGES = [6, 8, 10];

function clip(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

function mae(xs, ys) {
  if (!xs.length) return null;
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += Math.abs(xs[i] - ys[i]);
  return s / xs.length;
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

/**
 * Pool-adjacent-violators isotonic regression (non-decreasing).
 * Returns y-hat of same length as input (already sorted by x ascending).
 */
export function isotonicPav(ySorted) {
  const n = ySorted.length;
  const out = ySorted.slice();
  const w = new Array(n).fill(1);
  let i = 0;
  while (i < n - 1) {
    if (out[i] <= out[i + 1] + 1e-15) {
      i++;
      continue;
    }
    // Merge block ending at i with next value(s) until monotonic.
    let j = i + 1;
    let sum = out[i] * w[i] + out[j] * w[j];
    let wt = w[i] + w[j];
    let avg = sum / wt;
    while (j + 1 < n && avg > out[j + 1]) {
      j++;
      sum += out[j] * w[j];
      wt += w[j];
      avg = sum / wt;
    }
    for (let k = i; k <= j; k++) {
      out[k] = avg;
      w[k] = wt / (j - i + 1);
    }
    // Step back in case earlier blocks now violate.
    i = Math.max(0, i - 1);
  }
  return out;
}

/**
 * Fit isotonic mapping from p_vlm → p_human.
 * Stores unique x knots with averaged fitted y for piecewise-constant lookup
 * (steps between midpoints of consecutive unique x).
 */
export function fitIsotonic(pairs) {
  const sorted = pairs
    .map((p) => ({ x: p.p_vlm, y: p.p_human }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .sort((a, b) => a.x - b.x || a.y - b.y);
  if (sorted.length < ISOTONIC_MIN) {
    throw new Error(`isotonic needs >= ${ISOTONIC_MIN} pairs, got ${sorted.length}`);
  }
  const yHat = isotonicPav(sorted.map((p) => p.y));
  // Collapse duplicate x to mean fitted y.
  const knots = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    let sum = 0;
    while (j < sorted.length && sorted[j].x === sorted[i].x) {
      sum += yHat[j];
      j++;
    }
    knots.push({ x: sorted[i].x, y: sum / (j - i) });
    i = j;
  }
  return { method: 'isotonic', knots, n: sorted.length };
}

/** Predict with isotonic mapping; linear interpolate between consecutive knots. */
export function predictIsotonic(model, pVlm) {
  const { knots } = model;
  if (!knots.length) return NaN;
  if (pVlm <= knots[0].x) return knots[0].y;
  if (pVlm >= knots[knots.length - 1].x) return knots[knots.length - 1].y;
  for (let i = 0; i < knots.length - 1; i++) {
    const a = knots[i];
    const b = knots[i + 1];
    if (pVlm >= a.x && pVlm <= b.x) {
      if (b.x === a.x) return (a.y + b.y) / 2;
      const t = (pVlm - a.x) / (b.x - a.x);
      return a.y + t * (b.y - a.y);
    }
  }
  return knots[knots.length - 1].y;
}

function sigmoid(z) {
  if (z >= 30) return 1;
  if (z <= -30) return 0;
  return 1 / (1 + Math.exp(-z));
}

function logit(p) {
  const x = clip(p, 1e-6, 1 - 1e-6);
  return Math.log(x / (1 - x));
}

/**
 * Platt-style: p_pred = sigmoid(a + b * logit(p_vlm)).
 * Fit a,b by coordinate descent on squared error in probability space.
 */
export function fitLogistic(pairs) {
  const pts = pairs.filter((p) => Number.isFinite(p.p_vlm) && Number.isFinite(p.p_human));
  if (pts.length < LOGISTIC_MIN) {
    throw new Error(`logistic needs >= ${LOGISTIC_MIN} pairs, got ${pts.length}`);
  }
  const xs = pts.map((p) => logit(clip(p.p_vlm, 1e-4, 1 - 1e-4)));
  const ys = pts.map((p) => p.p_human);
  let a = 0;
  let b = 1;
  for (let iter = 0; iter < 80; iter++) {
    // Fix b, solve a (1D Newton on SSE).
    for (let k = 0; k < 5; k++) {
      let g = 0;
      let h = 0;
      for (let i = 0; i < xs.length; i++) {
        const p = sigmoid(a + b * xs[i]);
        const e = p - ys[i];
        g += e * p * (1 - p);
        h += p * (1 - p) * (1 - 2 * p) * e + (p * (1 - p)) ** 2;
      }
      if (Math.abs(h) < 1e-12) break;
      a -= g / h;
    }
    // Fix a, solve b.
    for (let k = 0; k < 5; k++) {
      let g = 0;
      let h = 0;
      for (let i = 0; i < xs.length; i++) {
        const z = a + b * xs[i];
        const p = sigmoid(z);
        const e = p - ys[i];
        const dpdb = p * (1 - p) * xs[i];
        g += e * dpdb;
        h += dpdb * dpdb + e * p * (1 - p) * (1 - 2 * p) * xs[i] * xs[i];
      }
      if (Math.abs(h) < 1e-12) break;
      b -= g / h;
    }
  }
  return { method: 'logistic', a, b, n: pts.length };
}

export function predictLogistic(model, pVlm) {
  return sigmoid(model.a + model.b * logit(clip(pVlm, 1e-4, 1 - 1e-4)));
}

/** Fit best available method for the matched pairs. */
export function fitCalibrator(pairs) {
  const clean = pairs.filter(
    (p) => Number.isFinite(p.p_vlm) && Number.isFinite(p.p_human) && p.p_human >= 0 && p.p_human <= 1,
  );
  if (clean.length >= ISOTONIC_MIN) return fitIsotonic(clean);
  if (clean.length >= LOGISTIC_MIN) return fitLogistic(clean);
  return null;
}

export function predictRaw(model, pVlm) {
  if (!model) return pVlm;
  if (model.method === 'isotonic') return predictIsotonic(model, pVlm);
  if (model.method === 'logistic') return predictLogistic(model, pVlm);
  return pVlm;
}

export function predictChild(model, pVlm, chance = 0) {
  if (!Number.isFinite(pVlm)) return null;
  const raw = predictRaw(model, pVlm);
  if (!Number.isFinite(raw)) return null;
  return clip(raw, chance, 1);
}

/** In-sample MAE / Spearman for a fitted model vs raw p_vlm. */
export function inSampleMetrics(pairs, model, chance = 0) {
  const clean = pairs.filter(
    (p) => Number.isFinite(p.p_vlm) && Number.isFinite(p.p_human),
  );
  if (clean.length < LOGISTIC_MIN) {
    return {
      n: clean.length,
      maeCal: null,
      maeRaw: null,
      spearmanCal: null,
      spearmanRaw: null,
    };
  }
  const pred = clean.map((p) => predictChild(model, p.p_vlm, chance));
  const raw = clean.map((p) => p.p_vlm);
  const actual = clean.map((p) => p.p_human);
  return {
    n: clean.length,
    maeCal: mae(pred, actual),
    maeRaw: mae(raw, actual),
    spearmanCal: spearman(pred, actual),
    spearmanRaw: spearman(raw, actual),
  };
}

/**
 * Leave-one-out (n <= 60) or 5-fold CV metrics for calibrated vs raw predictions.
 */
export function crossValidate(pairs, chance = 0) {
  const clean = pairs.filter(
    (p) => Number.isFinite(p.p_vlm) && Number.isFinite(p.p_human),
  );
  const n = clean.length;
  if (n < LOGISTIC_MIN) {
    return {
      n,
      folds: 0,
      maeCal: null,
      maeRaw: null,
      biasCal: null,
      spearmanCal: null,
      spearmanRaw: null,
    };
  }

  const predCal = new Array(n).fill(NaN);
  const predRaw = clean.map((p) => p.p_vlm);
  const actual = clean.map((p) => p.p_human);

  const useLoo = n <= 60;
  const folds = useLoo ? n : 5;
  const foldOf = (i) => (useLoo ? i : i % folds);

  for (let f = 0; f < folds; f++) {
    const train = [];
    const testIdx = [];
    for (let i = 0; i < n; i++) {
      if (foldOf(i) === f) testIdx.push(i);
      else train.push(clean[i]);
    }
    if (train.length < LOGISTIC_MIN) continue;
    const model = fitCalibrator(train);
    if (!model) continue;
    for (const i of testIdx) {
      predCal[i] = predictChild(model, clean[i].p_vlm, chance);
    }
  }

  const ok = [];
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(predCal[i])) ok.push(i);
  }
  const pc = ok.map((i) => predCal[i]);
  const pr = ok.map((i) => predRaw[i]);
  const ac = ok.map((i) => actual[i]);

  return {
    n: ok.length,
    folds: useLoo ? 'loo' : 5,
    maeCal: mae(pc, ac),
    maeRaw: mae(pr, ac),
    biasCal: bias(pc, ac),
    spearmanCal: spearman(pc, ac),
    spearmanRaw: spearman(pr, ac),
  };
}

export function calibratorPath(task, language) {
  return join(CALIBRATION_DIR, `${task}_${language}.json`);
}

export function saveCalibrator(task, language, model, meta = {}) {
  mkdirSync(CALIBRATION_DIR, { recursive: true });
  const path = calibratorPath(task, language);
  const payload = {
    task,
    language,
    fittedAt: new Date().toISOString(),
    ...meta,
    model,
  };
  writeFileSync(path, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  return path;
}

export function loadCalibrator(task, language) {
  const path = calibratorPath(task, language);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    return raw?.model ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Resolve calibrator for a language: fit on matched pairs if possible;
 * else reuse sourceLang (default en) saved calibrator; else null (identity).
 */
export function resolveCalibrator({
  task,
  language,
  pairs,
  sourceLang = 'en',
  chance = 0,
  cvChance = 0,
}) {
  const fitted = fitCalibrator(pairs);
  let model = fitted;
  let source = fitted ? language : null;
  let path = null;
  let cv = crossValidate(pairs, cvChance ?? chance);

  if (fitted) {
    path = saveCalibrator(task, language, fitted, {
      chance,
      nMatched: pairs.length,
      cv,
    });
  } else if (language !== sourceLang) {
    const fallback = loadCalibrator(task, sourceLang);
    if (fallback?.model) {
      model = fallback.model;
      source = sourceLang;
      path = calibratorPath(task, sourceLang);
    }
  }

  return { model, source, path, cv, fitted: !!fitted };
}

let _ageAccuracy = null;
export function loadAgeAccuracy() {
  if (_ageAccuracy) return _ageAccuracy;
  if (!existsSync(AGE_ACCURACY_PATH)) {
    _ageAccuracy = {};
    return _ageAccuracy;
  }
  _ageAccuracy = JSON.parse(readFileSync(AGE_ACCURACY_PATH, 'utf-8'));
  return _ageAccuracy;
}

/**
 * Approximate age-adjusted predictions from pooled p_pred_child using
 * task-level age norms. Returns { '6': p, '8': p, '10': p } or {}.
 *
 * When `ageItemRates` (from levante-bench trials) contains this item_uid,
 * prefer the empirical age×item pass-rate for ages that have enough n.
 */
export function ageAdjustedPredictions(taskName, pPredChild, chance = 0, opts = {}) {
  const { itemUid = null, ageItemRates = null } = opts;
  const out = {};

  if (itemUid && ageItemRates?.items?.[itemUid]) {
    const rates = ageItemRates.items[itemUid];
    for (const age of PRED_AGES) {
      const emp = rates[String(age)];
      if (Number.isFinite(emp)) out[String(age)] = clip(emp, chance, 1);
    }
    if (Object.keys(out).length) return out;
  }

  const accId = TASK_TO_ACCURACY_ID[taskName];
  if (!accId || !Number.isFinite(pPredChild)) return {};
  const table = loadAgeAccuracy()[accId];
  if (!table || typeof table !== 'object') return {};
  const vals = Object.values(table).filter((v) => Number.isFinite(v));
  const pool = mean(vals);
  if (!Number.isFinite(pool) || pool <= 0) return {};
  for (const age of PRED_AGES) {
    const acc = table[String(age)] ?? table[age];
    if (!Number.isFinite(acc)) continue;
    out[String(age)] = clip(pPredChild * (acc / pool), chance, 1);
  }
  return out;
}

/** Markdown bullets for a CV + calibrator block. */
export function formatCalibrationReport({ language, source, path, cv, fitted, nMatched, inSample }) {
  const lines = [];
  lines.push('### Child performance prediction (calibrated p_vlm → p_pred_child)');
  if (!fitted && !source) {
    lines.push(
      `- No calibrator (matched human items: **${nMatched}**; need ≥ ${LOGISTIC_MIN}). ` +
        `\`p_pred_child\` = clipped \`p_vlm\` (identity).`,
    );
    lines.push('');
    return lines.join('\n');
  }
  const srcNote = fitted
    ? `fitted on ${language} matched items (n=${nMatched})`
    : `reused ${source} calibrator (too few ${language} matches: n=${nMatched})`;
  const relPath = path ? path.split(/[/\\]/).slice(-3).join('/') : null;
  lines.push(`- Calibrator: ${srcNote}${relPath ? `; saved \`${relPath}\`` : ''}`);
  if (inSample && inSample.n >= LOGISTIC_MIN) {
    lines.push(
      `- In-sample (n=${inSample.n}): MAE calibrated **${fmt(inSample.maeCal)}** vs raw **${fmt(inSample.maeRaw)}**; ` +
        `Spearman calibrated **${fmt(inSample.spearmanCal)}** vs raw **${fmt(inSample.spearmanRaw)}**`,
    );
  }
  if (cv && cv.n >= LOGISTIC_MIN) {
    lines.push(
      `- Held-out CV (${cv.folds}, n=${cv.n}): MAE calibrated **${fmt(cv.maeCal)}** vs raw **${fmt(cv.maeRaw)}**` +
        (cv.biasCal != null ? `; bias ${fmt(cv.biasCal)}` : ''),
    );
    lines.push(
      `- Held-out CV Spearman: calibrated **${fmt(cv.spearmanCal)}** vs raw **${fmt(cv.spearmanRaw)}**`,
    );
  }
  lines.push(
    `- Age columns \`p_pred_age_*\`: empirical age×item rates from levante-bench trials when available; otherwise task-norm scaling of \`p_pred_child\` (approximate).`,
  );
  lines.push('');
  return lines.join('\n');
}

function fmt(x, d = 3) {
  if (x == null || Number.isNaN(x)) return '';
  return Number(x).toFixed(d);
}
