/**
 * The set of tasks the dashboard can launch. Each entry maps a UI key to the
 * kebab-case core taskId used for dashboard provisioning/launch and to the
 * Cypress spec files for each agent. `vlmSpec: null` ⇒ oracle-only.
 */
export const CATALOG = [
  {
    id: 'hearts_and_flowers',
    label: 'Hearts & Flowers',
    taskId: 'hearts-and-flowers',
    oracleSpec: 'cypress/e2e/hearts_and_flowers/oracle.cy.ts',
    wrongSpec: 'cypress/e2e/hearts_and_flowers/wrong_agent.cy.ts',
    vlmSpec: 'cypress/e2e/hearts_and_flowers/vlm_agent.cy.ts',
  },
  {
    id: 'egma_math',
    label: 'EGMA Math',
    taskId: 'egma-math',
    oracleSpec: 'cypress/e2e/egma_math/oracle.cy.ts',
    wrongSpec: 'cypress/e2e/egma_math/wrong_agent.cy.ts',
    vlmSpec: 'cypress/e2e/egma_math/vlm_agent.cy.ts',
  },
  {
    id: 'vocab',
    label: 'Vocab',
    taskId: 'vocab',
    oracleSpec: 'cypress/e2e/vocab/oracle.cy.ts',
    wrongSpec: 'cypress/e2e/vocab/wrong_agent.cy.ts',
    vlmSpec: 'cypress/e2e/vocab/vlm_agent.cy.ts',
  },
  {
    id: 'stories',
    label: 'Stories (Theory of Mind)',
    taskId: 'theory-of-mind',
    oracleSpec: 'cypress/e2e/stories/oracle.cy.ts',
    wrongSpec: 'cypress/e2e/stories/wrong_agent.cy.ts',
    vlmSpec: 'cypress/e2e/stories/vlm_agent.cy.ts',
  },
  {
    id: 'same_different',
    label: 'Same-Different Selection',
    taskId: 'same-different-selection',
    oracleSpec: 'cypress/e2e/same_different/oracle.cy.ts',
    wrongSpec: 'cypress/e2e/same_different/wrong_agent.cy.ts',
    vlmSpec: 'cypress/e2e/same_different/vlm_agent.cy.ts',
  },
  {
    id: 'mental_rotation',
    label: 'Mental Rotation',
    taskId: 'mental-rotation',
    oracleSpec: 'cypress/e2e/mental_rotation/oracle.cy.ts',
    wrongSpec: 'cypress/e2e/mental_rotation/wrong_agent.cy.ts',
    vlmSpec: 'cypress/e2e/mental_rotation/vlm_agent.cy.ts',
  },
  {
    id: 'matrix_reasoning',
    label: 'Matrix Reasoning',
    taskId: 'matrix-reasoning',
    oracleSpec: 'cypress/e2e/matrix_reasoning/oracle.cy.ts',
    wrongSpec: 'cypress/e2e/matrix_reasoning/wrong_agent.cy.ts',
    vlmSpec: 'cypress/e2e/matrix_reasoning/vlm_agent.cy.ts',
  },
  {
    id: 'trog',
    label: 'TROG',
    taskId: 'trog',
    oracleSpec: 'cypress/e2e/trog/oracle.cy.ts',
    wrongSpec: 'cypress/e2e/trog/wrong_agent.cy.ts',
    vlmSpec: 'cypress/e2e/trog/vlm_agent.cy.ts',
  },
  {
    id: 'memory_game',
    label: 'Memory Game (Corsi)',
    taskId: 'memory-game',
    oracleSpec: 'cypress/e2e/memory_game/oracle.cy.ts',
    wrongSpec: 'cypress/e2e/memory_game/wrong_agent.cy.ts',
    vlmSpec: null,
  },
  {
    id: 'pa',
    label: 'ROAR — Phoneme (PA)',
    taskId: 'pa',
    oracleSpec: 'cypress/e2e/pa/oracle.cy.ts',
    wrongSpec: 'cypress/e2e/pa/wrong_agent.cy.ts',
    timedSpec: 'cypress/e2e/pa/timed_child.cy.ts',
    vlmSpec: null,
    requiresDashboard: true,
  },
  {
    id: 'sre',
    label: 'ROAR — Sentence (SRE)',
    taskId: 'sre',
    oracleSpec: 'cypress/e2e/sre/oracle.cy.ts',
    wrongSpec: 'cypress/e2e/sre/wrong_agent.cy.ts',
    vlmSpec: 'cypress/e2e/sre/vlm_agent.cy.ts',
    requiresDashboard: true,
  },
  {
    id: 'swr',
    label: 'ROAR — Word (SWR)',
    taskId: 'swr',
    oracleSpec: 'cypress/e2e/swr/oracle.cy.ts',
    wrongSpec: 'cypress/e2e/swr/wrong_agent.cy.ts',
    vlmSpec: 'cypress/e2e/swr/vlm_agent.cy.ts',
    requiresDashboard: true,
  },
];

export const VLM_PROVIDERS = ['gemini', 'openai', 'anthropic'];

/**
 * Languages our tasks ship variants for on hs-levante-admin-dev. `code` is sent
 * to the provisioner (variant selection) and exposed as QA_EXPECTED_AUDIO_LANG
 * (narration language check). The first entry is the default.
 */
export const LANGUAGES = [
  { code: 'en-US', label: 'English (North America)' },
  { code: 'de-DE', label: 'German (Germany)' },
  { code: 'es-CO', label: 'Spanish (Colombia)' },
  { code: 'es-AR', label: 'Spanish (Argentina)' },
  { code: 'nl-NL', label: 'Dutch' },
  // Flagged "testing" on the LEVANTE platform (RTL, in-progress translations).
  { code: 'ar-IL', label: 'Arabic (Israel)', testing: true },
  { code: 'he-IL', label: 'Hebrew (Israel)', testing: true },
];

export const DEFAULT_LANGUAGE = LANGUAGES[0].code;

export function isSupportedLanguage(code) {
  return LANGUAGES.some((l) => l.code === code);
}

/**
 * Locale codes that were renamed on the LEVANTE platform. Callers must reject
 * these (rather than silently falling back to DEFAULT_LANGUAGE) so a stale
 * config surfaces loudly. Maps the legacy code → its canonical replacement.
 */
export const LEGACY_LANGUAGE_CODES = { nl: 'nl-NL' };

/** Canonical replacement for a legacy locale code, or null if not legacy. */
export function legacyLanguageReplacement(code) {
  return Object.prototype.hasOwnProperty.call(LEGACY_LANGUAGE_CODES, code)
    ? LEGACY_LANGUAGE_CODES[code]
    : null;
}

export function findTask(id) {
  return CATALOG.find((t) => t.id === id) ?? null;
}

/** Catalog entry whose kebab `taskId` matches (e.g. "egma-math"), or null. */
export function findTaskByTaskId(taskId) {
  return CATALOG.find((t) => t.taskId === taskId) ?? null;
}

/**
 * Map a pack / assignment language tag onto a dashboard locale so Cypress
 * audio checks have a real folder (`es` → Colombian Spanish, `es-Ar` →
 * Argentine Spanish). Returns null when we cannot guess.
 */
export function canonicalQaLocale(code) {
  const raw = String(code || '').trim();
  if (!raw) return null;
  if (isSupportedLanguage(raw)) return raw;
  const legacy = legacyLanguageReplacement(raw);
  if (legacy) return legacy;
  const lower = raw.toLowerCase();
  const [primary, region] = lower.split(/[-_]/);
  if (primary === 'en') return 'en-US';
  if (primary === 'de') return 'de-DE';
  if (primary === 'nl') return 'nl-NL';
  if (primary === 'ar') return 'ar-IL';
  if (primary === 'he') return 'he-IL';
  if (primary === 'es') {
    if (region === 'ar') return 'es-AR';
    return 'es-CO';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-language task support
//
// Which LEVANTE tasks ship in each language is documented in the platform's
// languageoptions.json (`taskOptions`, by kebab taskId). ROAR tasks (pa/sre/swr)
// are NOT in that file — they have no regional dialects and are available
// wherever their bare language (en/de/es) exists.
// ---------------------------------------------------------------------------

/** ROAR literacy tasks: no dialects, keyed on the primary language subtag. */
export const ROAR_TASK_IDS = new Set(['pa', 'sre', 'swr']);
/** Primary language subtags ROAR ships (es covers es-CO/es-AR, etc.). */
const ROAR_PRIMARIES = new Set(['en', 'de', 'es']);

export function isRoarTask(taskId) {
  return ROAR_TASK_IDS.has(taskId);
}

/**
 * Snapshot of languageoptions.json `taskOptions` (kebab taskIds) used as a
 * fallback when the live file can't be fetched. Keep in sync opportunistically;
 * the server prefers the live file. (`intro`/`hostile-attribution`/`child-survey`
 * are platform entries with no QA task and are simply ignored.)
 */
export const FALLBACK_TASK_OPTIONS = {
  'en-US': ['egma-math', 'matrix-reasoning', 'mental-rotation', 'hearts-and-flowers', 'memory-game', 'same-different-selection', 'trog', 'vocab', 'theory-of-mind'],
  'de-DE': ['egma-math', 'matrix-reasoning', 'mental-rotation', 'hearts-and-flowers', 'memory-game', 'same-different-selection', 'trog', 'vocab', 'theory-of-mind'],
  'es-CO': ['egma-math', 'matrix-reasoning', 'mental-rotation', 'hearts-and-flowers', 'memory-game', 'same-different-selection', 'trog', 'vocab', 'theory-of-mind'],
  'es-AR': ['hearts-and-flowers', 'same-different-selection', 'trog', 'theory-of-mind'],
  'nl-NL': ['egma-math', 'matrix-reasoning', 'mental-rotation', 'hearts-and-flowers', 'memory-game', 'same-different-selection', 'trog', 'vocab', 'theory-of-mind'],
  'ar-IL': [],
  'he-IL': [],
};

const primaryOf = (code) => String(code ?? '').toLowerCase().split(/[-_]/)[0];

/**
 * Is `task` (a CATALOG entry) supported in `langCode`?
 *  - ROAR: yes iff the primary language is one ROAR ships (en/de/es).
 *  - LEVANTE: yes iff its taskId is in that language's taskOptions.
 * `taskOptionsByLang` is the languageoptions.json map (or the fallback).
 */
export function isTaskSupportedInLanguage(task, langCode, taskOptionsByLang) {
  if (isRoarTask(task.taskId)) return ROAR_PRIMARIES.has(primaryOf(langCode));
  const opts = taskOptionsByLang?.[langCode];
  return Array.isArray(opts) ? opts.includes(task.taskId) : false;
}

/**
 * Build `{ [langCode]: [catalogId, ...] }` — the CATALOG ids supported in each
 * configured language — for the dashboard to gray out the rest.
 */
export function buildTaskSupport(taskOptionsByLang) {
  const out = {};
  for (const lang of LANGUAGES) {
    out[lang.code] = CATALOG.filter((t) =>
      isTaskSupportedInLanguage(t, lang.code, taskOptionsByLang),
    ).map((t) => t.id);
  }
  return out;
}
