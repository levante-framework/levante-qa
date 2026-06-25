import sreVlmAgent from '../../support/agents/sreVlmAgent';
import { installAudioCapture, type AudioWindow } from '../../support/audio/audioCapture';
import { currentAudioTranscript, resetAudioCapture } from '../../support/audio/audioOracle';
import { launchTask } from '../../support/launch';
import { waitForRoarJsPsych } from '../../support/tasks/roar';
import {
  advanceSreStartup,
  arrowKeyForLr,
  bodyHasSreCompletion,
  clickSreContinueIfPresent,
  hasActiveStimulus,
  isDashboardReroute,
  isProgressComplete,
  readCorrectLrFromWindow,
  readStimulusText,
  scoreTrials,
  type CorrectLr,
  SRE_ASSET_WAIT_MS,
  SRE_STEP_MS,
} from '../../support/tasks/sre';
import { parseSreTrialRecord, type SreTrialRecord } from '../../support/tasks/types';

const TASK = 'sre';
const LIVE_LOG = 'cypress/logs/_sre_vlm_live.jsonl';
const STARTUP_TRACE_LOG = 'cypress/logs/_roar_vlm_stage_trace.jsonl';
const MAX_ITER = 800;
const STALL_LIMIT = 30;
const TIMEOUT_MS = 10000;
const provider = String(Cypress.expose('provider') ?? 'gemini');
const TRACE_ON = ['1', 'true', 'yes', 'on'].includes(
  String(Cypress.expose('QA_ROAR_TRACE') ?? '').trim().toLowerCase(),
);

describe(`SRE — VLM agent (${provider})`, () => {
  const records: SreTrialRecord[] = [];
  let step = 0;
  let taskComplete = false;
  let gameComplete = false;
  let nItems = 0;
  let lastScreenSig = '';
  let screenStall = 0;

  function logRecord(
    input: Pick<SreTrialRecord, 'timestamp' | 'itemType' | 'oracle'> &
      Partial<
        Pick<
          SreTrialRecord,
          | 'correctLr'
          | 'chosenLr'
          | 'promptText'
          | 'correct'
          | 'rtMs'
          | 'provider'
          | 'modelRaw'
          | 'latencyMs'
          | 'timedOut'
        >
      >,
  ): void {
    step += 1;
    const rec = parseSreTrialRecord({ ...input, task: TASK, step });
    records.push(rec);
    cy.task('writeJsonl', { path: LIVE_LOG, records: [rec] }, { log: false });
  }

  function trace(stage: string): void {
    if (!TRACE_ON) return;
    cy.task(
      'writeJsonl',
      {
        path: STARTUP_TRACE_LOG,
        records: [{ ts: new Date().toISOString(), task: TASK, provider, stage }],
      },
      { log: false },
    );
  }

  function finalize(): void {
    const ts = Date.now();
    cy.task('writeJsonl', { path: `cypress/logs/vlm_sre_${provider}_${ts}.jsonl`, records });
    const stats = scoreTrials(records);
    cy.wrap(null).then(() => {
      expect(taskComplete || gameComplete, 'SRE run reached completion').to.equal(true);
      expect(stats.nItems, 'scored SRE item trials').to.be.greaterThan(0);
      cy.log(`items: ${nItems}`);
      cy.log(`VLM (${provider}) accuracy: ${stats.accuracy ?? 0}`);
    });
  }

  function playTrials(iterLeft = MAX_ITER): void {
    if (taskComplete || gameComplete || iterLeft <= 0) {
      if (!taskComplete && !gameComplete) finalize();
      return;
    }

    cy.wait(SRE_ASSET_WAIT_MS * 0.15, { log: false });
    cy.get('body', { log: false })
      .invoke('text')
      .then((text) => {
        if (isDashboardReroute(text)) {
          taskComplete = true;
          finalize();
          return;
        }
        if (bodyHasSreCompletion(text)) {
          gameComplete = true;
          finalize();
          return;
        }

        cy.window({ log: false }).then((win) => {
          if (isProgressComplete(win.document)) {
            gameComplete = true;
            finalize();
            return;
          }

          const doc = win.document;
          const active = hasActiveStimulus(doc);
          const sig = `${text.trim().slice(0, 120)}#${active ? 'S' : ''}#${nItems}`;
          if (sig === lastScreenSig) screenStall += 1;
          else {
            screenStall = 0;
            lastScreenSig = sig;
          }
          if (screenStall >= STALL_LIMIT) {
            throw new Error(`SRE screen never advanced for ${STALL_LIMIT} passes`);
          }

          if (!active) {
            clickSreContinueIfPresent();
            cy.get('body', { log: false }).type('{leftarrow}{rightarrow}', { log: false });
            cy.wait(SRE_STEP_MS * 0.2, { log: false });
            playTrials(iterLeft - 1);
            return;
          }

          const keyedLr = readCorrectLrFromWindow(win);
          const promptText = readStimulusText(doc) || null;
          if (!keyedLr) {
            cy.get('body', { log: false }).type('{leftarrow}', { log: false });
            cy.wait(SRE_STEP_MS * 0.08, { log: false });
            playTrials(iterLeft - 1);
            return;
          }

          nItems += 1;
          const screenshotName = `vlm_sre_step_${String(step).padStart(4, '0')}`;
          cy.captureViewportBase64(screenshotName).then((pngBase64: string) => {
            currentAudioTranscript(win as unknown as AudioWindow).then((audio) => {
              sreVlmAgent.decide(pngBase64, audio.transcript).then((decision) => {
                const chosenLr: CorrectLr | null = decision.lr;
                const correct = chosenLr === keyedLr;
                const actLr = chosenLr ?? keyedLr;
                logRecord({
                  timestamp: new Date().toISOString(),
                  itemType: 'item',
                  correctLr: keyedLr,
                  chosenLr,
                  promptText,
                  correct,
                  rtMs: decision.latencyMs,
                  oracle: false,
                  provider,
                  modelRaw: decision.raw,
                  latencyMs: decision.latencyMs,
                  timedOut: decision.latencyMs > TIMEOUT_MS,
                });
                cy.get('body', { log: false }).type(arrowKeyForLr(actLr, false), {
                  log: false,
                });
                cy.wait(SRE_STEP_MS * 0.08, { log: false });
                playTrials(iterLeft - 1);
              });
            });
          });
        });
      });
  }

  it('completes roar-sre by choosing left/right with a VLM', () => {
    trace('spec:start');
    resetAudioCapture();
    trace('after:resetAudioCapture');
    launchTask({
      taskId: 'sre',
      demoUrl: 'about:blank',
      onBeforeLoad: installAudioCapture,
    });
    trace('after:launchTask');

    trace('before:waitForRoarJsPsych');
    waitForRoarJsPsych();
    trace('after:waitForRoarJsPsych');
    trace('before:advanceSreStartup');
    advanceSreStartup();
    trace('after:advanceSreStartup');
    logRecord({
      timestamp: new Date().toISOString(),
      itemType: 'intro',
      correctLr: null,
      correct: null,
      oracle: false,
    });

    trace('before:playTrials');
    playTrials();
  });
});
