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

/** Shared reply / grid footer (v3 two-token format). */
const REPLY_FOOTER = [
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

/**
 * Build older / default checklist (ages > VOCAB_YOUNG_AGE_MAX).
 * Exported constant uses null age (generic school-age line) for static imports.
 */
export function buildSystemPromptChecklist(ageYears: number | null = null): string {
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
    'If the word is uncommon or outside your age vocabulary, answer NO for knowing it.',
    'Do not use adult encyclopedic knowledge to rescue an uncommon word.',
    'If two pictures seem related, pick the one that best fits the spoken word alone.',
    REPLY_FOOTER,
  ].join('\n');
}

/** Light prompt for young personas (age ≤ VOCAB_YOUNG_AGE_MAX). */
export function buildSystemPromptYoung(ageYears: number | null = null): string {
  return [
    'You are taking a picture-vocabulary test, one item at a time.',
    'You hear a single word (given to you as text) and see four pictures arranged',
    'in a 2x2 grid. Choose the ONE picture that the word names.',
    '',
    ageVocabLine(ageYears),
    '',
    'Pick the picture that matches the word in the most ordinary way for your age.',
    'If the word is uncommon or you would not know it at your age, answer NO for knowing it.',
    'Do not invent a stretch.',
    REPLY_FOOTER,
  ].join('\n');
}

/** Static defaults (age unset) for re-exports / external consumers. */
export const SYSTEM_PROMPT_CHECKLIST = buildSystemPromptChecklist(null);
export const SYSTEM_PROMPT_YOUNG = buildSystemPromptYoung(null);

/** Default for non-persona / older runs. */
export const SYSTEM_PROMPT = SYSTEM_PROMPT_CHECKLIST;

/** Ages ≤ this get the young (light) prompt. */
export const VOCAB_YOUNG_AGE_MAX = 8;

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
  return useYoungVocabPrompt(ageYears)
    ? buildSystemPromptYoung(ageYears)
    : buildSystemPromptChecklist(ageYears);
}

/** User text: word reminder + two-token reply format. */
export function vocabUserText(
  transcript: string | null,
  _ageYears: number | null = resolvePersonaAgeYears(),
): string {
  const base =
    'Reply with exactly two tokens: digit (1-4) then YES or NO (know this word at your age?). Example: "2 YES" or "3 NO".';
  const w = String(transcript ?? '').trim();
  if (!w) return base;
  return `${base} The word is: "${w}".`;
}

export type VocabReplyParse = {
  /** Zero-based choice from the model (before any agent-side randomization). */
  index: number | null;
  /** true = YES, false = NO, null = not stated (digit-only legacy). */
  knowsWord: boolean | null;
};

/**
 * Parse `DIGIT YES|NO` (order flexible) or legacy digit-only replies.
 */
export function parseVocabReply(raw: string): VocabReplyParse {
  const text = String(raw ?? '').trim();
  const knowsMatch = text.match(/\b(yes|no)\b/i);
  const knowsWord = knowsMatch ? knowsMatch[1].toLowerCase() === 'yes' : null;
  const digitMatch = text.match(/[1-4]/);
  const index = digitMatch ? Number(digitMatch[0]) - 1 : null;
  return { index, knowsWord };
}

/** Parse the model's 1-4 position reply into a zero-based choice index, or null. */
export function parseChoiceIndex(raw: string): number | null {
  return parseVocabReply(raw).index;
}

/**
 * If the model says it would not know the word at age, replace the choice with
 * a uniform random 0..3. Digit-only / YES keep the model's index.
 */
export function applyKnowsWordPolicy(
  parsed: VocabReplyParse,
  rng: () => number = Math.random,
): { index: number | null; randomized: boolean; knowsWord: boolean | null } {
  if (parsed.knowsWord === false) {
    return {
      index: Math.floor(rng() * 4),
      randomized: true,
      knowsWord: false,
    };
  }
  return {
    index: parsed.index,
    randomized: false,
    knowsWord: parsed.knowsWord,
  };
}
