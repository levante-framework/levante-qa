/**
 * Vocab VLM prompt text (system + age-conditional variants).
 *
 * Kept separate from `vocabVlmAgent.ts` so prompt revisions are easy to diff and
 * document in the lab notebook. The agent imports these for Cypress runs.
 *
 * Prompt **v1** (2026-08-09): age split + anti-stretch. Smoke NO-GO (CEILING ↑).
 *
 * Prompt **v2** (2026-08-09): uncommon-word + age vocabulary limit. Better than v1,
 * still NO-GO vs larger baseline panel.
 *
 * Prompt **v3** (2026-08-10): reply format `DIGIT YES|NO` (knows word at age?).
 * Agent randomizes choice when NO — works with current strong models without
 * relying on EOL weaker SKUs. Pair with temperature ladder in panel grids.
 * Default when `QA_VOCAB_PROMPT` unset.
 *
 * Prompt **v4** (2026-08-11): reply `DIGIT HIGH|MED|LOW` graded age-knows
 * confidence. LOW → randomize (like v3 NO). Soft score: HIGH=1, MED=0.5, LOW=chance.
 * Enable with `QA_VOCAB_PROMPT=v4`.
 */

function ageVocabLine(ageYears: number | null): string {
  if (ageYears != null && Number.isFinite(ageYears)) {
    const a = Math.round(ageYears);
    return (
      `Vocabulary limit: you only know words that a typical ${a}-year-old child ` +
      `would know. Do not use adult, technical, or specialist vocabulary beyond that age.`
    );
  }
  return (
    'Vocabulary limit: you only know words typical for a school-age child. ' +
    'Do not use adult, technical, or specialist vocabulary.'
  );
}

/** Shared reply / grid footer — v3 binary YES|NO. */
const REPLY_FOOTER_V3 = [
  '',
  'The pictures are numbered by position:',
  '  1 = top-left      2 = top-right',
  '  3 = bottom-left   4 = bottom-right',
  '',
  'Reply with exactly two tokens on one line:',
  '  (1) the digit 1-4 of the picture that matches the word',
  '  (2) YES or NO — would a child with your vocabulary limit know this word?',
  'Examples: "2 YES" or "3 NO". No other words or punctuation.',
  'If NO, still give a digit guess for (1); do not invent an adult stretch.',
].join('\n');

/** Shared reply / grid footer — v4 graded confidence. */
const REPLY_FOOTER_V4 = [
  '',
  'The pictures are numbered by position:',
  '  1 = top-left      2 = top-right',
  '  3 = bottom-left   4 = bottom-right',
  '',
  'Reply with exactly two tokens on one line:',
  '  (1) the digit 1-4 of the picture that matches the word',
  '  (2) HIGH, MED, or LOW — how sure are you that a child with your',
  '      vocabulary limit would know this word?',
  '        HIGH = clearly in that age vocabulary',
  '        MED  = maybe / borderline for that age',
  '        LOW  = outside that age vocabulary',
  'Examples: "2 HIGH" or "3 MED" or "1 LOW". No other words or punctuation.',
  'If LOW, still give a digit guess for (1); do not invent an adult stretch.',
].join('\n');

export type VocabPromptVersion = 'v3' | 'v4';

/** Resolve prompt version from QA_VOCAB_PROMPT (default v3). */
export function resolveVocabPromptVersion(): VocabPromptVersion {
  let raw: unknown;
  try {
    if (typeof Cypress !== 'undefined' && typeof Cypress.expose === 'function') {
      raw = Cypress.expose('QA_VOCAB_PROMPT');
    }
  } catch {
    /* not in Cypress */
  }
  if (raw == null || raw === '') {
    raw = typeof process !== 'undefined' ? process.env.QA_VOCAB_PROMPT : undefined;
  }
  const s = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (s === 'v4' || s === 'graded' || s === '4') return 'v4';
  return 'v3';
}

function replyFooter(version: VocabPromptVersion = resolveVocabPromptVersion()): string {
  return version === 'v4' ? REPLY_FOOTER_V4 : REPLY_FOOTER_V3;
}

/**
 * Build older / default checklist (ages > VOCAB_YOUNG_AGE_MAX).
 * Exported constant uses null age (generic school-age line) for static imports.
 */
export function buildSystemPromptChecklist(
  ageYears: number | null = null,
  version: VocabPromptVersion = resolveVocabPromptVersion(),
): string {
  const knowLine =
    version === 'v4'
      ? 'If the word is uncommon or outside your age vocabulary, answer LOW.'
      : 'If the word is uncommon or outside your age vocabulary, answer NO for knowing it.';
  return [
    'You are taking a picture-vocabulary test, one item at a time.',
    'You hear a single word (given to you as text) and see four pictures arranged',
    'in a 2x2 grid. Choose the ONE picture that the word names.',
    '',
    ageVocabLine(ageYears),
    '',
    'Match the most ordinary, concrete depiction of the word among the four pictures.',
    'Prefer the everyday meaning someone your age would actually know.',
    'Do not stretch to rare, metaphorical, technical, or secondary senses.',
    '',
    knowLine,
    'Do not use adult encyclopedic knowledge to rescue an uncommon word.',
    'If two pictures seem related, pick the one that best fits the spoken word alone.',
    replyFooter(version),
  ].join('\n');
}

/** Light prompt for young personas (age ≤ VOCAB_YOUNG_AGE_MAX). */
export function buildSystemPromptYoung(
  ageYears: number | null = null,
  version: VocabPromptVersion = resolveVocabPromptVersion(),
): string {
  const knowLine =
    version === 'v4'
      ? 'If the word is uncommon or you would not know it at your age, answer LOW.'
      : 'If the word is uncommon or you would not know it at your age, answer NO for knowing it.';
  return [
    'You are taking a picture-vocabulary test, one item at a time.',
    'You hear a single word (given to you as text) and see four pictures arranged',
    'in a 2x2 grid. Choose the ONE picture that the word names.',
    '',
    ageVocabLine(ageYears),
    '',
    'Pick the picture that matches the word in the most ordinary way for your age.',
    knowLine,
    'Do not invent a stretch.',
    replyFooter(version),
  ].join('\n');
}

/** Static defaults (age unset) for re-exports / external consumers. */
export const SYSTEM_PROMPT_CHECKLIST = buildSystemPromptChecklist(null);
export const SYSTEM_PROMPT_YOUNG = buildSystemPromptYoung(null);

/** Default for non-persona / older runs. */
export const SYSTEM_PROMPT = SYSTEM_PROMPT_CHECKLIST;

/** Ages ≤ this get the young (light) prompt. */
export const VOCAB_YOUNG_AGE_MAX = 8;

/** Soft easiness weights for graded confidence (and v3 YES/NO mapped). */
export const VOCAB_CONFIDENCE_WEIGHT: Record<'high' | 'med' | 'low', number> = {
  high: 1,
  med: 0.5,
  low: 0.25,
};

export function resolvePersonaAgeYears(): number | null {
  let raw: unknown;
  try {
    if (typeof Cypress !== 'undefined' && typeof Cypress.expose === 'function') {
      raw = Cypress.expose('QA_PERSONA_AGE_YEARS');
    }
  } catch {
    /* not in Cypress */
  }
  if (raw == null || raw === '') {
    raw = typeof process !== 'undefined' ? process.env.QA_PERSONA_AGE_YEARS : undefined;
  }
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function useYoungVocabPrompt(ageYears: number | null = resolvePersonaAgeYears()): boolean {
  return ageYears != null && ageYears <= VOCAB_YOUNG_AGE_MAX;
}

export function vocabSystemPrompt(ageYears: number | null = resolvePersonaAgeYears()): string {
  const version = resolveVocabPromptVersion();
  return useYoungVocabPrompt(ageYears)
    ? buildSystemPromptYoung(ageYears, version)
    : buildSystemPromptChecklist(ageYears, version);
}

/** User text: word reminder + two-token reply format. */
export function vocabUserText(
  transcript: string | null,
  _ageYears: number | null = resolvePersonaAgeYears(),
): string {
  const version = resolveVocabPromptVersion();
  const base =
    version === 'v4'
      ? 'Reply with exactly two tokens: digit (1-4) then HIGH, MED, or LOW (would a child your age know this word?). Example: "2 HIGH" or "3 MED" or "1 LOW".'
      : 'Reply with exactly two tokens: digit (1-4) then YES or NO (know this word at your age?). Example: "2 YES" or "3 NO".';
  const w = String(transcript ?? '').trim();
  if (!w) return base;
  return `${base} The word is: "${w}".`;
}

export type VocabConfidence = 'high' | 'med' | 'low';

export type VocabReplyParse = {
  /** Zero-based choice from the model (before any agent-side randomization). */
  index: number | null;
  /**
   * true = knows (YES / HIGH / MED), false = does not (NO / LOW),
   * null = not stated (digit-only legacy).
   */
  knowsWord: boolean | null;
  /** Graded confidence when present (v4, or mapped from v3 YES/NO). */
  confidence: VocabConfidence | null;
};

/**
 * Parse `DIGIT YES|NO`, `DIGIT HIGH|MED|LOW` (order flexible), or digit-only.
 */
export function parseVocabReply(raw: string): VocabReplyParse {
  const text = String(raw ?? '').trim();
  const digitMatch = text.match(/[1-4]/);
  const index = digitMatch ? Number(digitMatch[0]) - 1 : null;

  const graded = text.match(/\b(high|med|medium|mid|low)\b/i);
  if (graded) {
    const g = graded[1].toLowerCase();
    const confidence: VocabConfidence =
      g === 'high' ? 'high' : g === 'low' ? 'low' : 'med';
    return {
      index,
      confidence,
      knowsWord: confidence !== 'low',
    };
  }

  const knowsMatch = text.match(/\b(yes|no)\b/i);
  if (knowsMatch) {
    const yes = knowsMatch[1].toLowerCase() === 'yes';
    return {
      index,
      knowsWord: yes,
      confidence: yes ? 'high' : 'low',
    };
  }

  return { index, knowsWord: null, confidence: null };
}

/** Parse the model's 1-4 position reply into a zero-based choice index, or null. */
export function parseChoiceIndex(raw: string): number | null {
  return parseVocabReply(raw).index;
}

/**
 * If the model says LOW / NO (would not know the word at age), replace the
 * choice with a uniform random 0..3. HIGH / MED / YES / digit-only keep the
 * model's index.
 */
export function applyKnowsWordPolicy(
  parsed: VocabReplyParse,
  rng: () => number = Math.random,
): {
  index: number | null;
  randomized: boolean;
  knowsWord: boolean | null;
  confidence: VocabConfidence | null;
} {
  const low =
    parsed.confidence === 'low' ||
    (parsed.confidence == null && parsed.knowsWord === false);
  if (low) {
    return {
      index: Math.floor(rng() * 4),
      randomized: true,
      knowsWord: false,
      confidence: parsed.confidence ?? 'low',
    };
  }
  return {
    index: parsed.index,
    randomized: false,
    knowsWord: parsed.knowsWord,
    confidence: parsed.confidence,
  };
}

/** Map confidence (or YES/NO) to a soft easiness in [chance, 1]. */
export function confidenceToSoftP(
  confidence: VocabConfidence | null,
  chance = 0.25,
): number | null {
  if (confidence == null) return null;
  if (confidence === 'low') return chance;
  return VOCAB_CONFIDENCE_WEIGHT[confidence];
}
