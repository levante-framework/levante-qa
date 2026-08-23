import {
  agentLogStem,
  expectedAccuracy,
  isWrongAgentMode,
  trialRecordOracleFlag,
} from '../../support/agentMode';
import oracleAgent from '../../support/agents/oracleAgent';
import wrongHeartsAgent from '../../support/agents/wrongHeartsAgent';
import {
  buildUrl,
  congruency,
  correctAction,
  hasExitScreen,
  isComplete,
  isFeedback,
  isInstructionScreen,
  isStimulusReady,
  readStimulus,
  resetBlockTracker,
  type TaskWindow,
} from '../../support/tasks/heartsAndFlowers';
import { installAudioCapture, type AudioWindow } from '../../support/audio/audioCapture';
import {
  currentAudioTranscript,
  resetAudioCapture,
  type CurrentAudio,
} from '../../support/audio/audioOracle';
import { parseTrialRecord, type BlockType, type TrialRecord } from '../../support/tasks/types';
import { launchTask } from '../../support/launch';

// Safety cap on loop iterations. The loop normally exits on task completion well
// before this; it only guards against an unexpected stall.
const MAX_STEPS = 1200;
const TASK = 'hearts-and-flowers';

function hfAgent() {
  return isWrongAgentMode() ? wrongHeartsAgent : oracleAgent;
}

describe(`Hearts & Flowers — ${isWrongAgentMode() ? 'wrong agent' : 'oracle (deterministic)'}`, () => {
  const records: TrialRecord[] = [];
  let gameComplete = false;
  // Flips true once a non-empty task screen has been seen, so that an empty
  // content root during initial load is not mistaken for task completion.
  let started = false;
  // Counts consecutive polls where the content root is empty with no explicit
  // Exit screen. jsPsych empties `.jspsych-content` for a frame between blocks
  // (e.g. flowers -> mixed), which looks identical to true completion; we only
  // finalize once the empty state has persisted long enough that a slow-loading
  // next block can be ruled out, so a mid-task transition is never mistaken for
  // the end (which would skip the mixed block).
  let emptyRootStreak = 0;
  const COMPLETE_CONFIRM_POLLS = 6;
  const COMPLETE_CONFIRM_WAIT_MS = 300;

  function finalize(): void {
    const ts = Date.now();
    cy.task('writeJsonl', {
      path: `cypress/logs/${agentLogStem()}_hf_${ts}.jsonl`,
      records,
    });

    const responses = records.filter((r) => r.action === 'LEFT' || r.action === 'RIGHT');
    const blocksObserved = new Set<BlockType>(records.map((r) => r.block));

    cy.wrap(null).then(() => {
      expect(gameComplete, 'task reached the completion screen').to.equal(true);

      const correctCount = responses.filter((r) => r.correct === true).length;
      const accuracy = responses.length > 0 ? correctCount / responses.length : 0;
      expect(accuracy, `${agentLogStem()} accuracy`).to.equal(expectedAccuracy());

      const timeouts = responses.filter((r) => r.timedOut === true).length;
      expect(timeouts, 'oracle timeouts').to.equal(0);

      expect(blocksObserved.has('hearts'), 'hearts block observed').to.equal(true);
      expect(blocksObserved.has('flowers'), 'flowers block observed').to.equal(true);
      expect(blocksObserved.has('mixed'), 'mixed block observed').to.equal(true);
    });
  }

  function recordContinue(step: number, audio: CurrentAudio): void {
    records.push(
      parseTrialRecord({
        timestamp: new Date().toISOString(),
        task: TASK,
        step,
        block: 'instructions',
        shape: null,
        side: null,
        action: 'CONTINUE',
        oracle: trialRecordOracleFlag(),
        audioTranscript: audio.transcript,
        audioSource: audio.source,
      }),
    );
  }

  function step(i: number): void {
    if (i >= MAX_STEPS) {
      finalize();
      return;
    }

    cy.window().then((w) => {
      const win = w as unknown as TaskWindow;

      // 1. Done? Two completion signals, treated differently:
      //    - An explicit Exit screen is definitive: finalize immediately.
      //    - An empty/absent content root is ambiguous, because jsPsych also
      //      empties it for a frame between blocks. Confirm it persists across
      //      several polls before finalizing; otherwise a slow-loading block
      //      (e.g. the mixed block after flowers) could be misread as the end.
      //    An empty root seen before the task has started just means it is
      //    still loading.
      if (hasExitScreen(win)) {
        if (started) {
          gameComplete = true;
          finalize();
          return;
        }
        cy.wait(150);
        step(i + 1);
        return;
      }
      if (isComplete(win)) {
        if (!started) {
          cy.wait(150);
          step(i + 1);
          return;
        }
        emptyRootStreak += 1;
        if (emptyRootStreak >= COMPLETE_CONFIRM_POLLS) {
          gameComplete = true;
          finalize();
          return;
        }
        cy.wait(COMPLETE_CONFIRM_WAIT_MS);
        step(i + 1);
        return;
      }
      emptyRootStreak = 0;
      started = true;

      // 2. Feedback showing or stimulus not yet rendered: let it settle and
      //    re-check, without logging or clicking (avoids phantom trials).
      if (isFeedback(win)) {
        cy.wait(150);
        step(i + 1);
        return;
      }

      // 3. Instructions / fixation: advance with the continue button. Capture the
      //    narration transcript that plays on this screen before advancing.
      if (isInstructionScreen(win)) {
        currentAudioTranscript(win as unknown as AudioWindow).then((audio) => {
          recordContinue(i, audio);
          cy.actOnTrial('CONTINUE');
          cy.wait(250);
          step(i + 1);
        });
        return;
      }

      // 4. Response trial: wait for the stimulus image to render, then act.
      if (!isStimulusReady(win)) {
        cy.wait(100);
        step(i + 1);
        return;
      }

      const state = readStimulus(win);
      const action = hfAgent().decide(win);
      const isResponse = action === 'LEFT' || action === 'RIGHT';
      const expected = isResponse
        ? correctAction(state.shape, state.side, state.blockType)
        : null;

      currentAudioTranscript(win as unknown as AudioWindow).then((audio) => {
        records.push(
          parseTrialRecord({
            timestamp: new Date().toISOString(),
            task: TASK,
            step: i,
            block: state.blockType,
            shape: state.shape,
            side: state.side,
            congruency: state.blockType === 'mixed' ? congruency(state.shape, state.side) : null,
            action,
            // Task correctness (not "agent succeeded at its job").
            correct: isResponse ? action === expected : null,
            oracle: trialRecordOracleFlag(),
            audioTranscript: audio.transcript,
            audioSource: audio.source,
          }),
        );

        cy.actOnTrial(action);
        cy.wait(150);
        step(i + 1);
      });
    });
  }

  it('completes all blocks end-to-end', () => {
    resetBlockTracker();
    resetAudioCapture();
    launchTask({ taskId: 'hearts-and-flowers', demoUrl: buildUrl(), onBeforeLoad: installAudioCapture });
    // Wait for the app to load, then dismiss the fullscreen prompt. This also
    // guarantees the jsPsych timeline has started before the loop treats an
    // empty content root as "finished".
    cy.get('button.primary', { timeout: 60_000 }).should('be.visible').click({ force: true });
    step(0);
  });
});
