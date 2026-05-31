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
  'sentence. Pay close attention to grammar — word order, who is doing what to',
  'whom, negation ("not"), prepositions (in/on/above/below), and clauses — the',
  'wrong pictures often show the same things in a different arrangement.',
  '',
  'The pictures are numbered by position:',
  '  1 = top-left      2 = top-right',
  '  3 = bottom-left   4 = bottom-right',
  '',
  'Respond with ONLY the single digit (1, 2, 3, or 4) of the matching picture.',
  'Do not add words, punctuation, or explanation.',
].join('\n');

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
    userText = 'Reply with ONLY the digit (1-4) of the picture that matches the sentence.',
  ): Cypress.Chainable<TrogVlmDecision> {
    return cy
      .task<VLMResult>('askVLM', {
        pngBase64,
        systemPrompt: SYSTEM_PROMPT,
        taskId: 'trog',
        transcript,
        userText,
      })
      .then((result: VLMResult): TrogVlmDecision => ({
        index: parseChoiceIndex(result.raw),
        raw: result.raw,
        latencyMs: result.latencyMs,
      }));
  },
};

export default trogVlmAgent;
