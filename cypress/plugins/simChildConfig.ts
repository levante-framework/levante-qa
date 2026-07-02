/**
 * Node-side config builder for the calibrated simulated-child agent (`sim` mode).
 *
 * The sim agent answers each scored item correctly with probability
 *
 *     P(correct) = c + (1 - c) * sigmoid(theta + b - d)
 *
 * where `theta` is the mean child IRT ability for the target age
 * (cypress/support/persona/age_task_ability.json), `d` is the item's IRT
 * difficulty from the task's deployed item bank, `c` is the per-item guessing
 * floor (1 / number of choices, applied browser-side), and `b` is a small
 * per-task/age calibration offset chosen here so the mean predicted accuracy
 * over the item bank matches the EMPIRICAL accuracy-by-age table
 * (age_task_accuracy.json). Without `b` the plain Rasch prediction from the
 * shipped thetas underpredicts observed accuracy by ~5-12 points; with it the
 * simulator matches age norms while preserving item-difficulty ordering.
 *
 * Items with no `d` in the bank (practice / uncalibrated) fall back to the
 * empirical age accuracy directly. All randomness is hash-seeded browser-side
 * (see support/agentMode.ts), so a run is fully reproducible.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadAbilityProfile, loadProfile } from '../support/persona/childPersona';

/** levante-qa task slug -> canonical LEVANTE task id (item-bank + profile key). */
const SLUG_TO_TASK_ID: Record<string, string> = {
  trog: 'trog',
  vocab: 'vocab',
  stories: 'theory-of-mind',
  matrix_reasoning: 'matrix-reasoning',
  mental_rotation: 'mental-rotation',
  egma_math: 'egma-math',
};

const BANK_BUCKET = process.env.QA_SIM_BANK_BUCKET || 'levante-assets-dev';
const CACHE_DIR = join(process.cwd(), 'cypress', 'cache');

export interface SimChildConfig {
  taskSlug: string;
  taskId: string;
  ageYears: number;
  ageMonths: number;
  /** Mean child IRT theta for this age/task; null when the task has no ability table. */
  theta: number | null;
  /** Calibration offset b (0 when theta or the accuracy target is unavailable). */
  offset: number;
  /** Empirical mean accuracy for this age/task — the fallback P for items with no d. */
  fallbackP: number;
  /** Item answer key (bank `answer` == trial `keyedValue`) -> IRT difficulty d. */
  dByAnswer: Record<string, number>;
  seed: string;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function nearestAgeRow<T>(table: Record<string, T>, age: number): T | null {
  const ages = Object.keys(table)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  if (ages.length === 0) return null;
  let best = ages[0];
  for (const a of ages) if (Math.abs(a - age) < Math.abs(best - age)) best = a;
  return table[String(best)] ?? null;
}

async function fetchBankCsv(taskId: string): Promise<string> {
  const cachePath = join(CACHE_DIR, `sim-item-bank-${taskId}.csv`);
  const refresh = /^(1|true|yes)$/i.test(process.env.QA_SIM_REFRESH ?? '');
  if (!refresh && existsSync(cachePath)) return readFileSync(cachePath, 'utf-8');
  const url = `https://storage.googleapis.com/${BANK_BUCKET}/corpus/${taskId}/${taskId}-item-bank.csv`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`sim: item bank fetch failed (${res.status}) for ${url}`);
  const text = await res.text();
  const dir = dirname(cachePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(cachePath, text, 'utf-8');
  return text;
}

/** Minimal CSV parse (handles quoted fields with commas; bank files are simple). */
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const parseLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') inQ = false;
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ',') {
        out.push(cur);
        cur = '';
      } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const headers = parseLine(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((l) => {
    const vals = parseLine(l);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = (vals[i] ?? '').trim()));
    return row;
  });
}

/**
 * Solve for the offset b such that the mean of c + (1-c)*sigmoid(theta + b - d)
 * over the bank's calibrated items equals the empirical target accuracy.
 * Bisection on a monotone function; returns 0 when no solution is needed/possible.
 */
function calibrateOffset(
  theta: number,
  items: { d: number; c: number }[],
  targetAcc: number,
): number {
  if (items.length === 0) return 0;
  const meanP = (b: number) =>
    items.reduce((s, it) => s + it.c + (1 - it.c) * sigmoid(theta + b - it.d), 0) / items.length;
  let lo = -6;
  let hi = 6;
  if (targetAcc <= meanP(lo) || targetAcc >= meanP(hi)) return 0;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (meanP(mid) < targetAcc) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Build the sim config for one task. Called once per spec via the
 * `getSimConfig` cypress task; the result is handed to `simInit` browser-side.
 */
export async function buildSimChildConfig(taskSlug: string): Promise<SimChildConfig> {
  const taskId = SLUG_TO_TASK_ID[taskSlug];
  if (!taskId) {
    throw new Error(
      `sim: no item-bank mapping for task slug '${taskSlug}' ` +
        `(supported: ${Object.keys(SLUG_TO_TASK_ID).join(', ')})`,
    );
  }
  const ageYears = Number(process.env.QA_SIM_AGE_YEARS ?? '');
  if (!Number.isFinite(ageYears) || ageYears <= 0) {
    throw new Error('sim: set QA_SIM_AGE_YEARS (e.g. QA_SIM_AGE_YEARS=8) for sim_child runs');
  }
  const ageMonths = Number(process.env.QA_SIM_AGE_MONTHS ?? '0') || 0;
  const age = ageYears + ageMonths / 12;

  const abilityCell = nearestAgeRow(loadAbilityProfile()[taskId] ?? {}, age);
  const theta = abilityCell && Number.isFinite(abilityCell.theta) ? abilityCell.theta : null;
  const fallbackP = nearestAgeRow(loadProfile()[taskId] ?? {}, age);
  if (fallbackP == null) {
    throw new Error(`sim: no accuracy-by-age profile for '${taskId}' in age_task_accuracy.json`);
  }

  const rows = parseCsv(await fetchBankCsv(taskId));
  const dByAnswer: Record<string, number> = {};
  const calItems: { d: number; c: number }[] = [];
  for (const r of rows) {
    const answer = (r.answer ?? '').trim();
    // Banks are inconsistent about the difficulty column: trog/vocab use `d`,
    // matrix-reasoning/SDS use `difficulty` (trog's `difficulty` is empty).
    // Blank must NOT coerce to 0 (Number('') === 0): those items are
    // uncalibrated and should use the empirical-accuracy fallback instead.
    const dStr = (r.d ?? '').trim() || (r.difficulty ?? '').trim();
    const d = dStr ? Number(dStr) : NaN;
    if (!answer || !Number.isFinite(d)) continue;
    dByAnswer[answer] = d;
    const c = Number((r.chance_level ?? '').trim());
    calItems.push({ d, c: Number.isFinite(c) && c > 0 && c < 1 ? c : 0.25 });
  }

  const offset = theta != null ? calibrateOffset(theta, calItems, fallbackP) : 0;
  return {
    taskSlug,
    taskId,
    ageYears,
    ageMonths,
    theta,
    offset,
    fallbackP,
    dByAnswer,
    seed: String(process.env.QA_SIM_SEED ?? '1'),
  };
}
