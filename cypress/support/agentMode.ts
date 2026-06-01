/**
 * Oracle vs Wrong agent mode. Wrong specs are thin entrypoints that import
 * `oracle.cy.ts`; mode is detected from the active spec filename.
 */
export type QaAgentMode = 'oracle' | 'wrong';

/** True when the active spec is `wrong_agent.cy.ts` (or dashboard set QA_AGENT_MODE). */
export function qaAgentMode(): QaAgentMode {
  if (String(Cypress.env('QA_AGENT_MODE') ?? '').toLowerCase() === 'wrong') {
    return 'wrong';
  }
  const rel = String(Cypress.spec.relative ?? '');
  if (rel.includes('wrong_agent')) return 'wrong';
  const name = String(Cypress.spec.name ?? '');
  if (name.includes('wrong_agent')) return 'wrong';
  return 'oracle';
}

export function isWrongAgentMode(): boolean {
  return qaAgentMode() === 'wrong';
}

/** Log/archive filename stem (`oracle` or `wrong`). */
export function agentLogStem(): string {
  return qaAgentMode();
}

/** Trial records: oracle=true only for the correct-key agent. */
export function trialRecordOracleFlag(): boolean {
  return !isWrongAgentMode();
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

/** Expected accuracy at finalize: 1.0 for oracle, 0.0 for wrong. */
export function expectedAccuracy(): number {
  return isWrongAgentMode() ? 0 : 1;
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
