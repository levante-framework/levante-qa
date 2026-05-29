import type { Action } from '../../support/tasks/types';
import type { VLMRequest, VLMResult } from '../../support/tasks/types';
import { askOpenAI } from './openai';
import { askAnthropic } from './anthropic';
import { askGemini } from './gemini';

export type { VLMRequest, VLMResult };

/**
 * A VLM provider client: takes a screenshot + system prompt and returns the
 * chosen Action. Adding a new provider is a single file that exports a function
 * of this shape, plus one line in the dispatch table below.
 */
export type VLMClient = (req: VLMRequest) => Promise<Action>;

const CLIENTS: Record<string, VLMClient> = {
  openai: askOpenAI,
  anthropic: askAnthropic,
  gemini: askGemini,
};

/**
 * Parse a raw model text response into a normalized Action. Defaults to
 * 'CONTINUE' when the model is unclear, which is the safe no-progress action on
 * non-trial screens.
 */
export function parseAction(raw: string): Action {
  const text = raw.trim().toUpperCase();
  if (/\bLEFT\b/.test(text)) return 'LEFT';
  if (/\bRIGHT\b/.test(text)) return 'RIGHT';
  if (/\bCONTINUE\b/.test(text)) return 'CONTINUE';
  return 'CONTINUE';
}

/**
 * Dispatch a request to the configured provider. Latency is measured by the
 * caller (the askVLM cypress task) around this call only.
 */
export async function askVLM(provider: string, req: VLMRequest): Promise<Action> {
  const client = CLIENTS[provider];
  if (!client) {
    throw new Error(
      `Unknown VLM_PROVIDER "${provider}". Expected one of: ${Object.keys(CLIENTS).join(', ')}.`,
    );
  }
  return client(req);
}
