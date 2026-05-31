/**
 * The set of tasks the dashboard can launch. Each entry maps a UI key to the
 * kebab-case core taskId used for dashboard provisioning/launch and to the
 * Cypress spec files for each agent. `vlmSpec: null` ⇒ oracle-only.
 */
export const CATALOG = [
  {
    id: 'hearts_and_flowers',
    label: 'Hearts & Flowers',
    taskId: 'hearts-and-flowers',
    oracleSpec: 'cypress/e2e/hearts_and_flowers/oracle.cy.ts',
    vlmSpec: 'cypress/e2e/hearts_and_flowers/vlm_agent.cy.ts',
  },
  {
    id: 'egma_math',
    label: 'EGMA Math',
    taskId: 'egma-math',
    oracleSpec: 'cypress/e2e/egma_math/oracle.cy.ts',
    vlmSpec: 'cypress/e2e/egma_math/vlm_agent.cy.ts',
  },
  {
    id: 'vocab',
    label: 'Vocab',
    taskId: 'vocab',
    oracleSpec: 'cypress/e2e/vocab/oracle.cy.ts',
    vlmSpec: 'cypress/e2e/vocab/vlm_agent.cy.ts',
  },
  {
    id: 'stories',
    label: 'Stories (Theory of Mind)',
    taskId: 'theory-of-mind',
    oracleSpec: 'cypress/e2e/stories/oracle.cy.ts',
    vlmSpec: 'cypress/e2e/stories/vlm_agent.cy.ts',
  },
  {
    id: 'same_different',
    label: 'Same-Different Selection',
    taskId: 'same-different-selection',
    oracleSpec: 'cypress/e2e/same_different/oracle.cy.ts',
    vlmSpec: 'cypress/e2e/same_different/vlm_agent.cy.ts',
  },
  {
    id: 'mental_rotation',
    label: 'Mental Rotation',
    taskId: 'mental-rotation',
    oracleSpec: 'cypress/e2e/mental_rotation/oracle.cy.ts',
    vlmSpec: 'cypress/e2e/mental_rotation/vlm_agent.cy.ts',
  },
  {
    id: 'matrix_reasoning',
    label: 'Matrix Reasoning',
    taskId: 'matrix-reasoning',
    oracleSpec: 'cypress/e2e/matrix_reasoning/oracle.cy.ts',
    vlmSpec: 'cypress/e2e/matrix_reasoning/vlm_agent.cy.ts',
  },
  {
    id: 'trog',
    label: 'TROG',
    taskId: 'trog',
    oracleSpec: 'cypress/e2e/trog/oracle.cy.ts',
    vlmSpec: 'cypress/e2e/trog/vlm_agent.cy.ts',
  },
  {
    id: 'memory_game',
    label: 'Memory Game (Corsi)',
    taskId: 'memory-game',
    oracleSpec: 'cypress/e2e/memory_game/oracle.cy.ts',
    vlmSpec: null,
  },
];

export const VLM_PROVIDERS = ['gemini', 'openai', 'anthropic'];

export function findTask(id) {
  return CATALOG.find((t) => t.id === id) ?? null;
}
