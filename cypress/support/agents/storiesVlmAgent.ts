import type { VLMResult } from '../tasks/types';

/**
 * System prompt for the Stories (Theory of Mind) task. Exported so the
 * node-side provider clients reuse the exact same instruction text, keeping
 * comparisons fair across providers.
 *
 * The model is given the story so far (the narration it would have heard) and
 * the current question, and sees a screenshot with 2–4 numbered picture
 * choices. It must reason about the characters' beliefs/emotions and pick the
 * matching picture by position. The number of choices varies per item, so the
 * user turn states how many are present.
 */
export const SYSTEM_PROMPT = [
  'You are taking a "Theory of Mind" stories test. You are read a short story,',
  'then asked a question about it — often about what a character THINKS, FEELS,',
  'or BELIEVES (which may differ from what is actually true), where they will',
  'look for something, or a simple yes/no about the story.',
  '',
  'You are given the story so far and the current question as text, plus a',
  'screenshot showing the answer choices as pictures arranged left to right and',
  'numbered from 1. The pictures may be places, objects, emotion faces, or',
  'yes/no symbols. Choose the ONE picture that correctly answers the question,',
  'reasoning from the story — not from what you personally would know.',
  '',
  'Respond with ONLY the single digit (the position number) of the correct',
  'picture. Do not add words, punctuation, or explanation.',
].join('\n');

export interface StoriesVlmDecision {
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
 * VLM-in-the-loop agent for Stories. Sends the screenshot (base64 PNG) plus a
 * text "audio channel" — the accumulated story narration and the current
 * question — to the configured provider via the askVLM cypress task, and
 * returns the chosen position as a zero-based index plus call latency.
 */
export const storiesVlmAgent = {
  decide(
    pngBase64: string,
    storyContext: string | null,
    question: string | null,
    nChoices: number,
  ): Cypress.Chainable<StoriesVlmDecision> {
    const transcript = [
      storyContext ? `Story so far: ${storyContext}` : null,
      question ? `Question: ${question}` : null,
    ]
      .filter(Boolean)
      .join('\n\n');
    const userText =
      `There are ${nChoices} picture choices, numbered 1 to ${nChoices} from left to right. ` +
      'Reply with ONLY the digit of the picture that answers the question.';

    return cy
      .task<VLMResult>('askVLM', {
        pngBase64,
        systemPrompt: SYSTEM_PROMPT,
        taskId: 'stories',
        transcript: transcript || null,
        userText,
      })
      .then((result: VLMResult): StoriesVlmDecision => ({
        index: parseChoiceIndex(result.raw),
        raw: result.raw,
        latencyMs: result.latencyMs,
      }));
  },
};

export default storiesVlmAgent;
