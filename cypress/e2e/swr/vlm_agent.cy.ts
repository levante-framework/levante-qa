import swrVlmAgent from '../../support/agents/swrVlmAgent';
import { resolveSwrPromptVersion } from '../../support/agents/prompts/swrPrompts';
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
  isSwrAnswerableTrial,
  isSwrBreakScreen,
  isSwrLexicalStimulus,
  readCorrectLrFromWindow,
  readSwrRuntimeMeta,
  readSwrTrialKey,
  readStimulusText,
  scoreTrials,
  type CorrectLr,
} from '../../support/tasks/swr';
import { parseSwrTrialRecord, type SwrTrialRecord } from '../../support/tasks/types';

const TASK = 'swr';
const LIVE_LOG = 'cypress/logs/_swr_vlm_live.jsonl';
const STARTUP_TRACE_LOG = 'cypress/logs/_roar_vlm_stage_trace.jsonl';
const MAX_ITER = 8000;
/** Must be << 350ms timed flash (mirrors oracle). */
const POLL_MS = 40;
const AFTER_ANSWER_MS = 80;
const TIMEOUT_MS = 10000;
const provider = String(Cypress.expose('provider') ?? 'gemini');
const TRACE_ON = ['1', 'true', 'yes', 'on'].includes(
  String(Cypress.expose('QA_ROAR_TRACE') ?? '').trim().toLowerCase(),
);

describe(`SWR — VLM agent (${provider})`, () => {
  const records: SwrTrialRecord[] = [];
  let step = 0;
  let taskComplete = false;
  let gameComplete = false;
  let nItems = 0;
  let nBreaks = 0;
  let lastAnsweredKey: string | null = null;
  let seenTrialKey: string | null = null;
  let seenLr: CorrectLr | null = null;
  let seenPromptText: string | null = null;
  let lastBreakHandledAt = 0;

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
          | 'confidence'
          | 'pChild'
          | 'hardness'
          | 'randomized'
          | 'userMode'
          | 'blockIndex'
          | 'presentationTime'
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

  /**
   * Oracle-aligned loop: observe flash → answer in isSwrAnswerableTrial window.
   * Answering on the first flash tick (or with multi-second polls) stalls timed SWR.
   */
  function playTrials(iterLeft = MAX_ITER): void {
    if (taskComplete || gameComplete || iterLeft <= 0) {
      if (!taskComplete && !gameComplete) finalize();
      return;
    }

    cy.window({ log: false }).then((win) => {
      cy.get('body', { log: false }).then(($b) => {
        const text = $b.text();
        if (isDashboardReroute(text)) {
          taskComplete = true;
          finalize();
          return;
        }

        const doc = win.document;
        if (isProgressComplete(doc)) {
          gameComplete = true;
          finalize();
          return;
        }

        const meta = readSwrRuntimeMeta(win);
        const breakOpts = { seenTrialKey, lastAnsweredKey };

        if (hasActiveStimulus(doc)) {
          const stimText = readStimulusText(doc);
          if (isSwrLexicalStimulus(stimText)) {
            const k = readSwrTrialKey(win);
            const isNewFlash = Boolean(k && k !== seenTrialKey && k !== lastAnsweredKey);
            if (k) seenTrialKey = k;
            const lrNow = readCorrectLrFromWindow(win);
            if (lrNow) seenLr = lrNow;
            if (stimText) seenPromptText = stimText;
            // First poll on a new flash: stash only — do not VLM/key yet.
            if (isNewFlash) {
              cy.wait(POLL_MS, { log: false });
              playTrials(iterLeft - 1);
              return;
            }
          }
        }

        if (
          isSwrAnswerableTrial(doc, win, text, {
            ...breakOpts,
            presentationTime: meta.presentationTime,
          })
        ) {
          const trialKey = readSwrTrialKey(win) || seenTrialKey;
          if (!trialKey || trialKey === lastAnsweredKey) {
            cy.wait(POLL_MS, { log: false });
            playTrials(iterLeft - 1);
            return;
          }

          const keyedLr = readCorrectLrFromWindow(win) || seenLr;
          const promptText =
            (isSwrLexicalStimulus(readStimulusText(doc))
              ? readStimulusText(doc)
              : null) ||
            seenPromptText ||
            null;

          if (!keyedLr) {
            cy.get('body', { log: false }).type('{leftarrow}', { log: false });
            lastAnsweredKey = trialKey;
            cy.wait(AFTER_ANSWER_MS, { log: false });
            playTrials(iterLeft - 1);
            return;
          }

          const promptVersion = resolveSwrPromptVersion();
          const needImage = !(
            (promptVersion === 'v2' || promptVersion === 'v3') &&
            Boolean(promptText)
          );

          const afterPng = (pngBase64: string) => {
            currentAudioTranscript(win as unknown as AudioWindow).then((audio) => {
              swrVlmAgent.decide(pngBase64, audio.transcript, promptText).then((decision) => {
                // One keypress per trial (Cypress chain is serial; guard re-entry).
                if (trialKey === lastAnsweredKey) {
                  cy.wait(POLL_MS, { log: false });
                  playTrials(iterLeft - 1);
                  return;
                }

                const chosenLr: CorrectLr | null = decision.lr;
                const actLr: CorrectLr = decision.randomized
                  ? (chosenLr ?? (Math.random() < 0.5 ? 'left' : 'right'))
                  : (chosenLr ?? keyedLr);

                lastAnsweredKey = trialKey;
                nItems += 1;
                logRecord({
                  timestamp: new Date().toISOString(),
                  itemType: 'item',
                  correctLr: keyedLr,
                  chosenLr: actLr,
                  promptText,
                  breakMarker: null,
                  correct: actLr === keyedLr,
                  rtMs: decision.latencyMs,
                  oracle: false,
                  provider,
                  modelRaw: decision.raw,
                  latencyMs: decision.latencyMs,
                  timedOut: decision.latencyMs > TIMEOUT_MS,
                  confidence: decision.confidence,
                  hardness: decision.hardness,
                  pChild: decision.pChild,
                  randomized: decision.randomized,
                  userMode: meta.userMode,
                  blockIndex: meta.blockIndex,
                  presentationTime:
                    meta.presentationTime === 'infinite' ? null : meta.presentationTime,
                });
                cy.get('body', { log: false }).type(arrowKeyForLr(actLr, false), { log: false });
                cy.wait(AFTER_ANSWER_MS, { log: false });
                playTrials(iterLeft - 1);
              });
            });
          };

          if (needImage) {
            const screenshotName = `vlm_swr_step_${String(step).padStart(4, '0')}`;
            cy.captureViewportBase64(screenshotName).then(afterPng);
          } else {
            afterPng('');
          }
          return;
        }

        if (isSwrBreakScreen(doc, text, win, breakOpts)) {
          const now = Date.now();
          if (now - lastBreakHandledAt >= 400) {
            lastBreakHandledAt = now;
            nBreaks += 1;
            logRecord({
              timestamp: new Date().toISOString(),
              itemType: 'break',
              breakMarker: 'block_transition',
              correctLr: null,
              correct: null,
              oracle: false,
              userMode: meta.userMode,
              blockIndex: meta.blockIndex,
              presentationTime:
                meta.presentationTime === 'infinite' ? null : meta.presentationTime,
            });
            cy.get('body', { log: false }).type('{leftarrow}{rightarrow}', { log: false });
            if (!isProgressComplete(doc)) clickSwrContinue();
          }
        }

        cy.wait(POLL_MS, { log: false });
        playTrials(iterLeft - 1);
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

    // Race: practice Continue can return before the first letter-string mounts.
    // Waiting here avoids a fake block_transition spam loop.
    cy.window({ log: false }).then((win) => {
      cy.wrap(null, { timeout: 120000, log: false }).should(() => {
        expect(
          isSwrLexicalStimulus(readStimulusText(win.document)),
          'first letter-string trial after practice intro',
        ).to.eq(true);
      });
    });

    trace('before:playTrials');
    playTrials();
  });
});
