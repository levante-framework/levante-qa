/**
 * Opt-in IRT age gate for VLM agents (`QA_PERSONA_GATE=irt`).
 *
 * Specs call `initVlmIrtGateIfEnabled(taskSlug)` once at the start of the run,
 * then `resolveVlmChoice(...)` after each model decision to get the final click
 * index (and optional gate audit fields for the trial log).
 */
import type { SimChildConfig } from '../../plugins/simChildConfig';
import {
  gateVlmIndex,
  isPersonaIrtGate,
  simInit,
  type VlmGateDecision,
} from '../agentMode';

export type ResolvedVlmChoice = {
  /** Index to click. */
  actIndex: number;
  /** Whether the clicked choice matches the keyed answer (null if no key). */
  correct: boolean | null;
  /** Valid in-range VLM proposal, else null. */
  vlmIndex: number | null;
  /** Gate audit fields when gating is on and a key exists; else null. */
  gate: VlmGateDecision | null;
};

/** Load sim config + simInit when QA_PERSONA_GATE=irt; no-op otherwise. */
export function initVlmIrtGateIfEnabled(taskSlug: string): void {
  if (!isPersonaIrtGate()) return;
  cy.task('getSimConfig', { taskSlug }).then((cfg) => {
    simInit(cfg as SimChildConfig);
  });
}

/**
 * Resolve the click index after a VLM proposal.
 *
 * When the IRT gate is off (default), behaves like today's VLM agents: click the
 * in-range VLM index, else fall back to the keyed answer to advance.
 * When on and a key exists, applies `gateVlmIndex`.
 */
export function resolveVlmChoice(opts: {
  keyedIndex: number;
  hasKey: boolean;
  vlmIndex: number | null;
  choices: string[];
  itemKey: string;
  dKey?: string;
}): ResolvedVlmChoice {
  const { keyedIndex, hasKey, vlmIndex, choices, itemKey, dKey } = opts;
  const inRange =
    vlmIndex !== null && Number.isFinite(vlmIndex) && vlmIndex >= 0 && vlmIndex < choices.length;

  if (hasKey && isPersonaIrtGate()) {
    const gate = gateVlmIndex(
      keyedIndex,
      inRange ? vlmIndex : null,
      choices.length,
      itemKey,
      choices,
      dKey,
    );
    return {
      actIndex: gate.index,
      correct: gate.correct,
      vlmIndex: inRange ? vlmIndex : null,
      gate,
    };
  }

  const actIndex = inRange ? (vlmIndex as number) : hasKey ? keyedIndex : 0;
  return {
    actIndex,
    correct: hasKey ? inRange && vlmIndex === keyedIndex : null,
    vlmIndex: inRange ? vlmIndex : null,
    gate: null,
  };
}

/** Flat gate fields for trial jsonl (gate stats null when ungated). */
export function gateLogFields(
  gate: VlmGateDecision | null,
  vlmIndex: number | null = null,
): {
  vlmProposedIndex: number | null;
  gateWantCorrect: boolean | null;
  gateP: number | null;
  gateOverridden: boolean | null;
} {
  if (!gate) {
    return {
      vlmProposedIndex: vlmIndex,
      gateWantCorrect: null,
      gateP: null,
      gateOverridden: null,
    };
  }
  return {
    vlmProposedIndex: gate.vlmIndex,
    gateWantCorrect: gate.wantCorrect,
    gateP: gate.p,
    gateOverridden: gate.overridden,
  };
}
