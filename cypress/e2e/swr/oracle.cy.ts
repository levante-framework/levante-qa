import { installAudioCapture } from '../../support/audio/audioCapture';
import {
  agentLogStem,
  expectedAccuracy,
  isWrongAgentMode,
  trialRecordOracleFlag,
} from '../../support/agentMode';
import { launchTask } from '../../support/launch';
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
  scoreTrials,
  SWR_ASSET_WAIT_MS,
  SWR_EN,
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
      expect(stats.nBreaks, 'observed block markers').to.be.greaterThan(0);
      cy.log(`items: ${nItems}, breaks: ${stats.nBreaks}`);
    });
  }

  /** Recurse while `.stimulus` is present; one left+Continue when block ends. */
  function playBlockTrials(iterLeft = MAX_ITER): void {
    if (taskComplete || gameComplete || iterLeft <= 0) return;

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

          if (!hasActiveStimulus(win.document)) {
            return;
          }

          const lr = readCorrectLrFromWindow(win);
          if (!lr) {
            nNoLr += 1;
            cy.task(
              'writeJsonl',
              {
                path: NO_LR_LOG,
                records: [{ step, snippet: text.slice(0, 240) }],
              },
              { log: false },
            );
            playBlockTrials(iterLeft - 1);
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
          playBlockTrials(iterLeft - 1);
        });
      });
  }

  function endBlock(blockMarker: string, final = false): void {
    cy.wait(SWR_ASSET_WAIT_MS * 0.3, { log: false });
    cy.get('body', { log: false })
      .invoke('text')
      .then((text) => {
        if (text.includes(blockMarker)) {
          logRecord({
            timestamp: new Date().toISOString(),
            itemType: 'break',
            breakMarker: blockMarker,
            correctLr: null,
            correct: null,
            oracle: trialRecordOracleFlag(),
          });
        }
        cy.get('body', { log: false }).type('{leftarrow}', { log: false });
        if (!final) {
          clickSwrContinue();
        }
      });
  }

  function playBlock(blockMarker: string, final = false): void {
    playBlockTrials();
    endBlock(blockMarker, final);
    if (!final) {
      cy.contains(blockMarker, { timeout: 120000 }).should('be.visible');
    }
  }

  it('completes roar-swr by pressing sessionStorage correctLR through all blocks', () => {
    launchTask({
      taskId: 'swr',
      demoUrl: 'about:blank',
      onBeforeLoad: installAudioCapture,
    });

    cy.get('.jspsych-content, .jspsych-display-element', { timeout: 300000 }).should('exist');
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

    const markers = SWR_EN.blockEndMarkers;
    for (let i = 0; i < markers.length; i++) {
      const final = i === markers.length - 1;
      playBlock(markers[i], final);
    }

    cy.wrap(null).then(() => {
      gameComplete = true;
      finalize();
    });
  });
});
