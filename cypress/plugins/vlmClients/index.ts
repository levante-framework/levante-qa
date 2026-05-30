import type { Action } from '../../support/tasks/types';
import type { VLMRequest, VLMResult } from '../../support/tasks/types';
import { askOpenAI } from './openai';
import { askAnthropic } from './anthropic';
import { askGemini } from './gemini';

export type { VLMRequest, VLMResult };

/**
 * A VLM provider client: takes a screenshot + system prompt and returns the
 * RAW model text. Normalization (e.g. into a Hearts & Flowers Action, or an
 * EGMA number) is the caller's job, so the same clients serve every task.
 * Adding a new provider is a single file that exports a function of this shape,
 * plus one line in the dispatch table below.
 */
export type VLMClient = (req: VLMRequest) => Promise<string>;

const CLIENTS: Record<string, VLMClient> = {
  openai: askOpenAI,
  anthropic: askAnthropic,
  gemini: askGemini,
};

/**
 * Build the user-turn text. When a narration transcript is present it is added
 * as an explicit "audio channel", mirroring what a multimodal agent with ears
 * would hear — without the noise floor of a real speech-to-text step.
 */
export function buildUserText(transcript?: string | null, instruction?: string | null): string {
  const base = instruction?.trim() || 'Which action? Reply with one word.';
  const text = transcript?.trim();
  if (text) {
    return `${base}\nNarration currently played aloud: "${text}"`;
  }
  return base;
}

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
 * Dispatch a request to the configured provider, returning the raw model text.
 * Latency is measured by the caller (the askVLM cypress task) around this call.
 */
export async function askVLM(provider: string, req: VLMRequest): Promise<string> {
  const client = CLIENTS[provider];
  if (!client) {
    throw new Error(
      `Unknown VLM_PROVIDER "${provider}". Expected one of: ${Object.keys(CLIENTS).join(', ')}.`,
    );
  }
  return client(req);
}
