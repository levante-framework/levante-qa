import type { VLMResult } from '../tasks/types';

/**
 * System prompt for the EGMA math task. Exported so the node-side provider
 * clients reuse the exact same instruction text, keeping comparisons fair
 * across providers.
 */
export const SYSTEM_PROMPT = [
  'You are taking an early-grade math (EGMA) test, one item at a time.',
  'You are shown a screenshot of a single item, and sometimes the narration text',
  'that is played aloud. Decide the single number you would tap to answer.',
  '',
  'Item types:',
  '- Number identification: the narration says e.g. "Choose the 7". Answer that number.',
  '- Number comparison: two numbers are shown. Answer the LARGER number unless the',
  '  narration explicitly asks for the smaller one.',
  '- Arithmetic: an expression like "2+3", "12-4", or "1x5" is shown. Answer the result.',
  '- Missing number: a sequence with a blank like "5, 10, 15, _" is shown. Answer the',
  '  number that belongs in the blank.',
  '',
  'Respond with ONLY the number (digits, optionally a decimal point or minus sign).',
  'Do not add words, units, or punctuation.',
].join('\n');

export interface EgmaVlmDecision {
  /** The numeric answer parsed from the model output, or null if unparseable. */
  value: number | null;
  /** The raw model text, kept for logging/debugging. */
  raw: string;
  latencyMs: number;
}

/** Extract the first signed/decimal number from raw model text. */
export function parseNumber(raw: string): number | null {
  const m = raw.match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/**
 * VLM-in-the-loop agent for EGMA. Sends the screenshot (base64 PNG) plus any
 * narration transcript to the configured provider via the askVLM cypress task,
 * and returns the parsed numeric answer plus the provider-call latency.
 */
export const egmaVlmAgent = {
  decide(pngBase64: string, transcript: string | null = null): Cypress.Chainable<EgmaVlmDecision> {
    return cy
      .task<VLMResult>('askVLM', {
        pngBase64,
        systemPrompt: SYSTEM_PROMPT,
        transcript,
        userText: 'Reply with ONLY the number you would tap. No words.',
      })
      .then((result: VLMResult): EgmaVlmDecision => ({
        value: parseNumber(result.raw),
        raw: result.raw,
        latencyMs: result.latencyMs,
      }));
  },
};

export default egmaVlmAgent;
