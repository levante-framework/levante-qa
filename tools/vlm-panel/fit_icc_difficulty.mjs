#!/usr/bin/env node
/**
 * Fit per-item Rasch-with-guessing difficulties (d_icc) from ungated panel
 * answers stratified by persona age → θ, then affine-link onto bank-scale d.
 *
 * P(correct|θ) = c + (1−c)·sigmoid(θ − d_icc)
 *
 * Usage:
 *   node tools/vlm-panel/fit_icc_difficulty.mjs --task trog --lang en
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const OUT_DIR = join(HERE, 'out');
const RUNS_DIR = join(REPO, 'cypress', 'logs', 'runs');
const CACHE_DIR = join(REPO, 'cypress', 'cache');
const ABILITY_PATH = join(REPO, 'cypress', 'support', 'persona', 'age_task_ability.json');
const DEFAULT_CHANCE = 0.25;
const EPS = 1e-6;
const MIN_TRIALS = 10;
const MIN_ANCHORS = 20;
const D_LO = -8;
const D_HI = 8;

const TASK_CFG = {
  trog: {
    scoredType: 'item',
    bankFile: 'sim-item-bank-trog.csv',
    abilityKey: 'trog',
    defaultScreen: (lang) => `screen_${lang}.csv`,
    metricsPrior: (lang) => `d_est_trog_${lang}_metrics.json`,
    toBankUid: (uid) => uid,
  },
  vocab: {
    scoredType: 'word',
    bankFile: 'sim-item-bank-vocab.csv',
    abilityKey: 'vocab',
    defaultScreen: (lang) => `screen_vocab_${lang}.csv`,
    metricsPrior: (lang) => `d_est_vocab_${lang}_metrics.json`,
    toBankUid: (uid) => {
      const m = /^vocab_word_(.+)$/.exec(uid);
      return m ? `vocab__${m[1]}` : uid;
    },
  },
};

function parseArg(argv, name, fallback = null) {
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === `--${name}`) return argv[i + 1] ?? fallback;
    if (argv[i].startsWith(`--${name}=`)) return argv[i].slice(name.length + 3);
  }
  return fallback;
}

function splitCsv(line) {
  const parts = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += c;
      continue;
    }
    if (c === '"') {
      q = true;
      continue;
    }
    if (c === ',') {
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

function normText(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
  let numv = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    numv += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den > 0 ? numv / den : null;
}

function spearman(xs, ys) {
  if (xs.length < 2) return null;
  return pearson(ranks(xs), ranks(ys));
}

function fmt(x, d = 3) {
  if (x == null || Number.isNaN(x)) return '—';
  return Number(x).toFixed(d);
}

function sigmoid(x) {
  if (x >= 30) return 1;
  if (x <= -30) return 0;
  return 1 / (1 + Math.exp(-x));
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

function parseAgeFromRunId(runId) {
  const m = /_a(\d+)_/.exec(runId);
  return m ? Number(m[1]) : null;
}

function loadAbility(taskKey) {
  if (!existsSync(ABILITY_PATH)) {
    throw new Error(`Missing ability profile: ${ABILITY_PATH}`);
  }
  const raw = JSON.parse(readFileSync(ABILITY_PATH, 'utf-8'));
  const task = raw[taskKey];
  if (!task) throw new Error(`No ability rows for task '${taskKey}' in ${ABILITY_PATH}`);
  const byAge = new Map();
  for (const [age, v] of Object.entries(task)) {
    const th = num(v?.theta);
    if (th != null) byAge.set(Number(age), th);
  }
  return { path: ABILITY_PATH, byAge };
}

function loadBank(cfg) {
  const path = join(CACHE_DIR, cfg.bankFile);
  if (!existsSync(path)) throw new Error(`Missing item bank cache: ${path}`);
  const byUid = new Map();
  for (const r of readCsv(path)) {
    const uid = (r.item_uid || '').trim();
    if (!uid) continue;
    const d = parseBankD(r.d) ?? parseBankD(r.difficulty);
    const chance = num(r.chance_level);
    byUid.set(uid, {
      d_bank: d,
      chance: chance != null ? chance : DEFAULT_CHANCE,
    });
  }
  return { path, byUid };
}

function pickVlmLog(runDir) {
  const files = readdirSync(runDir).filter((f) => /^vlm_.*\.jsonl?$/.test(f));
  if (!files.length) return null;
  let best = null;
  let bestSize = -1;
  for (const f of files) {
    const size = statSync(join(runDir, f)).size;
    if (size > bestSize) {
      bestSize = size;
      best = f;
    }
  }
  return best;
}

function identity(rec, scoredType) {
  if (scoredType === 'word') return rec.audioTranscript || rec.targetWord;
  return rec.audioTranscript;
}

function hasResponse(rec) {
  return rec.chosenIndex !== null && rec.chosenIndex !== undefined;
}

/**
 * Golden-section maximize nll → minimize negative log-likelihood for d.
 * Returns { d, nll, reliable, reason }.
 */
function fitDIcc(trials, c) {
  const n = trials.length;
  if (n < MIN_TRIALS) {
    return { d: null, nll: null, reliable: false, reason: `n_trials<${MIN_TRIALS}` };
  }
  let n1 = 0;
  for (const t of trials) n1 += t.y;
  if (n1 === 0) {
    return { d: D_HI, nll: null, reliable: false, reason: 'all_incorrect' };
  }
  if (n1 === n) {
    return { d: D_LO, nll: null, reliable: false, reason: 'all_correct' };
  }

  const nll = (d) => {
    let s = 0;
    for (const t of trials) {
      const p = c + (1 - c) * sigmoid(t.theta - d);
      const pp = Math.min(1 - EPS, Math.max(EPS, p));
      s -= t.y === 1 ? Math.log(pp) : Math.log(1 - pp);
    }
    return s;
  };

  // Coarse grid then golden section on best bracket
  let bestD = 0;
  let bestNll = Infinity;
  const grid = [];
  for (let d = D_LO; d <= D_HI + 1e-9; d += 0.25) grid.push(d);
  for (const d of grid) {
    const v = nll(d);
    if (v < bestNll) {
      bestNll = v;
      bestD = d;
    }
  }
  let lo = Math.max(D_LO, bestD - 0.5);
  let hi = Math.min(D_HI, bestD + 0.5);
  const phi = (1 + Math.sqrt(5)) / 2;
  let x1 = hi - (hi - lo) / phi;
  let x2 = lo + (hi - lo) / phi;
  let f1 = nll(x1);
  let f2 = nll(x2);
  for (let iter = 0; iter < 60 && hi - lo > 1e-4; iter++) {
    if (f1 < f2) {
      hi = x2;
      x2 = x1;
      f2 = f1;
      x1 = hi - (hi - lo) / phi;
      f1 = nll(x1);
    } else {
      lo = x1;
      x1 = x2;
      f1 = f2;
      x2 = lo + (hi - lo) / phi;
      f2 = nll(x2);
    }
  }
  const dStar = (lo + hi) / 2;
  const nllStar = nll(dStar);
  const atBound = dStar <= D_LO + 0.05 || dStar >= D_HI - 0.05;
  return {
    d: dStar,
    nll: nllStar,
    reliable: !atBound,
    reason: atBound ? 'boundary' : 'ok',
  };
}

function pByAge(trials) {
  const by = new Map();
  for (const t of trials) {
    if (!by.has(t.age)) by.set(t.age, { n: 0, c: 0 });
    const cell = by.get(t.age);
    cell.n++;
    cell.c += t.y;
  }
  const out = {};
  for (const [age, cell] of [...by.entries()].sort((a, b) => a[0] - b[0])) {
    out[String(age)] = cell.n ? cell.c / cell.n : null;
  }
  return out;
}

function main() {
  const task = (parseArg(process.argv, 'task', 'trog') || 'trog').toLowerCase();
  const lang = (parseArg(process.argv, 'lang', 'en') || 'en').toLowerCase();
  const cfg = TASK_CFG[task];
  if (!cfg) {
    console.error(`Unknown task '${task}'. Use: ${Object.keys(TASK_CFG).join(', ')}`);
    process.exit(1);
  }

  const ability = loadAbility(cfg.abilityKey);
  const bank = loadBank(cfg);
  const screenPath = join(OUT_DIR, cfg.defaultScreen(lang));
  if (!existsSync(screenPath)) {
    console.error(`Missing screen CSV: ${screenPath}`);
    process.exit(1);
  }
  const screen = readCsv(screenPath);
  const screenByUid = new Map();
  const keyToUid = new Map();
  for (const r of screen) {
    const uid = (r.item_uid || '').trim();
    if (!uid) continue;
    screenByUid.set(uid, r);
    const k = normText(r.transcript);
    if (k && !keyToUid.has(k)) keyToUid.set(k, uid);
  }

  const manifestPath = join(OUT_DIR, 'manifest.json');
  if (!existsSync(manifestPath)) {
    console.error(`Missing manifest: ${manifestPath}`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const runs = manifest.filter(
    (r) =>
      r.status === 'done' &&
      (r.task === task || String(r.runId || '').startsWith(`panel_${task}_`)) &&
      (r.language === lang || String(r.runId || '').includes(`_${task}_${lang}_`)),
  );

  /** item_uid -> [{theta,y,age,runId}] */
  const trialsByUid = new Map();
  let usedRuns = 0;
  let skippedNoTheta = 0;
  let skippedNoLog = 0;
  const thetaGrid = new Map();

  for (const entry of runs) {
    const runId = entry.runId;
    const age = num(entry.age) ?? parseAgeFromRunId(runId);
    if (age == null) continue;
    const theta = ability.byAge.get(age);
    if (theta == null) {
      skippedNoTheta++;
      continue;
    }
    thetaGrid.set(age, theta);
    const dir = join(RUNS_DIR, runId);
    if (!existsSync(dir)) {
      skippedNoLog++;
      continue;
    }
    const logName = pickVlmLog(dir);
    if (!logName) {
      skippedNoLog++;
      continue;
    }
    const seen = new Map(); // key -> 0/1
    for (const line of readFileSync(join(dir, logName), 'utf-8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.itemType !== cfg.scoredType || typeof rec.correct !== 'boolean') continue;
      if (!hasResponse(rec)) continue;
      const key = normText(identity(rec, cfg.scoredType));
      if (!key || seen.has(key)) continue;
      seen.set(key, rec.correct ? 1 : 0);
    }
    if (!seen.size) {
      skippedNoLog++;
      continue;
    }
    usedRuns++;
    for (const [key, y] of seen) {
      const uid = keyToUid.get(key);
      if (!uid) continue;
      if (!trialsByUid.has(uid)) trialsByUid.set(uid, []);
      trialsByUid.get(uid).push({ theta, y, age, runId });
    }
  }

  const rows = [];
  for (const [item_uid, trials] of trialsByUid) {
    const bankUid = cfg.toBankUid(item_uid);
    const bankRow = bank.byUid.get(bankUid) || bank.byUid.get(item_uid) || null;
    const chance = bankRow?.chance ?? DEFAULT_CHANCE;
    const d_bank = bankRow?.d_bank ?? null;
    const screenRow = screenByUid.get(item_uid);
    const fit = fitDIcc(trials, chance);
    const agePs = pByAge(trials);
    rows.push({
      item_uid,
      bank_uid: bankUid,
      transcript: screenRow?.transcript || '',
      n_trials: trials.length,
      n_correct: trials.reduce((s, t) => s + t.y, 0),
      chance,
      d_icc: fit.d,
      d_icc_reliable: fit.reliable,
      fit_reason: fit.reason,
      nll: fit.nll,
      d_bank,
      p_vlm: num(screenRow?.p_vlm),
      p_pred_child: num(screenRow?.p_pred_child),
      p_by_age: agePs,
      anchor: d_bank != null && fit.d != null && fit.reliable,
    });
  }
  rows.sort((a, b) => a.item_uid.localeCompare(b.item_uid));

  const anchors = rows.filter((r) => r.anchor);
  if (anchors.length < MIN_ANCHORS) {
    console.error(
      `Too few reliable anchors with bank d + d_icc (${anchors.length} < ${MIN_ANCHORS}).`,
    );
    process.exit(1);
  }

  // Full-sample affine (for non-CV column)
  const affFull = fitAffine(
    anchors.map((a) => a.d_icc),
    anchors.map((a) => a.d_bank),
  );
  for (const r of rows) {
    r.d_icc_linked = predictAffine(affFull, r.d_icc);
  }

  // Held-out CV affine link
  const folds = makeFolds(anchors.length, anchors.length <= 60 ? anchors.length : 5);
  const d_icc_cv = new Array(anchors.length).fill(null);
  const foldMetrics = [];
  for (let f = 0; f < folds.length; f++) {
    const testIdx = new Set(folds[f]);
    const trainX = [];
    const trainY = [];
    for (let i = 0; i < anchors.length; i++) {
      if (testIdx.has(i)) continue;
      trainX.push(anchors[i].d_icc);
      trainY.push(anchors[i].d_bank);
    }
    const aff = fitAffine(trainX, trainY);
    const pred = [];
    const actual = [];
    for (const i of folds[f]) {
      const yhat = predictAffine(aff, anchors[i].d_icc);
      d_icc_cv[i] = yhat;
      if (yhat != null) {
        pred.push(yhat);
        actual.push(anchors[i].d_bank);
      }
    }
    foldMetrics.push({
      fold: f + 1,
      n_train: anchors.length - folds[f].length,
      n_test: folds[f].length,
      spearman: spearman(pred, actual),
      mae: mae(pred, actual),
    });
  }
  for (let i = 0; i < anchors.length; i++) {
    anchors[i].d_icc_cv = d_icc_cv[i];
  }
  const cvByUid = new Map(anchors.map((a) => [a.item_uid, a.d_icc_cv]));
  for (const r of rows) {
    r.d_icc_cv = cvByUid.get(r.item_uid) ?? null;
  }

  const cvPred = anchors.map((a) => a.d_icc_cv).filter((x) => x != null);
  const cvActual = anchors.filter((a) => a.d_icc_cv != null).map((a) => a.d_bank);
  const spearmanIcc = spearman(cvPred, cvActual);
  const pearsonIcc = pearson(cvPred, cvActual);
  const maeIcc = mae(cvPred, cvActual);

  const negPVlm = anchors.filter((a) => a.p_vlm != null);
  const spearmanNegPVlm = spearman(
    negPVlm.map((a) => -a.p_vlm),
    negPVlm.map((a) => a.d_bank),
  );
  const negPPred = anchors.filter((a) => a.p_pred_child != null);
  const spearmanNegPPred = spearman(
    negPPred.map((a) => -a.p_pred_child),
    negPPred.map((a) => a.d_bank),
  );
  const spearmanRawIcc = spearman(
    anchors.map((a) => a.d_icc),
    anchors.map((a) => a.d_bank),
  );

  let prior = null;
  const priorPath = join(OUT_DIR, cfg.metricsPrior(lang));
  if (existsSync(priorPath)) {
    try {
      prior = JSON.parse(readFileSync(priorPath, 'utf-8'));
    } catch {
      prior = null;
    }
  }

  const tag = `${task}_${lang}`;
  const csvPath = join(OUT_DIR, `d_icc_${tag}.csv`);
  const reportPath = join(OUT_DIR, `d_icc_${tag}_report.md`);
  const metricsPath = join(OUT_DIR, `d_icc_${tag}_metrics.json`);

  const agesUsed = [...thetaGrid.entries()].sort((a, b) => a[0] - b[0]);
  const header = [
    'item_uid',
    'bank_uid',
    'n_trials',
    'n_correct',
    'chance',
    'd_icc',
    'd_icc_reliable',
    'fit_reason',
    'd_icc_linked',
    'd_icc_cv',
    'd_bank',
    'p_vlm',
    'p_pred_child',
    'p_by_age',
    'transcript',
  ];
  const csvLines = [header.join(',')];
  for (const r of rows) {
    csvLines.push(
      [
        r.item_uid,
        r.bank_uid,
        r.n_trials,
        r.n_correct,
        fmt(r.chance, 3),
        fmt(r.d_icc, 4),
        r.d_icc_reliable ? '1' : '0',
        r.fit_reason,
        fmt(r.d_icc_linked, 4),
        fmt(r.d_icc_cv, 4),
        fmt(r.d_bank, 4),
        fmt(r.p_vlm, 4),
        fmt(r.p_pred_child, 4),
        csvEscape(JSON.stringify(r.p_by_age)),
        csvEscape(r.transcript),
      ].join(','),
    );
  }
  writeFileSync(csvPath, csvLines.join('\n') + '\n');

  const metrics = {
    task,
    lang,
    generated: new Date().toISOString(),
    n_runs_used: usedRuns,
    n_runs_skipped_no_theta: skippedNoTheta,
    n_runs_skipped_no_log: skippedNoLog,
    n_items: rows.length,
    n_anchors: anchors.length,
    n_unreliable: rows.filter((r) => r.d_icc != null && !r.d_icc_reliable).length,
    theta_grid: Object.fromEntries(agesUsed.map(([a, th]) => [String(a), th])),
    link_full: affFull,
    spearman_d_icc_cv: spearmanIcc,
    pearson_d_icc_cv: pearsonIcc,
    mae_d_icc_cv: maeIcc,
    spearman_d_icc_raw: spearmanRawIcc,
    spearman_neg_p_vlm: spearmanNegPVlm,
    spearman_neg_p_pred: spearmanNegPPred,
    prior_d_est: prior
      ? {
          spearman_multivar: prior.spearman_multivar ?? null,
          spearman_neg_p_pred: prior.spearman_neg_p_pred ?? null,
          mae_multivar: prior.mae_multivar ?? null,
        }
      : null,
    fold_metrics: foldMetrics,
  };
  writeFileSync(metricsPath, JSON.stringify(metrics, null, 2) + '\n');

  const beatsCeiling =
    spearmanIcc != null && spearmanNegPPred != null && spearmanIcc > spearmanNegPPred;
  const md = [];
  md.push(`# ICC difficulty from panel θ grid — ${task} / ${lang}`);
  md.push('');
  md.push(`Generated: ${metrics.generated}`);
  md.push('');
  md.push('## Model');
  md.push('');
  md.push('Fixed-guessing Rasch ICC on ungated panel trials:');
  md.push('');
  md.push('$$P(\\mathrm{correct}\\mid\\theta) = c + (1-c)\\,\\sigma(\\theta - d_{\\mathrm{icc}})$$');
  md.push('');
  md.push(`- θ = mean child ability for the run’s persona age ([age_task_ability.json](${ABILITY_PATH}))`);
  md.push(`- c = bank \`chance_level\` (default ${DEFAULT_CHANCE})`);
  md.push('- Bank link: held-out CV affine `d_icc_cv = α + β · d_icc`');
  md.push('');
  md.push('## θ grid used');
  md.push('');
  md.push('| age | θ |');
  md.push('|-----|---|');
  for (const [age, th] of agesUsed) md.push(`| ${age} | ${fmt(th, 4)} |`);
  md.push('');
  md.push(
    `Runs used: **${usedRuns}** (skipped no-θ: ${skippedNoTheta}, no-log: ${skippedNoLog}). Items: **${rows.length}**. Reliable anchors: **${anchors.length}**. Unreliable fits: **${metrics.n_unreliable}**.`,
  );
  md.push('');
  md.push('## Held-out recovery of bank `d`');
  md.push('');
  md.push('| Metric | d_icc CV (linked) | −p_vlm | −p_pred_child | multivar d_est (prior) |');
  md.push('|--------|-------------------|--------|---------------|------------------------|');
  md.push(
    `| Spearman vs d_bank | **${fmt(spearmanIcc)}** | ${fmt(spearmanNegPVlm)} | ${fmt(spearmanNegPPred)} | ${fmt(prior?.spearman_multivar)} |`,
  );
  md.push(
    `| MAE | **${fmt(maeIcc)}** | — | — | ${fmt(prior?.mae_multivar)} |`,
  );
  md.push(`| Pearson | ${fmt(pearsonIcc)} | — | — | — |`);
  md.push(`| Spearman(d_icc raw, d_bank) | ${fmt(spearmanRawIcc)} | — | — | — |`);
  md.push('');
  if (beatsCeiling) {
    md.push(
      `**Linked ICC beats −p_pred ceiling** (Δ Spearman = ${fmt(spearmanIcc - spearmanNegPPred)}).`,
    );
  } else {
    md.push(
      `Linked ICC does **not** beat −p_pred ceiling (Δ Spearman = ${fmt(
        spearmanIcc != null && spearmanNegPPred != null ? spearmanIcc - spearmanNegPPred : null,
      )}). Flat or weakly ordered VLM×age curves limit identification.`,
    );
  }
  md.push('');
  md.push('## Fold metrics');
  md.push('');
  md.push('| Fold | n_train | n_test | ρ | MAE |');
  md.push('|------|---------|--------|---|-----|');
  for (const f of foldMetrics) {
    md.push(
      `| ${f.fold} | ${f.n_train} | ${f.n_test} | ${fmt(f.spearman)} | ${fmt(f.mae)} |`,
    );
  }
  md.push('');
  md.push('## Link coefficients (full-sample)');
  md.push('');
  md.push(
    affFull
      ? `\`d_linked = ${fmt(affFull.a, 4)} + ${fmt(affFull.b, 4)} · d_icc\``
      : 'unavailable',
  );
  md.push('');
  md.push('## Notes');
  md.push('');
  md.push('- `d_icc` is identified from persona-θ labels, not true child ability draws.');
  md.push('- All-correct / all-incorrect / boundary fits are marked unreliable and excluded from anchors.');
  md.push(`- Artifacts: \`${csvPath}\`, \`${metricsPath}\`.`);
  md.push('');

  writeFileSync(reportPath, md.join('\n'));

  console.log(`Wrote ${csvPath}`);
  console.log(`Wrote ${reportPath}`);
  console.log(`Wrote ${metricsPath}`);
  console.log(
    `Anchors ${anchors.length} · ρ_icc_cv=${fmt(spearmanIcc)} ρ_−p_pred=${fmt(spearmanNegPPred)} ρ_d_est=${fmt(prior?.spearman_multivar)} MAE=${fmt(maeIcc)}`,
  );
}

main();
