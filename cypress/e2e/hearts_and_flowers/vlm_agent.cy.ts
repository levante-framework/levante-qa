import oracleAgent from '../../support/agents/oracleAgent';
import vlmAgent from '../../support/agents/vlmAgent';
import {
  buildUrl,
  congruency,
  readStimulus,
  type TaskWindow,
} from '../../support/tasks/heartsAndFlowers';
import { parseTrialRecord, type TrialRecord } from '../../support/tasks/types';

const MAX_STEPS = 400;
const COMPLETE_TEXT = /You've completed the game/i;
const TASK = 'hearts-and-flowers';
const TIMEOUT_MS = 2000;

// Provider is chosen node-side by VLM_PROVIDER, but is surfaced to the spec via
// Cypress.env('provider') so the log filename and records are labelled and so
// the spec can be run with `npx cypress run --env provider=openai`.
const provider = String(Cypress.env('provider') ?? 'openai');

describe(`Hearts & Flowers — VLM agent (${provider})`, () => {
  const records: TrialRecord[] = [];

  function finalize(): void {
    const ts = Date.now();
    cy.task('writeJsonl', {
      path: `cypress/logs/vlm_hf_${provider}_${ts}.jsonl`,
      records,
    });
    cy.wrap(null).then(() => {
      expect(records.length, 'recorded at least one VLM step').to.be.greaterThan(0);
    });
  }

  function step(i: number): void {
    if (i >= MAX_STEPS) {
      finalize();
      return;
    }

    cy.get('body').then(($body) => {
      if (COMPLETE_TEXT.test($body.text())) {
        finalize();
        return;
      }

      cy.window().then((w) => {
        const win = w as unknown as TaskWindow;
        const state = readStimulus(win);
        // Oracle decision is computed for logging/cross-check only — it never
        // gates the test or influences which button the VLM clicks.
        const oracleAction = oracleAgent.decide(win);

        const screenshotName = `vlm_step_${String(i).padStart(3, '0')}`;
        cy.screenshot(screenshotName, { capture: 'viewport', overwrite: true });
        const path = `cypress/screenshots/${Cypress.spec.relative}/${screenshotName}.png`;

        cy.readFile(path, 'base64').then((pngBase64: string) => {
          vlmAgent.decide(pngBase64).then((decision) => {
            const modelAction = decision.action;
            const isResponse = modelAction === 'LEFT' || modelAction === 'RIGHT';

            records.push(
              parseTrialRecord({
                timestamp: new Date().toISOString(),
                task: TASK,
                step: i,
                block: state.blockType,
                shape: state.shape,
                side: state.side,
                congruency:
                  state.blockType === 'mixed' ? congruency(state.shape, state.side) : null,
                action: modelAction,
                correct: isResponse ? modelAction === oracleAction : null,
                rtMs: decision.latencyMs,
                oracle: false,
                provider,
                modelAction,
                oracleAction,
                latencyMs: decision.latencyMs,
                timedOut: decision.latencyMs > TIMEOUT_MS,
              }),
            );

            cy.actOnTrial(modelAction);
            cy.wait(150);
            step(i + 1);
          });
        });
      });
    });
  }

  it('drives the task via the configured VLM provider', () => {
    cy.visit(buildUrl());
    step(0);
  });
});
