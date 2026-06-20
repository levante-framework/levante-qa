import type { VLMResult } from '../tasks/types';

export const SYSTEM_PROMPT = [
  'You are taking SRE (Sentence Reading Efficiency).',
  'Each trial shows a sentence and you decide whether it is true/acceptable.',
  'Choose LEFT for no/incorrect and RIGHT for yes/correct.',
  '',
  'Respond with ONLY one word: LEFT or RIGHT.',
  'Do not add punctuation or explanation.',
].join('\n');

export interface SreVlmDecision {
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

export const sreVlmAgent = {
  decide(
    pngBase64: string,
    transcript: string | null = null,
    userText = 'Reply with ONLY LEFT or RIGHT.',
  ): Cypress.Chainable<SreVlmDecision> {
    return cy
      .task<VLMResult>('askVLM', {
        pngBase64,
        systemPrompt: SYSTEM_PROMPT,
        taskId: 'sre',
        transcript,
        userText,
      })
      .then((result: VLMResult): SreVlmDecision => ({
        lr: parseLr(result.raw),
        raw: result.raw,
        latencyMs: result.latencyMs,
      }));
  },
};

export default sreVlmAgent;
