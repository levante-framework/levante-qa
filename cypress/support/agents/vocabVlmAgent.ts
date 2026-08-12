import type { VLMResult } from '../tasks/types';
import {
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_CHECKLIST,
  SYSTEM_PROMPT_YOUNG,
  VOCAB_YOUNG_AGE_MAX,
  VOCAB_CONFIDENCE_WEIGHT,
  applyKnowsWordPolicy,
  confidenceToSoftP,
  parseChoiceIndex,
  parseVocabReply,
  resolvePersonaAgeYears,
  resolveVocabPromptVersion,
  vocabSystemPrompt,
  vocabUserText,
  useYoungVocabPrompt,
  type VocabConfidence,
} from './prompts/vocabPrompts';

/**
 * VLM-in-the-loop agent for Vocab.
 *
 * Prompt text lives in `./prompts/vocabPrompts.ts` (age-conditional + v3
 * DIGIT YES|NO or v4 DIGIT HIGH|MED|LOW via QA_VOCAB_PROMPT). When the model
 * answers NO / LOW, we replace the choice with a uniform random 1–4.
 */
export {
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_CHECKLIST,
  SYSTEM_PROMPT_YOUNG,
  VOCAB_YOUNG_AGE_MAX,
  VOCAB_CONFIDENCE_WEIGHT,
  applyKnowsWordPolicy,
  confidenceToSoftP,
  parseChoiceIndex,
  parseVocabReply,
  resolvePersonaAgeYears,
  resolveVocabPromptVersion,
  vocabSystemPrompt,
  vocabUserText,
  useYoungVocabPrompt,
};

export interface VocabVlmDecision {
  /** Zero-based choice index after knows-word policy (may be randomized). */
  index: number | null;
  /** Model's digit before randomization. */
  modelIndex: number | null;
  /** YES/NO-style knows bit (HIGH/MED → true, LOW → false). */
  knowsWord: boolean | null;
  /** Graded confidence when present. */
  confidence: VocabConfidence | null;
  /** True when we overwrote the choice because confidence===low / knowsWord===false. */
  randomized: boolean;
  /** The raw model text, kept for logging/debugging. */
  raw: string;
  latencyMs: number;
}

/**
 * Sends the screenshot (base64 PNG) plus the narration transcript (the spoken
 * word) to the configured provider via the askVLM cypress task, and returns the
 * chosen position as a zero-based index plus the provider-call latency.
 */
export const vocabVlmAgent = {
  decide(
    pngBase64: string,
    transcript: string | null = null,
    userText?: string,
  ): Cypress.Chainable<VocabVlmDecision> {
    const ageYears = resolvePersonaAgeYears();
    return cy
      .task<VLMResult>('askVLM', {
        pngBase64,
        systemPrompt: vocabSystemPrompt(ageYears),
        taskId: 'vocab',
        transcript,
        userText: userText ?? vocabUserText(transcript, ageYears),
      })
      .then((result: VLMResult): VocabVlmDecision => {
        const parsed = parseVocabReply(result.raw);
        const applied = applyKnowsWordPolicy(parsed);
        return {
          index: applied.index,
          modelIndex: parsed.index,
          knowsWord: applied.knowsWord,
          confidence: applied.confidence,
          randomized: applied.randomized,
          raw: result.raw,
          latencyMs: result.latencyMs,
        };
      });
  },
};

export default vocabVlmAgent;
