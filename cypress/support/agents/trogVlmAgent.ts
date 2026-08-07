import type { VLMResult } from '../tasks/types';
import {
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_CHECKLIST,
  SYSTEM_PROMPT_YOUNG,
  TROG_YOUNG_AGE_MAX,
  parseChoiceIndex,
  resolvePersonaAgeYears,
  trogSystemPrompt,
  trogUserText,
  useYoungTrogPrompt,
} from './prompts/trogPrompts';

/**
 * VLM-in-the-loop agent for TROG.
 *
 * Prompt text lives in `./prompts/trogPrompts.ts` (age-conditional checklist vs
 * young light prompt). Re-exported here so existing imports of `SYSTEM_PROMPT`
 * keep working.
 */
export {
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_CHECKLIST,
  SYSTEM_PROMPT_YOUNG,
  TROG_YOUNG_AGE_MAX,
  parseChoiceIndex,
  resolvePersonaAgeYears,
  trogSystemPrompt,
  trogUserText,
  useYoungTrogPrompt,
};

export interface TrogVlmDecision {
  /** Zero-based choice index parsed from the model output, or null. */
  index: number | null;
  /** The raw model text, kept for logging/debugging. */
  raw: string;
  latencyMs: number;
}

/**
 * Sends the screenshot (base64 PNG) plus the narration transcript to the
 * configured provider via askVLM, and returns the chosen position as a
 * zero-based index plus the provider-call latency.
 */
export const trogVlmAgent = {
  decide(
    pngBase64: string,
    transcript: string | null = null,
    userText?: string,
  ): Cypress.Chainable<TrogVlmDecision> {
    const ageYears = resolvePersonaAgeYears();
    return cy
      .task<VLMResult>('askVLM', {
        pngBase64,
        systemPrompt: trogSystemPrompt(ageYears),
        taskId: 'trog',
        transcript,
        userText: userText ?? trogUserText(transcript, ageYears),
      })
      .then((result: VLMResult): TrogVlmDecision => ({
        index: parseChoiceIndex(result.raw),
        raw: result.raw,
        latencyMs: result.latencyMs,
      }));
  },
};

export default trogVlmAgent;
