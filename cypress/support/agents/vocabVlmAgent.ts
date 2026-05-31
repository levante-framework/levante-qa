import type { VLMResult } from '../tasks/types';

/**
 * System prompt for the Vocab picture-vocabulary task. Exported so the
 * node-side provider clients reuse the exact same instruction text, keeping
 * comparisons fair across providers.
 *
 * The model hears a word (given as the narration transcript) and sees four
 * pictures in a 2x2 grid. It must pick the picture that matches the word by
 * its grid position. We number the choices in DOM/reading order
 * (1 = top-left, 2 = top-right, 3 = bottom-left, 4 = bottom-right) — the same
 * order the spec clicks — so a position reply maps directly to a choice index.
 */
export const SYSTEM_PROMPT = [
  'You are taking a picture-vocabulary test, one item at a time.',
  'You hear a single word (given to you as text) and see four pictures arranged',
  'in a 2x2 grid. Choose the ONE picture that the word names.',
  '',
  'The pictures are numbered by position:',
  '  1 = top-left      2 = top-right',
  '  3 = bottom-left   4 = bottom-right',
  '',
  'Respond with ONLY the single digit (1, 2, 3, or 4) of the matching picture.',
  'Do not add words, punctuation, or explanation.',
].join('\n');

export interface VocabVlmDecision {
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
 * VLM-in-the-loop agent for Vocab. Sends the screenshot (base64 PNG) plus the
 * narration transcript (the spoken word) to the configured provider via the
 * askVLM cypress task, and returns the chosen position as a zero-based index
 * plus the provider-call latency.
 */
export const vocabVlmAgent = {
  decide(
    pngBase64: string,
    transcript: string | null = null,
    userText = 'Reply with ONLY the digit (1-4) of the picture that matches the word.',
  ): Cypress.Chainable<VocabVlmDecision> {
    return cy
      .task<VLMResult>('askVLM', {
        pngBase64,
        systemPrompt: SYSTEM_PROMPT,
        taskId: 'vocab',
        transcript,
        userText,
      })
      .then((result: VLMResult): VocabVlmDecision => ({
        index: parseChoiceIndex(result.raw),
        raw: result.raw,
        latencyMs: result.latencyMs,
      }));
  },
};

export default vocabVlmAgent;
