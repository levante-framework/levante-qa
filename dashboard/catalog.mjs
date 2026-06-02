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
    wrongSpec: 'cypress/e2e/hearts_and_flowers/wrong_agent.cy.ts',
    vlmSpec: 'cypress/e2e/hearts_and_flowers/vlm_agent.cy.ts',
  },
  {
    id: 'egma_math',
    label: 'EGMA Math',
    taskId: 'egma-math',
    oracleSpec: 'cypress/e2e/egma_math/oracle.cy.ts',
    wrongSpec: 'cypress/e2e/egma_math/wrong_agent.cy.ts',
    vlmSpec: 'cypress/e2e/egma_math/vlm_agent.cy.ts',
  },
  {
    id: 'vocab',
    label: 'Vocab',
    taskId: 'vocab',
    oracleSpec: 'cypress/e2e/vocab/oracle.cy.ts',
    wrongSpec: 'cypress/e2e/vocab/wrong_agent.cy.ts',
    vlmSpec: 'cypress/e2e/vocab/vlm_agent.cy.ts',
  },
  {
    id: 'stories',
    label: 'Stories (Theory of Mind)',
    taskId: 'theory-of-mind',
    oracleSpec: 'cypress/e2e/stories/oracle.cy.ts',
    wrongSpec: 'cypress/e2e/stories/wrong_agent.cy.ts',
    vlmSpec: 'cypress/e2e/stories/vlm_agent.cy.ts',
  },
  {
    id: 'same_different',
    label: 'Same-Different Selection',
    taskId: 'same-different-selection',
    oracleSpec: 'cypress/e2e/same_different/oracle.cy.ts',
    wrongSpec: 'cypress/e2e/same_different/wrong_agent.cy.ts',
    vlmSpec: 'cypress/e2e/same_different/vlm_agent.cy.ts',
  },
  {
    id: 'mental_rotation',
    label: 'Mental Rotation',
    taskId: 'mental-rotation',
    oracleSpec: 'cypress/e2e/mental_rotation/oracle.cy.ts',
    wrongSpec: 'cypress/e2e/mental_rotation/wrong_agent.cy.ts',
    vlmSpec: 'cypress/e2e/mental_rotation/vlm_agent.cy.ts',
  },
  {
    id: 'matrix_reasoning',
    label: 'Matrix Reasoning',
    taskId: 'matrix-reasoning',
    oracleSpec: 'cypress/e2e/matrix_reasoning/oracle.cy.ts',
    wrongSpec: 'cypress/e2e/matrix_reasoning/wrong_agent.cy.ts',
    vlmSpec: 'cypress/e2e/matrix_reasoning/vlm_agent.cy.ts',
  },
  {
    id: 'trog',
    label: 'TROG',
    taskId: 'trog',
    oracleSpec: 'cypress/e2e/trog/oracle.cy.ts',
    wrongSpec: 'cypress/e2e/trog/wrong_agent.cy.ts',
    vlmSpec: 'cypress/e2e/trog/vlm_agent.cy.ts',
  },
  {
    id: 'memory_game',
    label: 'Memory Game (Corsi)',
    taskId: 'memory-game',
    oracleSpec: 'cypress/e2e/memory_game/oracle.cy.ts',
    wrongSpec: 'cypress/e2e/memory_game/wrong_agent.cy.ts',
    vlmSpec: null,
  },
  {
    id: 'pa',
    label: 'ROAR — Phoneme (PA)',
    taskId: 'pa',
    oracleSpec: 'cypress/e2e/pa/oracle.cy.ts',
    wrongSpec: 'cypress/e2e/pa/wrong_agent.cy.ts',
    vlmSpec: null,
    requiresDashboard: true,
  },
  {
    id: 'sre',
    label: 'ROAR — Sentence (SRE)',
    taskId: 'sre',
    oracleSpec: 'cypress/e2e/sre/oracle.cy.ts',
    wrongSpec: 'cypress/e2e/sre/wrong_agent.cy.ts',
    vlmSpec: null,
    requiresDashboard: true,
  },
  {
    id: 'swr',
    label: 'ROAR — Word (SWR)',
    taskId: 'swr',
    oracleSpec: 'cypress/e2e/swr/oracle.cy.ts',
    wrongSpec: 'cypress/e2e/swr/wrong_agent.cy.ts',
    vlmSpec: null,
    requiresDashboard: true,
  },
];

export const VLM_PROVIDERS = ['gemini', 'openai', 'anthropic'];

/**
 * Languages our tasks ship variants for on hs-levante-admin-dev. `code` is sent
 * to the provisioner (variant selection) and exposed as QA_EXPECTED_AUDIO_LANG
 * (narration language check). The first entry is the default.
 */
export const LANGUAGES = [
  { code: 'en-US', label: 'English (North America)' },
  { code: 'de-DE', label: 'German (Germany)' },
  { code: 'es-CO', label: 'Spanish (Colombia)' },
  { code: 'es-AR', label: 'Spanish (Argentina)' },
  // Flagged "testing" on the LEVANTE platform (RTL, in-progress translations).
  { code: 'ar-IL', label: 'Arabic (Israel)', testing: true },
  { code: 'he-IL', label: 'Hebrew (Israel)', testing: true },
];

export const DEFAULT_LANGUAGE = LANGUAGES[0].code;

export function isSupportedLanguage(code) {
  return LANGUAGES.some((l) => l.code === code);
}

export function findTask(id) {
  return CATALOG.find((t) => t.id === id) ?? null;
}
