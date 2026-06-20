import swrVlmAgent from '../../support/agents/swrVlmAgent';
import { installAudioCapture, type AudioWindow } from '../../support/audio/audioCapture';
import { currentAudioTranscript, resetAudioCapture } from '../../support/audio/audioOracle';
import { launchTask } from '../../support/launch';
import { waitForRoarJsPsych } from '../../support/tasks/roar';
import {
  advanceSwrLexicalityTutorial,
  advanceSwrPracticeIntro,
  advanceSwrStartup,
  arrowKeyForLr,
  clickSwrContinue,
  hasActiveStimulus,
  isDashboardReroute,
  isProgressComplete,
  readCorrectLrFromWindow,
  readStimulusText,
  scoreTrials,
  type CorrectLr,
  SWR_ASSET_WAIT_MS,
  SWR_STEP_MS,
} from '../../support/tasks/swr';
import { parseSwrTrialRecord, type SwrTrialRecord } from '../../support/tasks/types';

const TASK = 'swr';
const LIVE_LOG = 'cypress/logs/_swr_vlm_live.jsonl';
const STARTUP_TRACE_LOG = 'cypress/logs/_roar_vlm_stage_trace.jsonl';
const MAX_ITER = 900;
const TIMEOUT_MS = 10000;
const provider = String(Cypress.env('provider') ?? 'gemini');
const TRACE_ON = ['1', 'true', 'yes', 'on'].includes(
  String(Cypress.env('QA_ROAR_TRACE') ?? '').trim().toLowerCase(),
);

describe(`SWR — VLM agent (${provider})`, () => {
  const records: SwrTrialRecord[] = [];
  let step = 0;
  let taskComplete = false;
  let gameComplete = false;
  let nItems = 0;
  let nBreaks = 0;

  function logRecord(
    input: Pick<SwrTrialRecord, 'timestamp' | 'itemType' | 'oracle'> &
      Partial<
        Pick<
          SwrTrialRecord,
          | 'correctLr'
          | 'chosenLr'
          | 'promptText'
          | 'breakMarker'
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
    const rec = parseSwrTrialRecord({ ...input, task: TASK, step });
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
    cy.task('writeJsonl', { path: `cypress/logs/vlm_swr_${provider}_${ts}.jsonl`, records });
    const stats = scoreTrials(records);
    cy.wrap(null).then(() => {
      expect(taskComplete || gameComplete, 'SWR run reached completion').to.equal(true);
      expect(stats.nItems, 'scored SWR item trials').to.be.greaterThan(0);
      cy.log(`items: ${nItems}, breaks: ${nBreaks}`);
      cy.log(`VLM (${provider}) accuracy: ${stats.accuracy ?? 0}`);
    });
  }

  function playTrials(iterLeft = MAX_ITER): void {
    if (taskComplete || gameComplete || iterLeft <= 0) {
      if (!taskComplete && !gameComplete) finalize();
      return;
    }

    cy.wait(SWR_ASSET_WAIT_MS * 0.15, { log: false });
    cy.get('body', { log: false })
      .invoke('text')
      .then((text) => {
        if (isDashboardReroute(text)) {
          taskComplete = true;
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
          if (!hasActiveStimulus(doc)) {
            nBreaks += 1;
            logRecord({
              timestamp: new Date().toISOString(),
              itemType: 'break',
              breakMarker: 'block_transition',
              correctLr: null,
              correct: null,
              oracle: false,
            });
            cy.get('body', { log: false }).type('{leftarrow}{rightarrow}', { log: false });
            if (!isProgressComplete(doc)) clickSwrContinue();
            cy.wait(SWR_STEP_MS * 0.2, { log: false });
            playTrials(iterLeft - 1);
            return;
          }

          const keyedLr = readCorrectLrFromWindow(win);
          const promptText = readStimulusText(doc) || null;
          if (!keyedLr) {
            // Keep moving if a key is unreadable on a single trial.
            cy.get('body', { log: false }).type('{leftarrow}', { log: false });
            cy.wait(SWR_STEP_MS * 0.08, { log: false });
            playTrials(iterLeft - 1);
            return;
          }

          nItems += 1;
          const screenshotName = `vlm_swr_step_${String(step).padStart(4, '0')}`;
          cy.captureViewportBase64(screenshotName).then((pngBase64: string) => {
            currentAudioTranscript(win as unknown as AudioWindow).then((audio) => {
              swrVlmAgent.decide(pngBase64, audio.transcript).then((decision) => {
                const chosenLr: CorrectLr | null = decision.lr;
                const correct = chosenLr === keyedLr;
                const actLr = chosenLr ?? keyedLr;
                logRecord({
                  timestamp: new Date().toISOString(),
                  itemType: 'item',
                  correctLr: keyedLr,
                  chosenLr,
                  promptText,
                  breakMarker: null,
                  correct,
                  rtMs: decision.latencyMs,
                  oracle: false,
                  provider,
                  modelRaw: decision.raw,
                  latencyMs: decision.latencyMs,
                  timedOut: decision.latencyMs > TIMEOUT_MS,
                });
                cy.get('body', { log: false }).type(arrowKeyForLr(actLr, false), { log: false });
                cy.wait(SWR_STEP_MS * 0.08, { log: false });
                playTrials(iterLeft - 1);
              });
            });
          });
        });
      });
  }

  it('completes roar-swr by choosing left/right with a VLM', () => {
    trace('spec:start');
    resetAudioCapture();
    trace('after:resetAudioCapture');
    launchTask({
      taskId: 'swr',
      demoUrl: 'about:blank',
      onBeforeLoad: installAudioCapture,
    });
    trace('after:launchTask');

    trace('before:waitForRoarJsPsych');
    waitForRoarJsPsych();
    trace('after:waitForRoarJsPsych');
    trace('before:advanceSwrStartup');
    advanceSwrStartup();
    trace('after:advanceSwrStartup');
    logRecord({
      timestamp: new Date().toISOString(),
      itemType: 'intro',
      correctLr: null,
      breakMarker: null,
      correct: null,
      oracle: false,
    });

    trace('before:advanceSwrLexicalityTutorial');
    advanceSwrLexicalityTutorial();
    trace('after:advanceSwrLexicalityTutorial');
    logRecord({
      timestamp: new Date().toISOString(),
      itemType: 'tutorial',
      correctLr: null,
      breakMarker: 'lexicality_gate',
      correct: true,
      oracle: false,
    });

    trace('before:advanceSwrPracticeIntro');
    advanceSwrPracticeIntro();
    trace('after:advanceSwrPracticeIntro');
    logRecord({
      timestamp: new Date().toISOString(),
      itemType: 'tutorial',
      correctLr: null,
      breakMarker: 'practice_intro',
      correct: true,
      oracle: false,
    });

    trace('before:playTrials');
    playTrials();
  });
});
