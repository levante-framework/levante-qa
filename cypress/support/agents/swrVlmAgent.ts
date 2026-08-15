import type { VLMResult } from '../tasks/types';
import {
  applyChildPlayPolicy,
  parseSwrReply,
  resolvePersonaAgeYears,
  resolveSwrChildPlay,
  resolveSwrPromptVersion,
  swrSystemPrompt,
  swrUserText,
  type SwrConfidence,
  type SwrReplyParse,
} from './prompts/swrPrompts';

export {
  applyChildPlayPolicy,
  parseSwrReply,
  resolveSwrChildPlay,
  resolveSwrPromptVersion,
  SWR_CONFIDENCE_WEIGHT,
  type SwrConfidence,
  type SwrReplyParse,
} from './prompts/swrPrompts';

/** @deprecated use swrSystemPrompt() — kept for any external imports of SYSTEM_PROMPT */
export const SYSTEM_PROMPT = swrSystemPrompt(null);

export interface SwrVlmDecision {
  lr: 'left' | 'right' | null;
  raw: string;
  latencyMs: number;
  lexical: 'real' | 'pseudo' | null;
  confidence: SwrConfidence | null;
  /** HARDNESS 1-5 when QA_SWR_PROMPT=v3. */
  hardness: number | null;
  pChild: number | null;
  randomized: boolean;
}

export function parseLr(raw: string): 'left' | 'right' | null {
  return parseSwrReply(raw).lr;
}

export const swrVlmAgent = {
  /**
   * @param letterString — OCR/DOM stimulus when known; preferred over audio for v2.
   */
  decide(
    pngBase64: string,
    transcript: string | null = null,
    letterString: string | null = null,
  ): Cypress.Chainable<SwrVlmDecision> {
    const ageYears = resolvePersonaAgeYears();
    const version = resolveSwrPromptVersion();
    const wordHint = String(letterString || transcript || '').trim() || null;
    // v2/v3 difficulty is text lexicality+score; skip screenshots (Gemini multimodal hangs).
    const image =
      (version === 'v2' || version === 'v3') && wordHint ? '' : pngBase64;
    return cy.task<number | null>('lookupAoa', { word: wordHint }).then((aoaYears) =>
      cy
        .task<VLMResult>('askVLM', {
          pngBase64: image,
          systemPrompt: swrSystemPrompt(ageYears),
          taskId: 'swr',
          transcript: wordHint,
          userText: swrUserText(wordHint, ageYears, aoaYears),
        })
        .then((result: VLMResult): SwrVlmDecision => {
          const parsed: SwrReplyParse = parseSwrReply(result.raw);
          const applied =
            (version === 'v2' || version === 'v3') && resolveSwrChildPlay()
              ? applyChildPlayPolicy(parsed)
              : { ...parsed, randomized: false };
          return {
            lr: applied.lr,
            raw: result.raw,
            latencyMs: result.latencyMs,
            lexical: applied.lexical,
            confidence: applied.confidence,
            hardness: applied.hardness,
            pChild: applied.pChild,
            randomized: applied.randomized,
          };
        }),
    );
  },
};

export default swrVlmAgent;
