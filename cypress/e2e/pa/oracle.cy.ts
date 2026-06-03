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
  ADVANCE_BTN,
  advancePaScreen,
  clickAllPaChoices,
  clickPaContinue,
  clickCorrectPaImage,
  clickWrongPaImage,
  goalImagePresent,
  CONTINUE,
  FULLSCREEN_BTN,
  INTRO_CANVAS,
  hasPaChoices,
  isDashboardReroute,
  isProgressComplete,
  PA_ASSET_WAIT_MS,
  PA_STEP_MS,
  readGoalFromWindow,
  scoreTrials,
  waitForPaReady,
} from '../../support/tasks/pa';
import { parsePaTrialRecord, type PaTrialRecord } from '../../support/tasks/types';

const TASK = 'pa';
const LIVE_LOG = `cypress/logs/_pa_${agentLogStem()}_live.jsonl`;
const NO_GOAL_LOG = 'cypress/logs/_pa_no_goal.jsonl';
// Dumped when the same screen persists for STALL_LIMIT passes — i.e. the loop is
// stuck on a screen whose shape no branch advances (e.g. a locale-specific
// intro/end screen). Captures the DOM so the unhandled screen can be fixed
// without a multi-minute hang.
const STUCK_LOG = `cypress/logs/_pa_${agentLogStem()}_screen_stuck.jsonl`;
const STALL_LIMIT = 25;

/**
 * Language-agnostic, structural PA oracle (mirrors the SRE / SWR oracles).
 *
 * roar-pa's old oracle keyed every step off hardcoded English text (intro stem,
 * break/end markers, tutorial image stems), so it could only run in English.
 * This loop instead classifies each screen by DOM / sessionStorage shape:
 *
 *   - real AFC trial : answer-choice `.webp` images + a `currentStimulus.goal`
 *                      in sessionStorage and NO Continue button → click the goal.
 *   - tutorial demo  : choice images AND a Continue button → click every image
 *                      then Continue (the highlighted / correct one is included).
 *   - intro/break/end: no choices → click whatever advances the screen
 *                      (fullscreen → canvas → Continue / jsPsych button).
 *   - done           : progress bar at 100% or dashboard reroute.
 *
 * No localized strings, so it runs for en / de / es / es-AR / … unchanged.
 */
describe(`PA — ${isWrongAgentMode() ? 'wrong agent' : 'oracle (sessionStorage key)'}`, () => {
  const records: PaTrialRecord[] = [];
  let step = 0;
  let gameComplete = false;
  let taskComplete = false;
  let nItems = 0;
  let nNoGoal = 0;
  // No-progress guard: a signature of the current screen and how many
  // consecutive passes it has stayed identical, so a screen no branch can
  // advance fails fast (with a DOM dump) instead of spinning to MAX_ITER.
  let lastScreenSig = '';
  let screenStall = 0;
  // At most one break is logged per inter-trial gap, so nBreaks counts break
  // *events* rather than every poll that lands on the same break screen.
  let breakLoggedSinceItem = false;

  const MAX_ITER = 700;

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
      // Break screens only occur at block boundaries; a short adaptive run can
      // legitimately complete without one, so this is informational, not a gate.
      cy.log(`items: ${nItems}, breaks: ${stats.nBreaks}`);
    });
  }

  function answerTrial(goal: string): void {
    breakLoggedSinceItem = false;
    nItems += 1;
    logRecord({
      timestamp: new Date().toISOString(),
      itemType: 'item',
      goal,
      breakMarker: null,
      correct: !isWrongAgentMode(),
      oracle: trialRecordOracleFlag(),
    });
    if (isWrongAgentMode()) clickWrongPaImage(goal);
    else clickCorrectPaImage(goal);
  }

  /**
   * Single structural pass: read the current screen, take the one action its
   * shape calls for, then recurse. Completion or the iteration cap ends the loop
   * and runs `finalize`.
   */
  function playPa(iterLeft = MAX_ITER): void {
    if (gameComplete || taskComplete || iterLeft <= 0) {
      finalize();
      return;
    }

    // Short settle so freshly-rendered chrome / choices are queryable. Trials get
    // an extra post-answer wait (below) so the next stimulus is loaded before the
    // next pass reads the goal — that, not de-duping, prevents double answers.
    cy.wait(PA_ASSET_WAIT_MS * 0.2, { log: false });
    cy.window({ log: false }).then((win) => {
      const doc = win.document;
      cy.get('body', { log: false }).then(($b) => {
        const text = $b.text();
        if (isDashboardReroute(text)) {
          taskComplete = true;
          finalize();
          return;
        }
        if (isProgressComplete(doc)) {
          gameComplete = true;
          finalize();
          return;
        }

        const goal = readGoalFromWindow(win);
        const choices = hasPaChoices(doc);
        const continueVisible = $b.find(CONTINUE).filter(':visible').length > 0;

        // No-progress guard: if the screen's shape is unchanged for STALL_LIMIT
        // passes the loop is wedged on a screen no branch advances. Dump it and
        // fail fast so the unhandled (often locale-specific) screen is visible.
        const sig = [
          text.trim().slice(0, 120),
          choices ? 'C' : '',
          continueVisible ? 'K' : '',
          $b.find(FULLSCREEN_BTN).filter(':visible').length ? 'F' : '',
          $b.find(INTRO_CANVAS).filter(':visible').length ? 'I' : '',
          $b.find(ADVANCE_BTN).filter(':visible').length ? 'A' : '',
          goal ?? '',
          nItems,
        ].join('#');
        if (sig === lastScreenSig) screenStall += 1;
        else {
          screenStall = 0;
          lastScreenSig = sig;
        }
        if (screenStall >= STALL_LIMIT) {
          cy.task(
            'writeJsonl',
            {
              path: STUCK_LOG,
              records: [
                {
                  step,
                  nItems,
                  sig,
                  goal,
                  choices,
                  continueVisible,
                  buttons: [...$b.find('button, .continue, .jspsych-btn')]
                    .filter((el) => (el as HTMLElement).offsetParent !== null)
                    .map((el) => ({
                      cls: el.className,
                      text: (el.textContent ?? '').trim().slice(0, 60),
                    }))
                    .slice(0, 12),
                  bodyText: text.trim().slice(0, 600),
                  bodyHtml: doc.body?.innerHTML?.slice(0, 4000) ?? null,
                },
              ],
            },
            { log: false },
          );
          cy.wrap(null).then(() => {
            expect(
              false,
              `PA screen never advanced for ${STALL_LIMIT} passes — unhandled screen (see ${STUCK_LOG})`,
            ).to.equal(true);
          });
          return;
        }
        // Any visible advance affordance (Continue or jsPsych button) marks a
        // non-trial pause; used only to tally break screens for the summary.
        const advanceVisible = $b.find(ADVANCE_BTN).filter(':visible').length > 0;

        // Real AFC trial: answer images + answer key, no Continue button.
        if (choices && goal && !continueVisible && goalImagePresent(doc, goal)) {
          answerTrial(goal);
          cy.wait(PA_STEP_MS, { log: false });
          playPa(iterLeft - 1);
          return;
        }

        // Tutorial / guided demo: choice images shown with a Continue button.
        // Click every image (correct one included), then Continue.
        if (choices && continueVisible) {
          clickAllPaChoices();
          clickPaContinue();
          cy.wait(PA_STEP_MS * 0.1, { log: false });
          playPa(iterLeft - 1);
          return;
        }

        // Choices, no key, no Continue: either a trial whose key hasn't been
        // written yet (load lag) or a genuine missing-key bug. Wait one trial
        // step and re-read before deciding.
        if (choices && !goal) {
          cy.wait(PA_STEP_MS, { log: false });
          cy.window({ log: false }).then((win2) => {
            const retryGoal = readGoalFromWindow(win2);
            if (retryGoal && goalImagePresent(win2.document, retryGoal)) {
              answerTrial(retryGoal);
              cy.wait(PA_STEP_MS, { log: false });
              playPa(iterLeft - 1);
              return;
            }
            nNoGoal += 1;
            cy.task(
              'writeJsonl',
              { path: NO_GOAL_LOG, records: [{ step, snippet: text.slice(0, 240) }] },
              { log: false },
            );
            cy.get('img[src*=".webp"]', { log: false }).first().click({ force: true });
            cy.wait(PA_STEP_MS * 0.1, { log: false });
            playPa(iterLeft - 1);
          });
          return;
        }

        // No choices: intro / instructions / break / end / feedback / loading.
        // A pause screen after trials have started is a block-boundary break.
        if (advanceVisible && nItems > 0 && !breakLoggedSinceItem) {
          breakLoggedSinceItem = true;
          logRecord({
            timestamp: new Date().toISOString(),
            itemType: 'break',
            breakMarker: null,
            goal: null,
            correct: null,
            oracle: trialRecordOracleFlag(),
          });
        }
        advancePaScreen();
        cy.wait(PA_STEP_MS * 0.1, { log: false });
        playPa(iterLeft - 1);
      });
    });
  }

  it('completes roar-pa by selecting sessionStorage goal on every item', () => {
    launchTask({
      taskId: 'pa',
      demoUrl: 'about:blank',
      onBeforeLoad: installAudioCapture,
    });

    waitForRoarJsPsych();
    waitForPaReady();
    logRecord({
      timestamp: new Date().toISOString(),
      itemType: 'intro',
      goal: null,
      breakMarker: null,
      correct: null,
      oracle: trialRecordOracleFlag(),
    });

    playPa();
  });
});
