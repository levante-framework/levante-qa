import type { VLMResult } from '../tasks/types';

/**
 * System prompt for the Mental Rotation task. Exported so the node-side provider
 * clients reuse the exact same instruction text, keeping comparisons fair.
 *
 * The model sees a target shape and two candidate shapes below it. Exactly one
 * candidate is the SAME shape as the target, just rotated; the other is its
 * mirror image. It must pick the rotation (not the mirror) by position. We
 * number the choices 1..2 in DOM/reading order (left to right) — the order the
 * spec clicks.
 */
export const SYSTEM_PROMPT = [
  'You are taking a mental-rotation test, one item at a time.',
  'At the top you see a TARGET shape. Below it are two candidate shapes,',
  'numbered 1 and 2 from left to right. Exactly ONE candidate is the SAME shape',
  'as the target, just turned/rotated to a different angle. The OTHER candidate',
  'is a mirror image (a flipped, back-to-front version) — that one is WRONG.',
  'Choose the candidate that is the target rotated, not mirrored.',
  '',
  'Respond with ONLY the single digit (1 or 2) of the matching shape.',
  'Do not add words, punctuation, or explanation.',
].join('\n');

export interface MentalRotationVlmDecision {
  /** Zero-based choice index parsed from the model output, or null. */
  index: number | null;
  /** The raw model text, kept for logging/debugging. */
  raw: string;
  latencyMs: number;
}

/** Parse the model's 1/2 reply into a zero-based choice index, or null. */
export function parseChoiceIndex(raw: string): number | null {
  const m = raw.match(/[12]/);
  return m ? Number(m[0]) - 1 : null;
}

/**
 * VLM-in-the-loop agent for Mental Rotation. Sends the screenshot (base64 PNG)
 * plus the narration transcript to the configured provider via the askVLM
 * cypress task, and returns the chosen position as a zero-based index plus the
 * provider-call latency.
 */
export const mentalRotationVlmAgent = {
  decide(
    pngBase64: string,
    transcript: string | null = null,
    userText = 'Reply with ONLY the digit (1 or 2) of the shape that is the target rotated (not mirrored).',
  ): Cypress.Chainable<MentalRotationVlmDecision> {
    return cy
      .task<VLMResult>('askVLM', {
        pngBase64,
        systemPrompt: SYSTEM_PROMPT,
        transcript,
        userText,
      })
      .then((result: VLMResult): MentalRotationVlmDecision => ({
        index: parseChoiceIndex(result.raw),
        raw: result.raw,
        latencyMs: result.latencyMs,
      }));
  },
};

export default mentalRotationVlmAgent;
