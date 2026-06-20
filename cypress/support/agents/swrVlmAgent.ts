import type { VLMResult } from '../tasks/types';

export const SYSTEM_PROMPT = [
  'You are taking SWR (Single Word Recognition).',
  'On each trial you see one letter string and decide if it is a real word.',
  'Choose LEFT for "not a real word" and RIGHT for "real word".',
  '',
  'Respond with ONLY one word: LEFT or RIGHT.',
  'Do not add punctuation or explanation.',
].join('\n');

export interface SwrVlmDecision {
  lr: 'left' | 'right' | null;
  raw: string;
  latencyMs: number;
}

export function parseLr(raw: string): 'left' | 'right' | null {
  const text = raw.trim().toUpperCase();
  if (/\bLEFT\b/.test(text)) return 'left';
  if (/\bRIGHT\b/.test(text)) return 'right';
  return null;
}

export const swrVlmAgent = {
  decide(
    pngBase64: string,
    transcript: string | null = null,
    userText = 'Reply with ONLY LEFT or RIGHT.',
  ): Cypress.Chainable<SwrVlmDecision> {
    return cy
      .task<VLMResult>('askVLM', {
        pngBase64,
        systemPrompt: SYSTEM_PROMPT,
        taskId: 'swr',
        transcript,
        userText,
      })
      .then((result: VLMResult): SwrVlmDecision => ({
        lr: parseLr(result.raw),
        raw: result.raw,
        latencyMs: result.latencyMs,
      }));
  },
};

export default swrVlmAgent;
