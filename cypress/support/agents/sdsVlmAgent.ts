import type { VLMResult } from '../tasks/types';

/**
 * System prompt for the single-select portion of Same-Different Selection.
 * Exported so the node-side provider clients reuse the exact same instruction
 * text, keeping comparisons fair across providers.
 *
 * The model sees a row of cards (shapes varying by size/color/shape/number/
 * background) and an instruction read aloud (given as text) — e.g. "Choose the
 * card with a circle" or "Which of these is similar to this one?". It picks the
 * single matching card by its position. The match (multi-select) rounds expose
 * no answer key and are not benchmarked here, so this agent only handles the
 * single-select items.
 */
export const SYSTEM_PROMPT = [
  'You are taking a card-matching test, one item at a time.',
  'You see a row of cards (simple shapes that vary in size, color, shape,',
  'number, and background) and you are told an instruction (given to you as',
  'text), for example "Choose the card with a circle" or "Which of these is the',
  'same as this one?". Choose the ONE card that the instruction asks for.',
  '',
  'The cards are numbered by position, left to right, starting at 1.',
  'Respond with ONLY the single digit (the position number) of the correct',
  'card. Do not add words, punctuation, or explanation.',
].join('\n');

export interface SdsVlmDecision {
  /** Zero-based choice index parsed from the model output, or null. */
  index: number | null;
  /** The raw model text, kept for logging/debugging. */
  raw: string;
  latencyMs: number;
}

/** Parse the model's position reply (1..n) into a zero-based choice index, or
 * null if no valid digit is present. */
export function parseChoiceIndex(raw: string): number | null {
  const m = raw.match(/[1-9]/);
  return m ? Number(m[0]) - 1 : null;
}

/**
 * VLM-in-the-loop agent for SDS single-select items. Sends the screenshot
 * (base64 PNG) plus the spoken instruction (as text) to the configured provider
 * via the askVLM cypress task, and returns the chosen position as a zero-based
 * index plus call latency.
 */
export const sdsVlmAgent = {
  decide(
    pngBase64: string,
    instruction: string | null,
    nChoices: number,
  ): Cypress.Chainable<SdsVlmDecision> {
    const userText =
      `There are ${nChoices} cards, numbered 1 to ${nChoices} from left to right. ` +
      'Reply with ONLY the digit of the card the instruction asks for.';
    return cy
      .task<VLMResult>('askVLM', {
        pngBase64,
        systemPrompt: SYSTEM_PROMPT,
        taskId: 'same_different',
        transcript: instruction,
        userText,
      })
      .then((result: VLMResult): SdsVlmDecision => ({
        index: parseChoiceIndex(result.raw),
        raw: result.raw,
        latencyMs: result.latencyMs,
      }));
  },
};

export default sdsVlmAgent;
