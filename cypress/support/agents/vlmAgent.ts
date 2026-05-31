import type { Action, VLMResult } from '../tasks/types';

/**
 * System prompt shared across all providers. Exported so the node-side provider
 * clients reuse the exact same instruction text, keeping comparisons fair.
 */
export const SYSTEM_PROMPT = [
  'You are playing the Hearts & Flowers cognitive task.',
  'You are shown a screenshot of a single trial. A heart or a flower appears on',
  'the LEFT or RIGHT side of the screen, with a response button on each side.',
  '',
  'Rules:',
  '- HEARTS block: press the button on the SAME side as the heart.',
  '- FLOWERS block: press the button on the OPPOSITE side from the flower.',
  '- MIXED block: if it is a heart press the SAME side; if it is a flower press the OPPOSITE side.',
  '- If the screen shows instructions, feedback, or a fixation cross with no',
  '  active response buttons, choose CONTINUE.',
  '',
  'You may also be given the narration text currently played aloud. Treat it as',
  'what a sighted, hearing child would be told, and use it as extra context.',
  '',
  'Respond with EXACTLY one word, one of: LEFT, RIGHT, CONTINUE.',
  'Do not add any explanation or punctuation.',
].join('\n');

export interface VLMDecision {
  action: Action;
  latencyMs: number;
}

/**
 * VLM-in-the-loop agent. Sends the screenshot (base64 PNG) to the configured
 * provider via the askVLM cypress task and returns the chosen action plus the
 * provider-call latency.
 *
 * Returns a Cypress.Chainable, which is thenable and can be awaited within a
 * spec via `.then(...)`.
 */
export const vlmAgent = {
  decide(pngBase64: string, transcript: string | null = null): Cypress.Chainable<VLMDecision> {
    return cy
      .task<VLMResult>('askVLM', { pngBase64, systemPrompt: SYSTEM_PROMPT, taskId: 'hearts_and_flowers', transcript })
      .then((result: VLMResult): VLMDecision => ({
        action: result.action,
        latencyMs: result.latencyMs,
      }));
  },
};

export default vlmAgent;
