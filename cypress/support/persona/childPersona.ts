/**
 * Child-age persona prompt builder (node-side).
 *
 * Produces a system-prompt preamble that asks a VLM to answer as a typical child
 * of a target age would, grounded in real LEVANTE accuracy-by-age data. The data
 * (`age_task_accuracy.json`) and wording (`persona_template.txt`) in this folder
 * are the SINGLE SOURCE OF TRUTH shared with levante-bench (canonical copies live
 * in `levante-bench/shared/persona/`; keep them in sync with `npm run persona:sync`).
 *
 * This module is provider-agnostic: the preamble is prepended to a task's
 * existing SYSTEM_PROMPT inside the `askVLM` node task, so no per-provider or
 * per-agent code needs to know about age.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type AgeAccuracyProfile = Record<string, Record<string, number>>;

/** Maps a levante-qa task folder slug to the canonical LEVANTE task_id used in
 * the trial data / profile JSON. Slugs with no matching profile (none today)
 * simply fall back to age-only persona wording. */
const SLUG_TO_TASK_ID: Record<string, string> = {
  hearts_and_flowers: 'hearts-and-flowers',
  egma_math: 'egma-math',
  vocab: 'vocab',
  stories: 'theory-of-mind',
  same_different: 'same-different-selection',
  mental_rotation: 'mental-rotation',
  matrix_reasoning: 'matrix-reasoning',
  trog: 'trog',
  memory_game: 'memory-game',
};

const FALLBACK_TEMPLATE = [
  'You are simulating the cognitive abilities of a typical {age_phrase} child taking a developmental assessment, one item at a time.',
  '',
  'Answer the way a child of that age would actually answer — not perfectly, and not randomly. When an item is beyond what a child this age has typically mastered, make the kind of mistake such a child would plausibly make rather than reasoning it out with adult knowledge. When an item is easy for this age, answer it correctly.',
  '',
  'Always respond in exactly the format the task instructions require, with no explanation.{difficulty_block}',
].join('\n');

let cachedProfile: AgeAccuracyProfile | null = null;
let cachedTemplate: string | null = null;

function personaDir(): string {
  return join(process.cwd(), 'cypress', 'support', 'persona');
}

export function loadProfile(): AgeAccuracyProfile {
  if (cachedProfile === null) {
    try {
      cachedProfile = JSON.parse(readFileSync(join(personaDir(), 'age_task_accuracy.json'), 'utf-8'));
    } catch {
      cachedProfile = {};
    }
  }
  return cachedProfile as AgeAccuracyProfile;
}

function loadTemplate(): string {
  if (cachedTemplate === null) {
    try {
      cachedTemplate = readFileSync(join(personaDir(), 'persona_template.txt'), 'utf-8').trimEnd();
    } catch {
      cachedTemplate = FALLBACK_TEMPLATE;
    }
  }
  return cachedTemplate;
}

/** Difficulty band for a given expected accuracy (shared thresholds with bench). */
export function difficultyLabel(accuracy: number): 'easy' | 'moderate' | 'hard' {
  if (accuracy > 0.75) return 'easy';
  if (accuracy > 0.45) return 'moderate';
  return 'hard';
}

/** Nearest available age row's accuracy (clamps to the profile's age range). */
function nearestAccuracy(taskAcc: Record<string, number>, ageYears: number): number | null {
  const ages = Object.keys(taskAcc).map(Number).filter((n) => Number.isFinite(n));
  if (ages.length === 0) return null;
  let best = ages[0];
  for (const a of ages) {
    if (Math.abs(a - ageYears) < Math.abs(best - ageYears)) best = a;
  }
  return taskAcc[String(best)] ?? null;
}

function agePhrase(ageYears: number, ageMonths: number): string {
  const y = `${ageYears}-year`;
  if (ageMonths > 0) return `${y}-${ageMonths}-month-old`;
  return `${y}-old`;
}

/**
 * Build the persona preamble. `qaTaskSlug` is the levante-qa task folder slug
 * (e.g. 'trog', 'egma_math'); when its profile is available the preamble adds a
 * task-specific difficulty hint for the target age.
 */
export function makeChildPersonaPrompt(
  ageYears: number,
  ageMonths = 0,
  qaTaskSlug?: string,
  profile: AgeAccuracyProfile = loadProfile(),
): string {
  const template = loadTemplate();
  const phrase = agePhrase(ageYears, ageMonths);
  const ageDecimal = ageYears + ageMonths / 12;

  let difficultyBlock = '';
  const taskId = qaTaskSlug ? SLUG_TO_TASK_ID[qaTaskSlug] : undefined;
  if (taskId && profile[taskId]) {
    const acc = nearestAccuracy(profile[taskId], ageDecimal);
    if (acc != null) {
      difficultyBlock =
        `\n\nFor a child this age, this task is typically ${difficultyLabel(acc)} ` +
        `(about ${Math.round(acc * 100)}% of items answered correctly by children this age).`;
    }
  }

  return template.replace('{age_phrase}', phrase).replace('{difficulty_block}', difficultyBlock);
}
