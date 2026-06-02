import { installAudioCapture } from '../../support/audio/audioCapture';
import {
  agentLogStem,
  expectedAccuracy,
  isWrongAgentMode,
  trialRecordOracleFlag,
} from '../../support/agentMode';
import { launchTask } from '../../support/launch';
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
  readCorrectLrFromWindow,
  scoreTrials,
  SWR_ASSET_WAIT_MS,
  SWR_STEP_MS,
} from '../../support/tasks/swr';
import { parseSwrTrialRecord, type SwrTrialRecord } from '../../support/tasks/types';

const TASK = 'swr';
const LIVE_LOG = `cypress/logs/_swr_${agentLogStem()}_live.jsonl`;
const NO_LR_LOG = 'cypress/logs/_swr_no_correct_lr.jsonl';
const MAX_ITER = 800;

describe(`SWR — ${isWrongAgentMode() ? 'wrong agent' : 'oracle (session correctLR)'}`, () => {
  const records: SwrTrialRecord[] = [];
  let step = 0;
  let taskComplete = false;
  let gameComplete = false;
  let nItems = 0;
  let nBreaks = 0;
  let nNoLr = 0;

  function logRecord(
    input: Pick<SwrTrialRecord, 'timestamp' | 'itemType' | 'oracle'> &
      Partial<Pick<SwrTrialRecord, 'correctLr' | 'breakMarker' | 'correct'>>,
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

    cy.wrap(null).then(() => {
      expect(taskComplete || gameComplete, 'SWR run reached completion').to.equal(true);
      expect(stats.nItems, 'scored SWR item trials').to.be.greaterThan(0);
      expect(nNoLr, `trials with no session correctLR (see ${NO_LR_LOG})`).to.equal(0);
      expect(stats.accuracy ?? 0, `${agentLogStem()} accuracy`).to.equal(expectedAccuracy());
      cy.log(`items: ${nItems}, breaks: ${nBreaks}`);
    });
  }

  /** Drive trials until progress completes (locale-agnostic; mirrors SRE loop + SWR block breaks). */
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
              oracle: trialRecordOracleFlag(),
            });
            // Break / practice-feedback screens advance on a specific arrow
            // ("press the right arrow to continue"), so press both (mirrors
            // roar-dashboard's blind arrow presses) plus any Continue button.
            cy.get('body', { log: false }).type('{leftarrow}{rightarrow}', { log: false });
            if (!isProgressComplete(doc)) {
              clickSwrContinue();
            }
            cy.wait(SWR_STEP_MS * 0.2, { log: false });
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
            // Advance anyway so an unreadable trial can't stall the whole run.
            cy.get('body', { log: false }).type('{leftarrow}', { log: false });
            cy.wait(SWR_STEP_MS * 0.08, { log: false });
            playTrials(iterLeft - 1);
            return;
          }

          nItems += 1;
          logRecord({
            timestamp: new Date().toISOString(),
            itemType: 'item',
            correctLr: lr,
            breakMarker: null,
            correct: !isWrongAgentMode(),
            oracle: trialRecordOracleFlag(),
          });
          cy.get('body', { log: false }).type(arrowKeyForLr(lr, isWrongAgentMode()), { log: false });
          cy.wait(SWR_STEP_MS * 0.08, { log: false });
          playTrials(iterLeft - 1);
        });
      });
  }

  it('completes roar-swr by pressing sessionStorage correctLR through all blocks', () => {
    launchTask({
      taskId: 'swr',
      demoUrl: 'about:blank',
      onBeforeLoad: installAudioCapture,
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
