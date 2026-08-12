/**
 * Node-side config for the timed_child agent (PA first).
 *
 * Loads age-binned empirical accuracy + RT percentiles from
 * cypress/support/persona/pa_timed_child_norms.json (built by
 * scripts/build_pa_timed_child_norms.mjs from levante-bench pa_trials.csv).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const NORMS_PATH = join(HERE, '..', 'support', 'persona', 'pa_timed_child_norms.json');

export interface TimedChildAgeNorm {
  n: number;
  pCorrect: number;
  rtP25: number;
  rtP50: number;
  rtP75: number;
  nRt: number;
}

export interface TimedChildNormsFile {
  task: string;
  source: string;
  builtAt: string;
  ages: Record<string, TimedChildAgeNorm>;
}

export interface TimedChildConfig {
  taskSlug: string;
  ageYears: number;
  ageMonths: number;
  age: number;
  seed: string;
  /** Empirical P(correct) for nearest age bin. */
  pCorrect: number;
  rtP25: number;
  rtP50: number;
  rtP75: number;
  /** Age key used from the norms table. */
  normAge: number;
  n: number;
}

function nearestAgeNorm(
  ages: Record<string, TimedChildAgeNorm>,
  age: number,
): { key: number; norm: TimedChildAgeNorm } {
  const keys = Object.keys(ages)
    .map(Number)
    .filter((k) => Number.isFinite(k))
    .sort((a, b) => a - b);
  if (keys.length === 0) {
    throw new Error('timed_child: pa_timed_child_norms.json has no age bins');
  }
  let best = keys[0];
  let bestDist = Math.abs(age - best);
  for (const k of keys) {
    const d = Math.abs(age - k);
    if (d < bestDist) {
      best = k;
      bestDist = d;
    }
  }
  return { key: best, norm: ages[String(best)] };
}

export function buildTimedChildConfig(taskSlug: string): TimedChildConfig {
  if (taskSlug !== 'pa') {
    throw new Error(`timed_child: only PA is supported in v1 (got '${taskSlug}')`);
  }
  const ageYears = Number(process.env.QA_TIMED_AGE_YEARS ?? process.env.QA_SIM_AGE_YEARS ?? '');
  if (!Number.isFinite(ageYears) || ageYears <= 0) {
    throw new Error(
      'timed_child: set QA_TIMED_AGE_YEARS (e.g. QA_TIMED_AGE_YEARS=8)',
    );
  }
  const ageMonths =
    Number(process.env.QA_TIMED_AGE_MONTHS ?? process.env.QA_SIM_AGE_MONTHS ?? '0') || 0;
  const age = ageYears + ageMonths / 12;
  const seed = String(process.env.QA_TIMED_SEED ?? process.env.QA_SIM_SEED ?? '1');

  const raw = JSON.parse(readFileSync(NORMS_PATH, 'utf8')) as TimedChildNormsFile;
  const { key, norm } = nearestAgeNorm(raw.ages ?? {}, age);

  return {
    taskSlug,
    ageYears,
    ageMonths,
    age,
    seed,
    pCorrect: norm.pCorrect,
    rtP25: norm.rtP25,
    rtP50: norm.rtP50,
    rtP75: norm.rtP75,
    normAge: key,
    n: norm.n,
  };
}
