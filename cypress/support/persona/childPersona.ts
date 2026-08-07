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

/** Per-age mean IRT ability (theta) from child ability_scores + trials age. */
export type AgeAbilityCell = { theta: number; n?: number };
export type AgeAbilityProfile = Record<string, Record<string, AgeAbilityCell>>;

/** Country-stratified tables: country -> task -> age -> value (_meta reserved). */
export type CountryAccuracyProfiles = Record<string, AgeAccuracyProfile>;
export type CountryAbilityProfiles = Record<string, AgeAbilityProfile>;

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

/** Normalize QA_SIM_COUNTRY / QA_PERSONA_COUNTRY (e.g. DE, Colombia, co). */
const COUNTRY_ALIASES: Record<string, string> = {
  de: 'de',
  germany: 'de',
  deutschland: 'de',
  co: 'co',
  colombia: 'co',
  ca: 'ca',
  canada: 'ca',
};

export function normalizeCountry(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const key = String(raw).trim().toLowerCase();
  if (!key) return null;
  return COUNTRY_ALIASES[key] ?? (key.length === 2 ? key : null);
}

const FALLBACK_TEMPLATE = [
  'You are simulating the cognitive abilities of a typical {age_phrase} child taking a developmental assessment, one item at a time.',
  '',
  'Answer the way a child of that age would actually answer — not perfectly, and not randomly. When an item is beyond what a child this age has typically mastered, make the kind of mistake such a child would plausibly make rather than reasoning it out with adult knowledge. When an item is easy for this age, answer it correctly.',
  '',
  'Always respond in exactly the format the task instructions require, with no explanation.{difficulty_block}{ability_block}',
].join('\n');

let cachedProfile: AgeAccuracyProfile | null = null;
let cachedAbilityProfile: AgeAbilityProfile | null = null;
let cachedCountryAccuracy: CountryAccuracyProfiles | null = null;
let cachedCountryAbility: CountryAbilityProfiles | null = null;
let cachedTemplate: string | null = null;

function personaDir(): string {
  return join(process.cwd(), 'cypress', 'support', 'persona');
}

function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(join(personaDir(), name), 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

/** Strip `_meta` and return country -> task profiles. */
function stripMeta<T extends Record<string, unknown>>(raw: T): Omit<T, '_meta'> {
  const { _meta: _ignored, ...rest } = raw as T & { _meta?: unknown };
  return rest as Omit<T, '_meta'>;
}

export function loadProfile(): AgeAccuracyProfile {
  if (cachedProfile === null) {
    cachedProfile = readJson('age_task_accuracy.json', {});
  }
  return cachedProfile as AgeAccuracyProfile;
}

export function loadAbilityProfile(): AgeAbilityProfile {
  if (cachedAbilityProfile === null) {
    cachedAbilityProfile = readJson('age_task_ability.json', {});
  }
  return cachedAbilityProfile as AgeAbilityProfile;
}

export function loadCountryAccuracyProfiles(): CountryAccuracyProfiles {
  if (cachedCountryAccuracy === null) {
    cachedCountryAccuracy = stripMeta(readJson('age_task_accuracy_by_country.json', {}));
  }
  return cachedCountryAccuracy as CountryAccuracyProfiles;
}

export function loadCountryAbilityProfiles(): CountryAbilityProfiles {
  if (cachedCountryAbility === null) {
    cachedCountryAbility = stripMeta(readJson('age_task_ability_by_country.json', {}));
  }
  return cachedCountryAbility as CountryAbilityProfiles;
}

/**
 * Resolve accuracy/ability tables for an optional country.
 * Falls back to the global (pooled) profile when the country is unset or missing a task.
 */
export function resolveProfiles(countryRaw?: string | null): {
  country: string | null;
  accuracy: AgeAccuracyProfile;
  ability: AgeAbilityProfile;
} {
  const country = normalizeCountry(countryRaw);
  const globalAcc = loadProfile();
  const globalAb = loadAbilityProfile();
  if (!country) return { country: null, accuracy: globalAcc, ability: globalAb };

  const byAcc = loadCountryAccuracyProfiles()[country];
  const byAb = loadCountryAbilityProfiles()[country];
  if (!byAcc && !byAb) {
    console.warn(
      `persona: no country profile for '${country}'; using global age tables ` +
        `(known: ${Object.keys(loadCountryAccuracyProfiles()).join(', ') || 'none'})`,
    );
    return { country, accuracy: globalAcc, ability: globalAb };
  }
  // Merge: country cells win; missing tasks fall back to global so sparse
  // country corners still get a calibrated twin.
  return {
    country,
    accuracy: { ...globalAcc, ...(byAcc ?? {}) },
    ability: { ...globalAb, ...(byAb ?? {}) },
  };
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

/** Nearest available age row in a numeric profile (clamps to the profile's age range). */
function nearestAgeKey<T>(taskAcc: Record<string, T>, ageYears: number): string | null {
  const ages = Object.keys(taskAcc).map(Number).filter((n) => Number.isFinite(n));
  if (ages.length === 0) return null;
  let best = ages[0];
  for (const a of ages) {
    if (Math.abs(a - ageYears) < Math.abs(best - ageYears)) best = a;
  }
  return String(best);
}

function nearestAccuracy(taskAcc: Record<string, number>, ageYears: number): number | null {
  const key = nearestAgeKey(taskAcc, ageYears);
  return key != null ? (taskAcc[key] ?? null) : null;
}

function nearestAbility(taskAb: Record<string, AgeAbilityCell>, ageYears: number): AgeAbilityCell | null {
  const key = nearestAgeKey(taskAb, ageYears);
  return key != null ? (taskAb[key] ?? null) : null;
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
export type ChildPersonaOptions = {
  /** When true, append mean IRT θ for this age/task (if available in age_task_ability.json). */
  includeIrtAbility?: boolean;
  /** ISO-ish country key (de/co/ca) or alias; uses country-stratified tables when present. */
  country?: string | null;
  profile?: AgeAccuracyProfile;
  abilityProfile?: AgeAbilityProfile;
};

export function makeChildPersonaPrompt(
  ageYears: number,
  ageMonths = 0,
  qaTaskSlug?: string,
  options: ChildPersonaOptions = {},
): string {
  const template = loadTemplate();
  const phrase = agePhrase(ageYears, ageMonths);
  const ageDecimal = ageYears + ageMonths / 12;
  const resolved =
    options.profile || options.abilityProfile
      ? {
          country: normalizeCountry(options.country),
          accuracy: options.profile ?? loadProfile(),
          ability: options.abilityProfile ?? loadAbilityProfile(),
        }
      : resolveProfiles(options.country);
  const profile = resolved.accuracy;
  const abilityProfile = resolved.ability;

  let difficultyBlock = '';
  let abilityBlock = '';
  const taskId = qaTaskSlug ? SLUG_TO_TASK_ID[qaTaskSlug] : undefined;
  const localeHint = resolved.country
    ? ` in the ${resolved.country.toUpperCase()} pilot sample`
    : '';
  if (taskId && profile[taskId]) {
    const acc = nearestAccuracy(profile[taskId], ageDecimal);
    if (acc != null) {
      difficultyBlock =
        `\n\nFor a child this age${localeHint}, this task is typically ${difficultyLabel(acc)} ` +
        `(about ${Math.round(acc * 100)}% of items answered correctly by children this age).`;
    }
  }
  if (options.includeIrtAbility && taskId && abilityProfile[taskId]) {
    const cell = nearestAbility(abilityProfile[taskId], ageDecimal);
    if (cell != null && Number.isFinite(cell.theta)) {
      const sign = cell.theta >= 0 ? '+' : '';
      abilityBlock =
        `\n\nOn this task's IRT scale, children this age${localeHint} typically have ability θ ≈ ${sign}${cell.theta.toFixed(2)} ` +
        `(task-specific scale; higher θ means stronger performance relative to item difficulty).`;
    }
  }

  // Operational mastery cues for TROG (age-band), not soft roleplay.
  if (taskId === 'trog') {
    abilityBlock += `\n\n${trogMasteryCue(ageDecimal)}`;
  }

  return template
    .replace('{age_phrase}', phrase)
    .replace('{difficulty_block}', difficultyBlock)
    .replace('{ability_block}', abilityBlock);
}

/** Mastery-based TROG guidance by age band (construction difficulty kids typically face). */
function trogMasteryCue(ageYears: number): string {
  if (ageYears <= 8) {
    return (
      'Grammar mastery at this age: simple verbs and basic scenes are usually fine. ' +
      'Complex passives, agent/patient reversals, embeddings ("the X the Y chases"), ' +
      'and despite/although contrasts are often beyond this age — when unsure, prefer a ' +
      'salient but incorrect scene rather than adult grammar analysis.'
    );
  }
  if (ageYears <= 10) {
    return (
      'Grammar mastery at this age: you can usually handle negation and who-did-what on ' +
      'simpler items. Passives, embeddings, and despite/although still trip children this ' +
      'age fairly often — do not over-analyze; miss items that feel beyond typical mastery.'
    );
  }
  return (
    'Grammar mastery at this age: you can usually resolve who-did-what, negation, and ' +
    'spatial relations. You may still miss the hardest embeddings and rare contrast ' +
    'constructions sometimes — answer those as a typical child this age would, not as an adult parser.'
  );
}
