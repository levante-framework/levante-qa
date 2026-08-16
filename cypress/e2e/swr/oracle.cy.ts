import { installAudioCapture } from '../../support/audio/audioCapture';
import {
  agentLogStem,
  expectedAccuracy,
  isWrongAgentMode,
  trialRecordOracleFlag,
} from '../../support/agentMode';
import { launchTask } from '../../support/launch';
import {
  installSwrUserModeBridge,
  installSwrUserModeFlag,
  swrUserModeRuntime,
} from '../../support/swrUserModeBridge';
import { waitForRoarJsPsych } from '../../support/tasks/roar';
import {
  advanceSwrLexicalityTutorial,
  advanceSwrPracticeIntro,
  advanceSwrStartup,
  arrowKeyForLr,
  clickSwrContinue,
  dumpStoreKeys,
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
} from '../../support/tasks/swr';
import { parseSwrTrialRecord, type SwrTrialRecord } from '../../support/tasks/types';

const TASK = 'swr';
const LIVE_LOG = `cypress/logs/_swr_${agentLogStem()}_live.jsonl`;
const NO_LR_LOG = 'cypress/logs/_swr_no_correct_lr.jsonl';
const MAX_ITER = 8000;
/** Poll when waiting for the next stimulus / break (must be << 350ms timed flash). */
const POLL_MS = 40;
/** Brief settle after a keypress before the next poll. */
const AFTER_ANSWER_MS = 80;

describe(`SWR — ${isWrongAgentMode() ? 'wrong agent' : 'oracle (session correctLR)'}`, () => {
  const records: SwrTrialRecord[] = [];
  let step = 0;
  let taskComplete = false;
  let gameComplete = false;
  let nItems = 0;
  let nPractice = 0;
  let nBreaks = 0;
  let nNoLr = 0;
  let sawTimedStage = false;
  let sawUntimedStage = false;
  let loggedMode = false;
  let lastAnsweredKey: string | null = null;
  let seenTrialKey: string | null = null;
  let seenLr: 'left' | 'right' | null = null;
  let lastBreakHandledAt = 0;
  let lastStimulusAt = 0;
  /** Polls with no new answer/break after we have scored items. Caps the
   * Cypress command chain so a missed finish screen cannot stack-overflow. */
  let idlePolls = 0;
  const IDLE_COMPLETE_POLLS = 100; // ~4s at POLL_MS
  let ipPhaseStartedAt = 0;
  let currentIsPractice = false;
  let donePractice = false;
  const PRACTICE_CAP = 5;

  function logRecord(
    input: Pick<SwrTrialRecord, 'timestamp' | 'itemType' | 'oracle'> &
      Partial<
        Pick<
          SwrTrialRecord,
          | 'correctLr'
          | 'breakMarker'
          | 'correct'
          | 'rtMs'
          | 'userMode'
          | 'blockIndex'
          | 'presentationTime'
          | 'promptText'
        >
      >,
  ): void {
    step += 1;
    const rec = parseSwrTrialRecord({ ...input, task: TASK, step });
    records.push(rec);
    cy.task('writeJsonl', { path: LIVE_LOG, records: [rec] }, { log: false });
  }

  function finalize(): void {
    const ts = Date.now();
    cy.task('writeJsonl', { path: `cypress/logs/${agentLogStem()}_swr_${ts}.jsonl`, records });
    const stats = scoreTrials(records);
    const requestedMode = swrUserModeRuntime();

    cy.wrap(null).then(() => {
      expect(taskComplete || gameComplete, 'SWR run reached completion').to.equal(true);
      expect(stats.nItems, 'scored SWR item trials').to.be.greaterThan(0);
      expect(nNoLr, `trials with no session correctLR (see ${NO_LR_LOG})`).to.equal(0);
      expect(stats.accuracy ?? 0, `${agentLogStem()} accuracy`).to.equal(expectedAccuracy());
      cy.log(
        `items: ${nItems}, practice: ${nPractice}, breaks: ${nBreaks}, ` +
          `sawUntimedStage: ${sawUntimedStage}, sawTimedStage: ${sawTimedStage}`,
      );
      if (requestedMode === 'adaptiveTimingMultiStage') {
        expect(sawUntimedStage, 'adaptiveTimingMultiStage untimed stage (presentationTime infinite/null)').to.equal(
          true,
        );
        expect(sawTimedStage, 'adaptiveTimingMultiStage timed stage (350 / stage complete)').to.equal(true);
      }
    });
  }

  /** Drive trials until progress completes (locale-agnostic; mirrors SRE loop + SWR block breaks). */
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
        if (!loggedMode && meta.userMode) {
          loggedMode = true;
          cy.log(
            `SWR runtime userMode=${meta.userMode} blockIndex=${meta.blockIndex} ` +
              `presentationTime=${meta.presentationTime} firstStageComplete=${meta.firstStageComplete}`,
          );
        }
        if (
          !meta.isPractice &&
          (meta.firstStageComplete === true ||
            meta.blockIndex === 1 ||
            meta.presentationTime === 350)
        ) {
          sawTimedStage = true;
        }
        if (
          meta.presentationTime === null ||
          meta.presentationTime === 'infinite' ||
          meta.presentationTime === 'Infinity'
        ) {
          sawUntimedStage = true;
        }

        if (hasActiveStimulus(doc)) {
          const stimText = readStimulusText(doc);
          if (isSwrLexicalStimulus(stimText)) {
            const k = readSwrTrialKey(win);
            const isNewFlash = Boolean(k && k !== seenTrialKey && k !== lastAnsweredKey);
            if (k) seenTrialKey = k;
            const lrNow = readCorrectLrFromWindow(win);
            if (lrNow) seenLr = lrNow;
            // Capture practice vs test while stimulus is visible — after the 350ms
            // flash nextStimulus is cleared and would look like practice.
            if (!donePractice) {
              currentIsPractice = meta.isPractice === true;
            } else {
              currentIsPractice = false;
            }
            if (isNewFlash || !lastStimulusAt) lastStimulusAt = Date.now();
            // First poll that sees a new flash: start the RT clock, do not answer yet
            // (same-tick answers logged rtMs=0 and could miss the true LR).
            if (isNewFlash) {
              idlePolls = 0;
              cy.wait(POLL_MS, { log: false });
              playTrials(iterLeft - 1);
              return;
            }
          }
          // Non-lexical .stimulus is the 3-2-1 / "+" fixation. Fall through so a
          // flash we already saw can still be answered in the post-flash window.
        }

        if (
          isSwrAnswerableTrial(doc, win, text, {
            seenTrialKey,
            lastAnsweredKey,
            presentationTime: meta.presentationTime,
          })
        ) {
          // Prefer live key; fall back to the stimulus we already flashed.
          const trialKey = readSwrTrialKey(win) || seenTrialKey;
          // One keypress per trial — even while .stimulus is still on screen.
          if (!trialKey || trialKey === lastAnsweredKey) {
            cy.wait(POLL_MS, { log: false });
            playTrials(iterLeft - 1);
            return;
          }

          const lr = readCorrectLrFromWindow(win) || seenLr;
          if (!lr) {
            nNoLr += 1;
            cy.task(
              'writeJsonl',
              {
                path: NO_LR_LOG,
                records: [
                  {
                    step,
                    snippet: text.slice(0, 240),
                    store: nNoLr <= 3 ? dumpStoreKeys(win) : undefined,
                  },
                ],
              },
              { log: false },
            );
            // Do not guess left — that used to fail every real-word ATM trial.
            cy.wait(POLL_MS, { log: false });
            playTrials(iterLeft - 1);
            return;
          }

          idlePolls = 0;
          lastAnsweredKey = trialKey;
          const practice =
            !donePractice &&
            currentIsPractice &&
            nPractice < PRACTICE_CAP &&
            meta.blockIndex !== 1 &&
            meta.presentationTime !== 350;
          if (practice) {
            nPractice += 1;
            if (nPractice >= PRACTICE_CAP) donePractice = true;
          } else {
            nItems += 1;
            donePractice = true;
          }
          const rtMs = lastStimulusAt > 0 ? Math.max(0, Date.now() - lastStimulusAt) : null;
          lastStimulusAt = 0;
          logRecord({
            timestamp: new Date().toISOString(),
            itemType: practice ? 'practice' : 'item',
            correctLr: lr,
            breakMarker: practice ? 'ip_practice' : null,
            correct: !isWrongAgentMode(),
            rtMs,
            oracle: trialRecordOracleFlag(),
            userMode: meta.userMode,
            blockIndex: meta.blockIndex,
            presentationTime: meta.presentationTime,
            promptText: readStimulusText(doc) || trialKey,
          });
          cy.get('body', { log: false }).type(arrowKeyForLr(lr, isWrongAgentMode()), { log: false });
          // Practice trials show feedback that advances on the right arrow.
          if (practice) {
            cy.wait(300, { log: false });
            cy.get('body', { log: false }).type('{rightarrow}', { log: false });
          }
          cy.wait(AFTER_ANSWER_MS, { log: false });
          playTrials(iterLeft - 1);
          return;
        }

        // Block / stage-transition break (not inter-trial gaps).
        if (isSwrBreakScreen(doc, text, win, { seenTrialKey, lastAnsweredKey })) {
          const now = Date.now();
          if (now - lastBreakHandledAt >= 400) {
            idlePolls = 0;
            lastBreakHandledAt = now;
            nBreaks += 1;
            logRecord({
              timestamp: new Date().toISOString(),
              itemType: 'break',
              breakMarker: 'block_transition',
              correctLr: null,
              correct: null,
              oracle: trialRecordOracleFlag(),
              userMode: meta.userMode,
              blockIndex: meta.blockIndex,
              presentationTime: meta.presentationTime,
            });
            // Break / practice-feedback screens advance on a specific arrow
            // ("press the right arrow to continue"), so press both (mirrors
            // roar-dashboard's blind arrow presses) plus any Continue button.
            cy.get('body', { log: false }).type('{leftarrow}{rightarrow}', { log: false });
            if (!isProgressComplete(doc)) {
              clickSwrContinue();
            }
          }
        }
        idlePolls += 1;
        if (nItems > 0 && idlePolls >= IDLE_COMPLETE_POLLS) {
          gameComplete = true;
          finalize();
          return;
        }
        cy.wait(POLL_MS, { log: false });
        playTrials(iterLeft - 1);
      });
    });
  }

  it(
    'completes roar-swr by pressing sessionStorage correctLR through all blocks',
    { defaultCommandTimeout: 20000 },
    function completesSwrOracle() {
    // Multi-block shortRandom / ATM runs routinely need >4 minutes wall time.
    this.timeout(15 * 60 * 1000);
    Cypress.config('defaultCommandTimeout', 20000);
    const requested = swrUserModeRuntime();
    cy.log(`QA_SWR_USER_MODE=${requested ?? '(unset)'}`);
    installSwrUserModeBridge();
    launchTask({
      taskId: 'swr',
      demoUrl: 'about:blank',
      onBeforeLoad: (win) => {
        installSwrUserModeFlag(win);
        installAudioCapture(win);
      },
    });

    waitForRoarJsPsych();
    cy.then(() => {
      ipPhaseStartedAt = Date.now();
    });
    advanceSwrStartup();
    cy.then(() => {
      logRecord({
        timestamp: new Date().toISOString(),
        itemType: 'intro',
        correctLr: null,
        breakMarker: 'startup',
        correct: null,
        rtMs: Math.max(0, Date.now() - ipPhaseStartedAt),
        oracle: trialRecordOracleFlag(),
      });
      ipPhaseStartedAt = Date.now();
    });

    advanceSwrLexicalityTutorial();
    cy.then(() => {
      logRecord({
        timestamp: new Date().toISOString(),
        itemType: 'tutorial',
        correctLr: null,
        breakMarker: 'lexicality_gate',
        correct: true,
        rtMs: Math.max(0, Date.now() - ipPhaseStartedAt),
        oracle: trialRecordOracleFlag(),
      });
      ipPhaseStartedAt = Date.now();
    });

    advanceSwrPracticeIntro();
    cy.then(() => {
      logRecord({
        timestamp: new Date().toISOString(),
        itemType: 'tutorial',
        correctLr: null,
        breakMarker: 'practice_intro',
        correct: true,
        rtMs: Math.max(0, Date.now() - ipPhaseStartedAt),
        oracle: trialRecordOracleFlag(),
      });
    });

    playTrials();
  });
});
