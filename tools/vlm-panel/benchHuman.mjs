/**
 * Load human item statistics from the sibling levante-bench repo.
 *
 * Primary targets:
 *   - responses_by_ability/<task>_proportions.csv  (image1 = P(correct))
 *   - trials.csv aggregated to age × item pass-rates
 *
 * Override root with LEVANTE_BENCH_ROOT (default: ../levante-bench from repo).
 * Default local folder is v2 = Redivis levante-data-latest (internal QA).
 * Public research (levante-bench) defaults to pilots v3.0 → local v3.
 */
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

/** analyze.mjs task name → bench task_id / file stem */
export const TASK_TO_BENCH = {
  trog: 'trog',
  vocab: 'vocab',
  stories: 'theory-of-mind',
  matrix: 'matrix-reasoning',
};

export function benchRoot() {
  return process.env.LEVANTE_BENCH_ROOT || join(REPO, '..', 'levante-bench');
}

export function proportionsPath(taskName, version = 'v2') {
  const benchTask = TASK_TO_BENCH[taskName];
  if (!benchTask) return null;
  return join(
    benchRoot(),
    'data',
    'responses',
    version,
    'responses_by_ability',
    `${benchTask}_proportions.csv`,
  );
}

export function trialsPath(version = 'v2') {
  return join(benchRoot(), 'data', 'responses', version, 'trials.csv');
}

/** Strip tom_storyN_ so QA ToM uids join bench uids. */
export function normalizeItemUid(taskName, itemUid) {
  const u = String(itemUid ?? '').trim();
  if (!u) return '';
  if (taskName === 'stories' || TASK_TO_BENCH[taskName] === 'theory-of-mind') {
    const m = u.match(/^(tom_)story\d+_(.+)$/i);
    if (m) return `${m[1]}${m[2]}`;
  }
  return u;
}

function parseCsvLine(line) {
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

/**
 * Map normalized item_uid → P(correct) from bench proportions (image1).
 * @returns {Map<string, number>}
 */
export function loadBenchProportions(taskName, version = 'v2') {
  const path = proportionsPath(taskName, version);
  const out = new Map();
  if (!path || !existsSync(path)) return out;
  const txt = readFileSync(path, 'utf-8');
  const lines = txt.trim().split(/\r?\n/);
  if (lines.length < 2) return out;
  const header = parseCsvLine(lines[0]);
  const iUid = header.indexOf('item_uid');
  const iImg1 = header.indexOf('image1');
  if (iUid < 0 || iImg1 < 0) return out;
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const uid = normalizeItemUid(taskName, cols[iUid]);
    const p = Number(cols[iImg1]);
    if (!uid || !Number.isFinite(p)) continue;
    out.set(uid, p);
  }
  return out;
}

function parseCorrect(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 't') return 1;
  if (s === 'false' || s === '0' || s === 'f') return 0;
  return null;
}

/**
 * Stream trials.csv → overall item pass-rates and age×item rates for one task.
 * Prefer this over proportions.csv image1 (vocab option columns are not reliably
 * keyed with target in image1).
 */
export async function loadBenchTrialStats(taskName, version = 'v2', { minN = 5, minAgeN = 5 } = {}) {
  const benchTask = TASK_TO_BENCH[taskName];
  const path = trialsPath(version);
  /** @type {Map<string, { n: number, c: number }>} */
  const overall = new Map();
  /** @type {Map<string, Map<number, { n: number, c: number }>>} */
  const rawAge = new Map();

  if (!benchTask || !existsSync(path)) {
    return {
      itemPass: new Map(),
      ageItem: { byItem: new Map(), path, task: benchTask, minN: minAgeN },
      path,
      task: benchTask,
    };
  }

  const stream = createReadStream(path, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let header = null;
  let iTask = -1;
  let iUid = -1;
  let iCorrect = -1;
  let iAge = -1;

  for await (const line of rl) {
    if (!header) {
      header = parseCsvLine(line);
      iTask = header.indexOf('task_id');
      iUid = header.indexOf('item_uid');
      iCorrect = header.indexOf('correct');
      iAge = header.indexOf('age');
      if (iTask < 0 || iUid < 0 || iCorrect < 0 || iAge < 0) break;
      continue;
    }
    const cols = parseCsvLine(line);
    if (cols[iTask] !== benchTask) continue;
    const uid = normalizeItemUid(taskName, cols[iUid]);
    const corr = parseCorrect(cols[iCorrect]);
    if (!uid || corr == null) continue;

    const o = overall.get(uid) || { n: 0, c: 0 };
    o.n += 1;
    o.c += corr;
    overall.set(uid, o);

    const age = Math.floor(Number(cols[iAge]));
    if (!Number.isFinite(age) || age < 3 || age > 18) continue;
    if (!rawAge.has(uid)) rawAge.set(uid, new Map());
    const byAge = rawAge.get(uid);
    const cell = byAge.get(age) || { n: 0, c: 0 };
    cell.n += 1;
    cell.c += corr;
    byAge.set(age, cell);
  }

  /** @type {Map<string, number>} */
  const itemPass = new Map();
  for (const [uid, cell] of overall) {
    if (cell.n < minN) continue;
    itemPass.set(uid, cell.c / cell.n);
  }

  /** @type {Map<string, Record<string, number>>} */
  const byItem = new Map();
  for (const [uid, byAge] of rawAge) {
    const rates = {};
    for (const [age, cell] of byAge) {
      if (cell.n < minAgeN) continue;
      rates[String(age)] = cell.c / cell.n;
    }
    if (Object.keys(rates).length) byItem.set(uid, rates);
  }

  return {
    itemPass,
    ageItem: { byItem, path, task: benchTask, minN: minAgeN },
    path,
    task: benchTask,
    minN,
  };
}

/**
 * Stream trials.csv → { [item_uid]: { [ageYears]: rate } } for one task.
 * @deprecated prefer loadBenchTrialStats
 */
export async function loadBenchAgeItemRates(taskName, version = 'v2', { minN = 5 } = {}) {
  const stats = await loadBenchTrialStats(taskName, version, { minN: 5, minAgeN: minN });
  return stats.ageItem;
}

/** Serialize age×item rates for calibration/ disk. */
export function ageItemRatesToJson(payload) {
  const items = {};
  for (const [uid, rates] of payload.byItem) {
    items[uid] = rates;
  }
  return {
    source: 'levante-bench',
    task: payload.task,
    minN: payload.minN,
    nItems: payload.byItem.size,
    items,
  };
}

export function loadAgeItemRatesJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}
