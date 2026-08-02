import type { VLMResult } from '../tasks/types';

/**
 * System prompt for the TROG (Test for Reception of Grammar) task. Exported so
 * the node-side provider clients reuse the exact same instruction text, keeping
 * comparisons fair across providers.
 *
 * The model hears a sentence (given as the narration transcript) and sees four
 * pictures in a 2x2 grid. It must pick the picture whose scene matches the
 * sentence's meaning — the discrimination is grammatical (word order, negation,
 * who-does-what-to-whom, prepositions, relative clauses), so the distractors
 * usually depict the same objects in a different relationship. We number the
 * choices by grid position (1 = top-left ... 4 = bottom-right) — the order the
 * spec clicks.
 */
export const SYSTEM_PROMPT = [
  'You are taking a grammar-comprehension test, one item at a time.',
  'You hear a sentence (given to you as text) and see four pictures arranged',
  'in a 2x2 grid. Choose the ONE picture whose scene matches the meaning of the',
  'sentence. Distractors usually show the same objects in a different relationship.',
  '',
  'Before choosing, silently check:',
  '  1) Who is doing what to whom? (do not reverse agent/patient)',
  '  2) Negation scope — e.g. "the horse but not the boy is standing" means the',
  '     horse stands and the boy does not; both must match.',
  '  3) Spatial words literally (in/on/above/below/beside).',
  '  4) Size/comparative adjectives from the picture (tall/long/bigger), not metaphor.',
  '  5) Relative clauses and embeddings: which noun the clause modifies.',
  '',
  'The pictures are numbered by position:',
  '  1 = top-left      2 = top-right',
  '  3 = bottom-left   4 = bottom-right',
  '',
  'Respond with ONLY the single digit (1, 2, 3, or 4) of the matching picture.',
  'Do not add words, punctuation, or explanation.',
].join('\n');

/** Extra user-text emphasis when the transcript looks structure-sensitive. */
export function trogUserText(transcript: string | null): string {
  const base = 'Reply with ONLY the digit (1-4) of the picture that matches the sentence.';
  const t = String(transcript ?? '').toLowerCase();
  const hints: string[] = [];
  if (/\bbut not\b|\bnot\b|\bneither\b|\bno (one|body)\b/.test(t)) {
    hints.push('Attend carefully to negation: who/what is excluded.');
  }
  if (/\b(despite|although|however)\b/.test(t)) {
    hints.push('The main clause is what must match the picture; do not ignore contrast words.');
  }
  if (/\b(above|below|under|beside|behind|in front)\b/.test(t)) {
    hints.push('Match spatial relations exactly.');
  }
  if (/\b(taller|longer|bigger|smaller|shorter)\b/.test(t)) {
    hints.push('Compare sizes as shown in the pictures.');
  }
  if (/\b(chasing|pushing|following|pulling)\b/.test(t)) {
    hints.push('Do not reverse who acts on whom.');
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
    return cy
      .task<VLMResult>('askVLM', {
        pngBase64,
        systemPrompt: SYSTEM_PROMPT,
        taskId: 'trog',
        transcript,
        userText: userText ?? trogUserText(transcript),
      })
      .then((result: VLMResult): TrogVlmDecision => ({
        index: parseChoiceIndex(result.raw),
        raw: result.raw,
        latencyMs: result.latencyMs,
      }));
  },
};

export default trogVlmAgent;
