import type { VLMResult } from '../tasks/types';

/**
 * System prompt for the TROG (Test for Reception of Grammar) task. Exported so
 * the node-side provider clients reuse the exact same instruction text, keeping
 * comparisons fair across providers.
 *
 * Age-conditional: young personas (QA_PERSONA_AGE_YEARS ≤ 8) get a light
 * “pick the matching picture” prompt without the adult grammar checklist, so
 * panel age/θ gradients are not flattened. Older / non-persona runs keep the
 * structure checklist that fixed negation / reverse-agent / etc. misses.
 */

/** Adult grammar checklist (ages ≥ 10, and default when age unset). */
export const SYSTEM_PROMPT_CHECKLIST = [
  'You are taking a grammar-comprehension test, one item at a time.',
  'You hear a sentence (given to you as text) and see four pictures arranged',
  'in a 2x2 grid. Choose the ONE picture whose scene matches the meaning of the',
  'sentence. Distractors usually show the same objects in a different relationship.',
  '',
  'Before choosing, silently check:',
  '  1) Who is doing what to whom? (do not reverse agent/patient).',
  '     For passives ("X is chased/pushed by Y"), Y is the actor and X is acted on.',
  '  2) Negation scope — e.g. "the horse but not the boy is standing" means the',
  '     horse stands and the boy does not; both must match.',
  '  3) Spatial words literally (in/on/above/below/beside/under/beneath).',
  '  4) Comparatives ("taller/longer/bigger than X"): compare only the named pair',
  '     using sizes visible in the pictures — not metaphor or other objects.',
  '  5) Relative clauses and embeddings: which noun the clause modifies',
  '     (e.g. "the boy the dog chases" → the dog chases the boy).',
  '  6) Contrast connectives (despite/although/however/instead): the MAIN clause',
  '     (not the concessive side) must match the picture.',
  '',
  'The pictures are numbered by position:',
  '  1 = top-left      2 = top-right',
  '  3 = bottom-left   4 = bottom-right',
  '',
  'Respond with ONLY the single digit (1, 2, 3, or 4) of the matching picture.',
  'Do not add words, punctuation, or explanation.',
].join('\n');

/** Light prompt for young child personas (age ≤ 8): no silent grammar checklist. */
export const SYSTEM_PROMPT_YOUNG = [
  'You are taking a grammar-comprehension test, one item at a time.',
  'You hear a sentence (given to you as text) and see four pictures arranged',
  'in a 2x2 grid. Choose the ONE picture whose scene matches the meaning of the',
  'sentence. Distractors usually show the same objects in a different relationship.',
  '',
  'Listen to the sentence and pick the picture that matches what you understood.',
  'Do not run an adult grammar checklist — answer as this age would after hearing',
  'the sentence once.',
  '',
  'The pictures are numbered by position:',
  '  1 = top-left      2 = top-right',
  '  3 = bottom-left   4 = bottom-right',
  '',
  'Respond with ONLY the single digit (1, 2, 3, or 4) of the matching picture.',
  'Do not add words, punctuation, or explanation.',
].join('\n');

/** Default export for non-persona / older runs (preserves prior checklist behavior). */
export const SYSTEM_PROMPT = SYSTEM_PROMPT_CHECKLIST;

/** Ages ≤ this get the young (no-checklist) prompt. */
export const TROG_YOUNG_AGE_MAX = 8;

export function resolvePersonaAgeYears(): number | null {
  let raw: unknown;
  try {
    // Browser specs: allowCypressEnv is false — use Cypress.expose.
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

export function useYoungTrogPrompt(ageYears: number | null = resolvePersonaAgeYears()): boolean {
  return ageYears != null && ageYears <= TROG_YOUNG_AGE_MAX;
}

export function trogSystemPrompt(ageYears: number | null = resolvePersonaAgeYears()): string {
  return useYoungTrogPrompt(ageYears) ? SYSTEM_PROMPT_YOUNG : SYSTEM_PROMPT_CHECKLIST;
}

/**
 * Extra user-text emphasis when the transcript looks structure-sensitive.
 * Young personas get no structure hints (base digit instruction only).
 */
export function trogUserText(
  transcript: string | null,
  ageYears: number | null = resolvePersonaAgeYears(),
): string {
  const base = 'Reply with ONLY the digit (1-4) of the picture that matches the sentence.';
  if (useYoungTrogPrompt(ageYears)) return base;

  const t = String(transcript ?? '').toLowerCase();
  const hints: string[] = [];
  if (/\bbut not\b|\bnot\b|\bneither\b|\bno (one|body)\b/.test(t)) {
    hints.push('Attend carefully to negation: who/what is excluded.');
  }
  if (/\b(despite|although|however|instead)\b/.test(t)) {
    hints.push(
      'Match the main clause after the contrast word; do not let the concessive side override it.',
    );
  }
  if (/\b(above|below|under|beneath|beside|behind|in front)\b/.test(t)) {
    hints.push('Match spatial relations exactly.');
  }
  if (/\b(taller|longer|bigger|smaller|shorter)\b/.test(t)) {
    hints.push('Compare only the named pair using pictured sizes.');
  }
  if (/\bis (chased|pushed|followed|pulled) by\b/.test(t)) {
    hints.push('Passive: the noun after "by" is the actor.');
  } else if (/\b(chasing|pushing|following|pulling|chases|pushes|follows)\b/.test(t)) {
    hints.push('Do not reverse who acts on whom.');
  }
  if (/\bthe \w+ the \w+ (chases|pushes|follows|is in|is on)\b/.test(t)) {
    hints.push('Embedded clause: resolve which noun is agent vs patient carefully.');
  }
  if (!hints.length) return base;
  return `${base} ${hints.join(' ')}`;
}

export interface TrogVlmDecision {
  /** Zero-based choice index parsed from the model output, or null. */
  index: number | null;
  /** The raw model text, kept for logging/debugging. */
  raw: string;
  latencyMs: number;
}

/** Parse the model's 1-4 position reply into a zero-based choice index, or
 * null if no valid position is present. */
export function parseChoiceIndex(raw: string): number | null {
  const m = raw.match(/[1-4]/);
  return m ? Number(m[0]) - 1 : null;
}

/**
 * VLM-in-the-loop agent for TROG. Sends the screenshot (base64 PNG) plus the
 * narration transcript (the spoken sentence) to the configured provider via the
 * askVLM cypress task, and returns the chosen position as a zero-based index
 * plus the provider-call latency.
 */
export const trogVlmAgent = {
  decide(
    pngBase64: string,
    transcript: string | null = null,
    userText?: string,
  ): Cypress.Chainable<TrogVlmDecision> {
    const ageYears = resolvePersonaAgeYears();
    return cy
      .task<VLMResult>('askVLM', {
        pngBase64,
        systemPrompt: trogSystemPrompt(ageYears),
        taskId: 'trog',
        transcript,
        userText: userText ?? trogUserText(transcript, ageYears),
      })
      .then((result: VLMResult): TrogVlmDecision => ({
        index: parseChoiceIndex(result.raw),
        raw: result.raw,
        latencyMs: result.latencyMs,
      }));
  },
};

export default trogVlmAgent;
