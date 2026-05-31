import type { VLMResult } from '../tasks/types';

/**
 * System prompt for the Matrix Reasoning task. Exported so the node-side
 * provider clients reuse the exact same instruction text, keeping comparisons
 * fair.
 *
 * The model sees a matrix (a grid of pictures following a visual pattern, with
 * one cell missing) and a row of candidate tiles below it. It must pick the tile
 * that correctly completes the pattern. We number the choices 1..N in DOM/reading
 * order (left to right) — the order the spec clicks.
 */
export const SYSTEM_PROMPT = [
  'You are solving a matrix-reasoning puzzle, one item at a time.',
  'At the top is a MATRIX: a grid of pictures that follow a visual pattern,',
  'with one cell left blank (often a question mark). Below it are candidate',
  'tiles, numbered 1, 2, 3, 4 from left to right. Exactly ONE tile correctly',
  'completes the pattern in the blank cell — figure out the rule (how the',
  'pictures change across rows and columns) and choose that tile.',
  '',
  'Respond with ONLY the single digit (1, 2, 3, or 4) of the correct tile.',
  'Do not add words, punctuation, or explanation.',
].join('\n');

export interface MatrixReasoningVlmDecision {
  /** Zero-based choice index parsed from the model output, or null. */
  index: number | null;
  /** The raw model text, kept for logging/debugging. */
  raw: string;
  latencyMs: number;
}

/** Parse the model's 1..N reply into a zero-based choice index, or null. */
export function parseChoiceIndex(raw: string): number | null {
  const m = raw.match(/[1-9]/);
  return m ? Number(m[0]) - 1 : null;
}

/**
 * VLM-in-the-loop agent for Matrix Reasoning. Sends the screenshot (base64 PNG)
 * plus the narration transcript to the configured provider via the askVLM
 * cypress task, and returns the chosen position as a zero-based index plus the
 * provider-call latency.
 */
export const matrixReasoningVlmAgent = {
  decide(
    pngBase64: string,
    transcript: string | null = null,
    nChoices = 4,
    userText?: string,
  ): Cypress.Chainable<MatrixReasoningVlmDecision> {
    const text =
      userText ??
      `Reply with ONLY the digit (1-${nChoices}) of the tile that completes the matrix pattern.`;
    return cy
      .task<VLMResult>('askVLM', {
        pngBase64,
        systemPrompt: SYSTEM_PROMPT,
        taskId: 'matrix_reasoning',
        transcript,
        userText: text,
      })
      .then((result: VLMResult): MatrixReasoningVlmDecision => ({
        index: parseChoiceIndex(result.raw),
        raw: result.raw,
        latencyMs: result.latencyMs,
      }));
  },
};

export default matrixReasoningVlmAgent;
