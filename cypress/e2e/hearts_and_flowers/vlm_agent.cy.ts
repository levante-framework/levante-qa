import oracleAgent from '../../support/agents/oracleAgent';
import vlmAgent from '../../support/agents/vlmAgent';
import {
  buildUrl,
  congruency,
  isComplete,
  isFeedback,
  isInstructionScreen,
  isStimulusReady,
  readStimulus,
  resetBlockTracker,
  type TaskWindow,
} from '../../support/tasks/heartsAndFlowers';
import { installAudioCapture, type AudioWindow } from '../../support/audio/audioCapture';
import { currentAudioTranscript, resetAudioCapture } from '../../support/audio/audioOracle';
import { parseTrialRecord, type TrialRecord } from '../../support/tasks/types';

const MAX_STEPS = 1200;
const TASK = 'hearts-and-flowers';
const TIMEOUT_MS = 2000;

// Provider is chosen node-side by VLM_PROVIDER, but is surfaced to the spec via
// Cypress.env('provider') so logs are labelled and the spec can be run with
// `npx cypress run --env provider=openai`.
const provider = String(Cypress.env('provider') ?? 'openai');

describe(`Hearts & Flowers — VLM agent (${provider})`, () => {
  const records: TrialRecord[] = [];
  // Flips true once a non-empty task screen has been seen, so that an empty
  // content root during initial load is not mistaken for task completion.
  let started = false;

  function finalize(): void {
    const ts = Date.now();
    cy.task('writeJsonl', {
      path: `cypress/logs/vlm_hf_${provider}_${ts}.jsonl`,
      records,
    });
    cy.wrap(null).then(() => {
      expect(records.length, 'recorded at least one VLM response').to.be.greaterThan(0);
    });
  }

  function step(i: number): void {
    if (i >= MAX_STEPS) {
      finalize();
      return;
    }

    cy.window().then((w) => {
      const win = w as unknown as TaskWindow;

      if (isComplete(win)) {
        if (!started) {
          cy.wait(150);
          step(i + 1);
          return;
        }
        finalize();
        return;
      }
      started = true;

      // Feedback / blank inter-trial frame: let it settle.
      if (isFeedback(win)) {
        cy.wait(150);
        step(i + 1);
        return;
      }

      // Instructions / fixation: advance deterministically (no model call). The
      // VLM is benchmarked on response trials, not on dismissing instructions.
      if (isInstructionScreen(win)) {
        cy.actOnTrial('CONTINUE');
        cy.wait(250);
        step(i + 1);
        return;
      }

      if (!isStimulusReady(win)) {
        cy.wait(100);
        step(i + 1);
        return;
      }

      // Response trial: capture state + oracle decision (for cross-check only),
      // then hand the screenshot — and any narration transcript — to the model.
      const state = readStimulus(win);
      const oracleAction = oracleAgent.decide(win);

      currentAudioTranscript(win as unknown as AudioWindow).then((audio) => {
        const screenshotName = `vlm_step_${String(i).padStart(4, '0')}`;
        // Capture the path Cypress actually writes to (its screenshot folder
        // naming is version/spec dependent), rather than reconstructing it.
        let shotPath = '';
        cy.screenshot(screenshotName, {
          capture: 'viewport',
          overwrite: true,
          onAfterScreenshot(_doc, props) {
            shotPath = props.path;
          },
        });

        cy.then(() => cy.readFile(shotPath, 'base64')).then((pngBase64: string) => {
          vlmAgent.decide(pngBase64, audio.transcript).then((decision) => {
            const modelAction = decision.action;

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
                // "correct" here means the model matched the deterministic oracle;
                // this is logged for analysis and never gates the test.
                correct: modelAction === oracleAction,
                rtMs: decision.latencyMs,
                oracle: false,
                provider,
                modelAction,
                oracleAction,
                latencyMs: decision.latencyMs,
                timedOut: decision.latencyMs > TIMEOUT_MS,
                audioTranscript: audio.transcript,
                audioSource: audio.source,
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
    resetBlockTracker();
    resetAudioCapture();
    cy.visit(buildUrl(), { onBeforeLoad: installAudioCapture });
    // Wait for the app to load, then dismiss the fullscreen prompt.
    cy.contains('OK', { timeout: 120000 }).should('be.visible').click({ force: true });
    step(0);
  });
});
