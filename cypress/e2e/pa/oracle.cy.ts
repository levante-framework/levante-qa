import { installAudioCapture } from '../../support/audio/audioCapture';
import {
  agentLogStem,
  expectedAccuracy,
  isWrongAgentMode,
  trialRecordOracleFlag,
} from '../../support/agentMode';
import { launchTask } from '../../support/launch';
import {
  advancePaIntro,
  clickPaContinue,
  clickWrongPaImage,
  correctImageSelector,
  isDashboardReroute,
  isProgressComplete,
  PA_ASSET_WAIT_MS,
  PA_EN,
  PA_STEP_MS,
  playPaTutorialPair,
  PROGRESS_INNER,
  readGoalFromWindow,
  scoreTrials,
} from '../../support/tasks/pa';
import { parsePaTrialRecord, type PaTrialRecord } from '../../support/tasks/types';

const TASK = 'pa';
const LIVE_LOG = `cypress/logs/_pa_${agentLogStem()}_live.jsonl`;
const NO_GOAL_LOG = 'cypress/logs/_pa_no_goal.jsonl';

describe(`PA — ${isWrongAgentMode() ? 'wrong agent' : 'oracle (sessionStorage key)'}`, () => {
  const records: PaTrialRecord[] = [];
  let step = 0;
  let gameComplete = false;
  let taskComplete = false;
  let nItems = 0;
  let nNoGoal = 0;

  function logRecord(
    input: Pick<PaTrialRecord, 'timestamp' | 'itemType' | 'oracle'> &
      Partial<Pick<PaTrialRecord, 'goal' | 'breakMarker' | 'correct'>>,
  ): void {
    step += 1;
    const rec = parsePaTrialRecord({ ...input, task: TASK, step });
    records.push(rec);
    cy.task('writeJsonl', { path: LIVE_LOG, records: [rec] }, { log: false });
  }

  function finalize(): void {
    const ts = Date.now();
    cy.task('writeJsonl', { path: `cypress/logs/${agentLogStem()}_pa_${ts}.jsonl`, records });
    const stats = scoreTrials(records);

    cy.wrap(null).then(() => {
      expect(taskComplete || gameComplete, 'PA run reached completion').to.equal(true);
      expect(stats.nItems, 'scored PA item trials').to.be.greaterThan(0);
      expect(nNoGoal, `trials with no sessionStorage goal (see ${NO_GOAL_LOG})`).to.equal(0);
      expect(stats.accuracy ?? 0, `${agentLogStem()} accuracy`).to.equal(expectedAccuracy());
      expect(stats.nBreaks, 'observed break screens').to.be.greaterThan(0);
      cy.log(`items: ${nItems}, breaks: ${stats.nBreaks}`);
    });
  }

  /**
   * Drive CAT trials until `endMarker` appears, the dashboard reroutes, or the
   * jsPsych progress bar hits 100% (ported from roar-dashboard `playTrial`).
   */
  function playTrialsUntilMarker(endMarker: string, iterLeft = 450): void {
    if (gameComplete || taskComplete || iterLeft <= 0) return;

    cy.wait(PA_ASSET_WAIT_MS, { log: false });
    cy.get('body', { log: false })
      .invoke('text')
      .then((text) => {
        if (isDashboardReroute(text)) {
          taskComplete = true;
          return;
        }
        if (endMarker.length > 0 && text.includes(endMarker)) {
          logRecord({
            timestamp: new Date().toISOString(),
            itemType: 'break',
            breakMarker: endMarker,
            goal: null,
            correct: null,
            oracle: trialRecordOracleFlag(),
          });
          return;
        }

        cy.window({ log: false }).then((win) => {
          if (isProgressComplete(win.document)) {
            gameComplete = true;
            return;
          }

          const goal = readGoalFromWindow(win);
          if (!goal) {
            nNoGoal += 1;
            cy.task(
              'writeJsonl',
              { path: NO_GOAL_LOG, records: [{ step, snippet: text.slice(0, 240) }] },
              { log: false },
            );
            if (iterLeft > 1) playTrialsUntilMarker(endMarker, iterLeft - 1);
            return;
          }

          const sel = correctImageSelector(goal);
          cy.get('body', { log: false }).then(($body) => {
            if ($body.find(sel).length === 0) {
              gameComplete = true;
              return;
            }

            nItems += 1;
            logRecord({
              timestamp: new Date().toISOString(),
              itemType: 'item',
              goal,
              breakMarker: null,
              correct: !isWrongAgentMode(),
              oracle: trialRecordOracleFlag(),
            });
            if (isWrongAgentMode()) {
              clickWrongPaImage(goal);
            } else {
              cy.get(sel, { log: false }).first().click({ force: true });
            }
            cy.wait(PA_STEP_MS * 0.05, { log: false });
            cy.get(PROGRESS_INNER, { log: false })
              .invoke('attr', 'style')
              .then((style) => {
                if (style?.includes('width: 100%')) {
                  gameComplete = true;
                  return;
                }
                playTrialsUntilMarker(endMarker, iterLeft - 1);
              });
          });
        });
      });
  }

  it('completes roar-pa by selecting sessionStorage goal on every item', () => {
    launchTask({
      taskId: 'pa',
      demoUrl: 'about:blank',
      onBeforeLoad: installAudioCapture,
    });

    cy.get('.jspsych-content', { timeout: 300000 }).should('exist');
    advancePaIntro();
    logRecord({
      timestamp: new Date().toISOString(),
      itemType: 'intro',
      goal: null,
      breakMarker: null,
      correct: null,
      oracle: trialRecordOracleFlag(),
    });

    const [t0, t1, t2, t3, t4, t5] = PA_EN.tutorials;
    playPaTutorialPair(t0, t1);
    logRecord({
      timestamp: new Date().toISOString(),
      itemType: 'tutorial',
      goal: `${t0}+${t1}`,
      breakMarker: null,
      correct: true,
      oracle: trialRecordOracleFlag(),
    });

    playTrialsUntilMarker(PA_EN.break1);
    clickPaContinue();
    playTrialsUntilMarker(PA_EN.breakRest);

    cy.wait(PA_STEP_MS * 3, { log: false });
    clickPaContinue();
    playPaTutorialPair(t2, t3, { continueFirst: false });
    logRecord({
      timestamp: new Date().toISOString(),
      itemType: 'tutorial',
      goal: `${t2}+${t3}`,
      breakMarker: null,
      correct: true,
      oracle: trialRecordOracleFlag(),
    });

    playTrialsUntilMarker(PA_EN.break2);
    clickPaContinue();
    playTrialsUntilMarker(PA_EN.breakRest);

    cy.wait(PA_STEP_MS * 3, { log: false });
    clickPaContinue();
    playTrialsUntilMarker(PA_EN.end2);

    cy.wait(PA_STEP_MS * 3, { log: false });
    clickPaContinue();
    playPaTutorialPair(t4, t5, { continueFirst: true });
    logRecord({
      timestamp: new Date().toISOString(),
      itemType: 'tutorial',
      goal: `${t4}+${t5}`,
      breakMarker: null,
      correct: true,
      oracle: trialRecordOracleFlag(),
    });

    playTrialsUntilMarker(PA_EN.break3);
    clickPaContinue();
    playTrialsUntilMarker(PA_EN.end3);

    cy.contains(PA_EN.end3, { timeout: 120000 }).should('be.visible');
    cy.wrap(null).then(() => {
      taskComplete = true;
      finalize();
    });
  });
});
