/**
 * Agent mode for the shared oracle specs. Wrong/sim specs are thin entrypoints
 * that import `oracle.cy.ts`; mode is detected from the active spec filename
 * (or QA_AGENT_MODE, set by the entry file / dashboard).
 *
 *   oracle — always clicks the keyed answer; asserts 100% accuracy.
 *   wrong  — always clicks a non-keyed answer; asserts 0% accuracy.
 *   sim    — calibrated simulated child: answers correctly with an IRT-derived
 *            per-item probability (see cypress/plugins/simChildConfig.ts),
 *            hash-seeded so runs are fully reproducible. Asserts accuracy lands
 *            within a binomial band of the model's predicted mean.
 *   random — uniform seeded guesser: picks any choice with equal probability.
 *            Accuracy should land at chance level (mean 1/choices); asserted
 *            with the same binomial band as sim. Needs no node-side config.
 */
import type { SimChildConfig } from '../plugins/simChildConfig';

export type QaAgentMode = 'oracle' | 'wrong' | 'sim' | 'random';

/** Detect mode from QA_AGENT_MODE (entry files, dashboard) or the spec filename. */
export function qaAgentMode(): QaAgentMode {
  const explicit = String(Cypress.expose('QA_AGENT_MODE') ?? '').toLowerCase();
  if (explicit === 'wrong' || explicit === 'sim' || explicit === 'random') return explicit;
  const rel = `${Cypress.spec.relative ?? ''}#${Cypress.spec.name ?? ''}`;
  if (rel.includes('wrong_agent')) return 'wrong';
  if (rel.includes('sim_child')) return 'sim';
  if (rel.includes('random_agent')) return 'random';
  return 'oracle';
}

export function isWrongAgentMode(): boolean {
  return qaAgentMode() === 'wrong';
}

export function isSimMode(): boolean {
  return qaAgentMode() === 'sim';
}

export function isRandomMode(): boolean {
  return qaAgentMode() === 'random';
}

/** Modes whose accuracy is probabilistic (band assertion + decisions log). */
export function isStochasticMode(): boolean {
  return isSimMode() || isRandomMode();
}

/** Log/archive filename stem (`oracle`, `wrong`, or `sim`). */
export function agentLogStem(): string {
  return qaAgentMode();
}

/** Trial records: oracle=true only for the correct-key agent. */
export function trialRecordOracleFlag(): boolean {
  return qaAgentMode() === 'oracle';
}

/** Pick any choice index except the correct one (wraps when n > 1). */
export function pickWrongIndex(correctIndex: number, choiceCount: number): number {
  if (choiceCount <= 0) return 0;
  if (correctIndex < 0) return 0;
  if (choiceCount === 1) return 0;
  return (correctIndex + 1) % choiceCount;
}

export function invertResponseAction(action: 'LEFT' | 'RIGHT'): 'LEFT' | 'RIGHT' {
  return action === 'LEFT' ? 'RIGHT' : 'LEFT';
}

/** Expected exact accuracy at finalize: 1.0 for oracle, 0.0 for wrong. (Sim
 * specs assert a band instead — see simPredictedAccuracy/simAccuracyTolerance.) */
export function expectedAccuracy(): number {
  return isWrongAgentMode() ? 0 : 1;
}

// --- Simulated child (sim mode) ---------------------------------------------

export interface SimDecision {
  index: number;
  correct: boolean;
  p: number;
  roll: number;
  d: number | null;
}

export interface VlmGateDecision {
  /** Final choice index to click. */
  index: number;
  /** Whether the final choice matches the keyed answer. */
  correct: boolean;
  /** IRT draw: child of this age should get the item right. */
  wantCorrect: boolean;
  p: number;
  roll: number;
  d: number | null;
  /** Raw VLM proposal (null / OOB left as-is for logging). */
  vlmIndex: number | null;
  /** True when the clicked index differs from a valid VLM proposal. */
  overridden: boolean;
}

let simConfig: SimChildConfig | null = null;
// Keyed by itemKey so gated re-presentations (which re-run the decision) don't
// double-count an item in the predicted-accuracy tally or the decisions log.
const simDecisions = new Map<string, SimDecision>();
/** Memo for VLM IRT-gate decisions (separate from sim so modes don't collide). */
const vlmGateDecisions = new Map<string, VlmGateDecision>();

/** Install the node-built sim config (call once per spec, before the first item). */
export function simInit(cfg: SimChildConfig): void {
  simConfig = cfg;
  simDecisions.clear();
  vlmGateDecisions.clear();
}

/** Deterministic string hash -> uniform [0, 1). FNV-1a with a final avalanche. */
export function hashToUnit(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995) >>> 0;
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * The sim agent's per-item choice. P(correct) = c + (1-c)*sigmoid(theta+b-d)
 * with c = 1/choiceCount; items missing from the bank use the empirical
 * age-accuracy fallback. Both the correct/incorrect draw and the wrong-choice
 * pick are hashed from (seed, task, itemKey), so the same seed always replays
 * the same decisions. When `choiceValues` is given, the wrong pick is hashed
 * over the sorted values (not positions), so the same wrong picture is chosen
 * even when the app shuffles choice order between runs.
 *
 * `itemKey` must be unique per item (it seeds the hash and memoizes the
 * decision). When the keyed answer value is NOT unique across items (e.g.
 * Stories, where several questions key "no"), pass a unique composite as
 * `itemKey` and the bank answer value as `dKey` for the difficulty lookup.
 */
export function simDecideIndex(
  keyedIndex: number,
  choiceCount: number,
  itemKey: string,
  choiceValues?: string[],
  dKey?: string,
): SimDecision {
  if (!simConfig) {
    throw new Error('sim: simDecideIndex called before simInit (getSimConfig task)');
  }
  const prior = simDecisions.get(itemKey);
  if (prior) return prior;
  const c = choiceCount > 0 ? 1 / choiceCount : 0.25;
  const d = simConfig.dByAnswer[dKey ?? itemKey] ?? null;
  const p =
    d != null && simConfig.theta != null
      ? Math.min(0.995, c + (1 - c) * sigmoid(simConfig.theta + simConfig.offset - d))
      : Math.max(c, simConfig.fallbackP);
  const stem = `${simConfig.seed}#${simConfig.taskSlug}#${itemKey}`;
  const roll = hashToUnit(stem);
  const correct = roll < p;
  let index = keyedIndex;
  if (!correct && choiceCount > 1) {
    const pick = hashToUnit(`${stem}#pick`);
    if (choiceValues && choiceValues.length === choiceCount) {
      const wrongVals = choiceValues.filter((_, i) => i !== keyedIndex).sort();
      index = choiceValues.indexOf(wrongVals[Math.floor(pick * wrongVals.length)]);
    } else {
      const wrong: number[] = [];
      for (let i = 0; i < choiceCount; i++) if (i !== keyedIndex) wrong.push(i);
      index = wrong[Math.floor(pick * wrong.length)];
    }
  }
  const decision: SimDecision = { index, correct, p, roll, d };
  simDecisions.set(itemKey, decision);
  return decision;
}

/**
 * The random agent's per-item choice: uniform over all choices, hash-seeded
 * from (QA_SIM_SEED, spec, itemKey) so runs replay exactly. Hashes over sorted
 * choice values when given, so the same picture is picked even if the app
 * shuffles positions. Records p = 1/choices into the same tally as sim, so the
 * predicted-accuracy band helpers work unchanged. No node-side config needed.
 */
export function randomDecideIndex(
  keyedIndex: number,
  choiceCount: number,
  itemKey: string,
  choiceValues?: string[],
): SimDecision {
  const prior = simDecisions.get(itemKey);
  if (prior) return prior;
  const seed = String(Cypress.expose('QA_SIM_SEED') ?? '1');
  const stem = `${seed}#random#${Cypress.spec.relative ?? ''}#${itemKey}`;
  const roll = hashToUnit(stem);
  const n = Math.max(choiceCount, 1);
  let index: number;
  if (choiceValues && choiceValues.length === choiceCount) {
    const sorted = [...choiceValues].sort();
    index = choiceValues.indexOf(sorted[Math.floor(roll * n)]);
  } else {
    index = Math.floor(roll * n);
  }
  const decision: SimDecision = {
    index,
    correct: index === keyedIndex,
    p: 1 / n,
    roll,
    d: null,
  };
  simDecisions.set(itemKey, decision);
  return decision;
}

/** Mean predicted accuracy over the items actually seen this run. */
export function simPredictedAccuracy(): number | null {
  if (simDecisions.size === 0) return null;
  let s = 0;
  simDecisions.forEach((r) => (s += r.p));
  return s / simDecisions.size;
}

/** 3-sigma binomial band (with a small floor) around the predicted mean. */
export function simAccuracyTolerance(): number {
  const n = simDecisions.size;
  const p = simPredictedAccuracy();
  if (!n || p == null) return 0.2;
  return Math.max(0.08, 3 * Math.sqrt((p * (1 - p)) / n));
}

/** Per-item decisions (for the sim decisions log written at finalize). */
export function simDecisionLog(): (SimDecision & { itemKey: string })[] {
  const out: (SimDecision & { itemKey: string })[] = [];
  simDecisions.forEach((r, itemKey) => out.push({ ...r, itemKey }));
  return out;
}

/** The installed config (for logging run metadata). */
export function simConfigInfo(): SimChildConfig | null {
  return simConfig;
}

// --- VLM IRT age gate (opt-in via QA_PERSONA_GATE=irt) ----------------------

/**
 * When true, VLM specs load sim config and post-filter the model's choice so
 * final correctness matches the age IRT Bernoulli draw. Off by default so the
 * item-difficulty panel stays a pure-VLM screen.
 */
export function isPersonaIrtGate(): boolean {
  return String(Cypress.expose('QA_PERSONA_GATE') ?? '').toLowerCase() === 'irt';
}

/** Clear gate memo (also cleared by simInit). */
export function vlmGateReset(): void {
  vlmGateDecisions.clear();
}

function pickWrongIndexHashed(
  keyedIndex: number,
  choiceCount: number,
  stem: string,
  choiceValues?: string[],
): number {
  if (choiceCount <= 1) return keyedIndex;
  const pick = hashToUnit(`${stem}#pick`);
  if (choiceValues && choiceValues.length === choiceCount) {
    const wrongVals = choiceValues.filter((_, i) => i !== keyedIndex).sort();
    return choiceValues.indexOf(wrongVals[Math.floor(pick * wrongVals.length)]);
  }
  const wrong: number[] = [];
  for (let i = 0; i < choiceCount; i++) if (i !== keyedIndex) wrong.push(i);
  return wrong[Math.floor(pick * wrong.length)];
}

/**
 * Hybrid IRT gate: VLM proposes, age-calibrated Bernoulli decides whether the
 * child should be correct, then:
 *   wantCorrect + VLM correct → keep VLM
 *   wantCorrect + VLM wrong   → force keyed
 *   !wantCorrect + VLM wrong  → keep VLM distractor
 *   !wantCorrect + VLM correct → hash-picked distractor
 *
 * Final correctness always equals `wantCorrect`, so age accuracy matches the
 * sim twin; VLM only shapes *which* mistake when both say wrong.
 */
export function gateVlmIndex(
  keyedIndex: number,
  vlmIndex: number | null,
  choiceCount: number,
  itemKey: string,
  choiceValues?: string[],
  dKey?: string,
): VlmGateDecision {
  if (!simConfig) {
    throw new Error('vlm-gate: gateVlmIndex called before simInit (getSimConfig task)');
  }
  const prior = vlmGateDecisions.get(itemKey);
  if (prior) return prior;

  const c = choiceCount > 0 ? 1 / choiceCount : 0.25;
  const d = simConfig.dByAnswer[dKey ?? itemKey] ?? null;
  const p =
    d != null && simConfig.theta != null
      ? Math.min(0.995, c + (1 - c) * sigmoid(simConfig.theta + simConfig.offset - d))
      : Math.max(c, simConfig.fallbackP);
  const stem = `${simConfig.seed}#vlm-gate#${simConfig.taskSlug}#${itemKey}`;
  const roll = hashToUnit(stem);
  const wantCorrect = roll < p;

  const vlmInRange =
    vlmIndex !== null && Number.isFinite(vlmIndex) && vlmIndex >= 0 && vlmIndex < choiceCount;
  const vlmIsCorrect = vlmInRange && vlmIndex === keyedIndex;

  let index: number;
  if (wantCorrect) {
    index = vlmIsCorrect ? (vlmIndex as number) : keyedIndex;
  } else if (vlmInRange && !vlmIsCorrect) {
    index = vlmIndex as number;
  } else {
    index = pickWrongIndexHashed(keyedIndex, choiceCount, stem, choiceValues);
  }

  const decision: VlmGateDecision = {
    index,
    correct: index === keyedIndex,
    wantCorrect,
    p,
    roll,
    d,
    vlmIndex,
    overridden: !vlmInRange || index !== vlmIndex,
  };
  vlmGateDecisions.set(itemKey, decision);
  return decision;
}

/** Per-item gate decisions (for audit logs). */
export function vlmGateDecisionLog(): (VlmGateDecision & { itemKey: string })[] {
  const out: (VlmGateDecision & { itemKey: string })[] = [];
  vlmGateDecisions.forEach((r, itemKey) => out.push({ ...r, itemKey }));
  return out;
}

/** Indices for a deliberately non-matching SDS match pair. */
export function wrongMatchIndices(
  correct: { a: number; b: number } | null,
  cardCount: number,
): [number, number] {
  if (cardCount < 2) return [0, 0];
  if (!correct) return [0, 1];
  let b = (correct.b + 1) % cardCount;
  if (b === correct.a) b = (b + 1) % cardCount;
  return [correct.a, b];
}

/**
 * Perturb a reproduction sequence so it is unlikely to match the keyed order.
 * Used by the memory-game wrong agent.
 */
export function wrongReproductionSequence(
  sequence: number[],
  backward: boolean,
  gridBlocks: number,
): number[] {
  const base = backward ? [...sequence].reverse() : [...sequence];
  if (base.length === 0) return [0];
  const n = Math.max(gridBlocks, 9);
  const out = [...base];
  out[0] = (out[0] + 1) % n;
  if (out.every((v, i) => v === base[i]) && out.length > 1) {
    out[1] = (out[1] + 1) % n;
  }
  return out;
}
