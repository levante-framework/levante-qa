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
  readCorrectLrFromWindow,
  readSwrRuntimeMeta,
  readSwrTrialKey,
  scoreTrials,
} from '../../support/tasks/swr';
import { parseSwrTrialRecord, type SwrTrialRecord } from '../../support/tasks/types';

const TASK = 'swr';
const LIVE_LOG = `cypress/logs/_swr_${agentLogStem()}_live.jsonl`;
const NO_LR_LOG = 'cypress/logs/_swr_no_correct_lr.jsonl';
const MAX_ITER = 800;
/** Poll when waiting for the next stimulus / break (must be << 350ms timed flash). */
const POLL_MS = 80;
/** Brief settle after a keypress before the next poll. */
const AFTER_ANSWER_MS = 120;

describe(`SWR — ${isWrongAgentMode() ? 'wrong agent' : 'oracle (session correctLR)'}`, () => {
  const records: SwrTrialRecord[] = [];
  let step = 0;
  let taskComplete = false;
  let gameComplete = false;
  let nItems = 0;
  let nBreaks = 0;
  let nNoLr = 0;
  let sawTimedStage = false;
  let sawUntimedStage = false;
  let loggedMode = false;
  let lastAnsweredKey: string | null = null;
  let seenTrialKey: string | null = null;

  function logRecord(
    input: Pick<SwrTrialRecord, 'timestamp' | 'itemType' | 'oracle'> &
      Partial<
        Pick<
          SwrTrialRecord,
          | 'correctLr'
          | 'breakMarker'
          | 'correct'
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
        `items: ${nItems}, breaks: ${nBreaks}, sawUntimedStage: ${sawUntimedStage}, sawTimedStage: ${sawTimedStage}`,
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
          meta.firstStageComplete === true ||
          meta.blockIndex === 1 ||
          meta.presentationTime === 350
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
          const k = readSwrTrialKey(win);
          if (k) seenTrialKey = k;
        }

        if (
          isSwrAnswerableTrial(doc, win, text, {
            seenTrialKey,
            lastAnsweredKey,
          })
        ) {
          const trialKey = readSwrTrialKey(win);
          // One keypress per trial — even while .stimulus is still on screen.
          if (trialKey && trialKey === lastAnsweredKey) {
            cy.wait(POLL_MS, { log: false });
            playTrials(iterLeft - 1);
            return;
          }

          const lr = readCorrectLrFromWindow(win);
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
            cy.get('body', { log: false }).type('{leftarrow}', { log: false });
            cy.wait(AFTER_ANSWER_MS, { log: false });
            playTrials(iterLeft - 1);
            return;
          }

          lastAnsweredKey = trialKey;
          nItems += 1;
          logRecord({
            timestamp: new Date().toISOString(),
            itemType: 'item',
            correctLr: lr,
            breakMarker: null,
            correct: !isWrongAgentMode(),
            oracle: trialRecordOracleFlag(),
            userMode: meta.userMode,
            blockIndex: meta.blockIndex,
            presentationTime: meta.presentationTime,
          });
          cy.get('body', { log: false }).type(arrowKeyForLr(lr, isWrongAgentMode()), { log: false });
          cy.wait(AFTER_ANSWER_MS, { log: false });
          playTrials(iterLeft - 1);
          return;
        }

        // Block / stage-transition break (not inter-trial gaps).
        if (isSwrBreakScreen(doc, text)) {
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
        cy.wait(POLL_MS, { log: false });
        playTrials(iterLeft - 1);
      });
    });
  }

  it('completes roar-swr by pressing sessionStorage correctLR through all blocks', () => {
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
    advanceSwrStartup();
    logRecord({
      timestamp: new Date().toISOString(),
      itemType: 'intro',
      correctLr: null,
      breakMarker: null,
      correct: null,
      oracle: trialRecordOracleFlag(),
    });

    advanceSwrLexicalityTutorial();
    logRecord({
      timestamp: new Date().toISOString(),
      itemType: 'tutorial',
      correctLr: null,
      breakMarker: 'lexicality_gate',
      correct: true,
      oracle: trialRecordOracleFlag(),
    });

    advanceSwrPracticeIntro();
    logRecord({
      timestamp: new Date().toISOString(),
      itemType: 'tutorial',
      correctLr: null,
      breakMarker: 'practice_intro',
      correct: true,
      oracle: trialRecordOracleFlag(),
    });

    playTrials();
  });
});
