import {
  appKeyedCorrectIndex,
  buildUrl,
  isComplete,
  isInstructionScreen,
  isItemReady,
  readChoices,
  readChoiceSrcs,
  readPromptText,
  readTargetAlt,
  readTargetSrc,
  scoreTrials,
  CHOICE_BUTTON,
  JSPSYCH_CONTENT,
  STIMULUS_CONTAINER,
  EXIT_BUTTON,
  type TaskWindow,
} from '../../support/tasks/mentalRotation';
import { installAudioCapture, type AudioWindow } from '../../support/audio/audioCapture';
import { currentAudioTranscript, resetAudioCapture } from '../../support/audio/audioOracle';
import { launchTask } from '../../support/launch';
import {
  agentLogStem,
  isSimMode,
  isStochasticMode,
  isWrongAgentMode,
  pickWrongIndex,
  simAccuracyTolerance,
  simConfigInfo,
  simDecideIndex,
  simDecisionLog,
  simInit,
  simPredictedAccuracy,
  trialRecordOracleFlag,
} from '../../support/agentMode';
import type { SimChildConfig } from '../../plugins/simChildConfig';
import {
  parseMentalRotationTrialRecord,
  type MentalRotationTrialRecord,
} from '../../support/tasks/types';

// ~118 scored items (incl. duplicate corpus rows) + 2 practice + instructions.
const MAX_STEPS = 2500;
const TASK = 'mental-rotation';
// Minimum agreement between the pixel solver and the app's answer key. The
// solver decides rotation-vs-mirror from pixels; a few near-symmetric items can
// be genuinely ambiguous, so this is set just below the observed rate rather
// than demanding 1.0. Disagreements are logged to MISMATCH_LOG for inspection.
const MIN_SOLVER_AGREEMENT = 0.9;

const LIVE_LOG = `cypress/logs/_mr_${agentLogStem()}_live.jsonl`;
// Items that shipped no answer key (a real content/regression bug).
const NO_KEY_LOG = 'cypress/logs/_mr_no_key.jsonl';
// Items where the pixel solver disagreed with the app's `.correct` key.
const MISMATCH_LOG = 'cypress/logs/_mr_key_mismatch.jsonl';

const AGENT_LABEL = isWrongAgentMode()
  ? 'wrong agent'
  : isSimMode()
    ? 'simulated child (IRT-calibrated)'
    : 'oracle (pixel rotation/mirror solver)';

describe(`Mental Rotation — ${AGENT_LABEL}`, () => {
  const records: MentalRotationTrialRecord[] = [];
  let taskComplete = false;
  let started = false;
  let emptyStreak = 0;
  const EMPTY_DONE = 20;
  let nItems = 0;
  let nNoKey = 0;
  let nSolved = 0;
  let nAgree = 0;
  // Signature of the screen we last acted on. If it recurs with no intervening
  // gap (a wrong solver pick on a gated practice item didn't advance), we escape
  // by clicking the app key instead of re-solving. Reset at each fixation gap so
  // genuine duplicate items (separated by a gap) are still solved fresh.
  let lastActedSig = '';

  function logRecord(input: Parameters<typeof parseMentalRotationTrialRecord>[0]): void {
    const rec = parseMentalRotationTrialRecord(input);
    records.push(rec);
    cy.task('writeJsonl', { path: LIVE_LOG, records: [rec] }, { log: false });
  }

  function finished(win: TaskWindow): boolean {
    const doc = win.document;
    if (doc.querySelector(EXIT_BUTTON)) return true;
    const stim = doc.querySelector(STIMULUS_CONTAINER);
    return !!(stim && stim.querySelector('footer'));
  }

  function screenSig(win: TaskWindow): string {
    const doc = win.document;
    const content = doc.querySelector(JSPSYCH_CONTENT);
    if (!content || content.children.length === 0) return 'EMPTY';
    const corrects = doc.querySelectorAll('.correct').length;
    return [readPromptText(win), readTargetAlt(win), readChoices(win).join(','), corrects].join('#');
  }

  function waitChangedThenStep(i: number, prevSig: string, attempts = 30): void {
    cy.wait(100, { log: false });
    cy.window({ log: false }).then((w) => {
      const win = w as unknown as TaskWindow;
      if (finished(win)) {
        taskComplete = true;
        finalize();
        return;
      }
      if (screenSig(win) !== prevSig || attempts <= 0) {
        step(i + 1);
        return;
      }
      waitChangedThenStep(i, prevSig, attempts - 1);
    });
  }

  function finalize(): void {
    const ts = Date.now();
    cy.task('writeJsonl', { path: `cypress/logs/${agentLogStem()}_mr_${ts}.jsonl`, records });
    if (isStochasticMode()) {
      cy.task('writeJsonl', {
        path: `cypress/logs/${agentLogStem()}_mr_${ts}_decisions.jsonl`,
        records: [
          { config: simConfigInfo() && { ...simConfigInfo(), dByAnswer: undefined } },
          ...simDecisionLog(),
        ],
      });
    }
    const stats = scoreTrials(records);
    const withAudio = records.filter((r) => r.audioTranscript);
    const agreement = nSolved > 0 ? nAgree / nSolved : 0;
    cy.wrap(null).then(() => {
      expect(taskComplete, 'task reached the completion screen').to.equal(true);
      expect(stats.nItems, 'recorded item trials').to.be.greaterThan(0);
      cy.log(`items: ${nItems}, missing key: ${nNoKey}, solver agreement: ${nAgree}/${nSolved}`);
      expect(nNoKey, `items with no answer key (see ${NO_KEY_LOG})`).to.equal(0);
      if (isStochasticMode()) {
        const predicted = simPredictedAccuracy() ?? 0;
        const tol = simAccuracyTolerance();
        cy.log(`${agentLogStem()}: predicted accuracy ${predicted.toFixed(3)} ± ${tol.toFixed(3)}`);
        expect(
          stats.accuracy ?? 0,
          `${agentLogStem()} accuracy within the predicted band`,
        ).to.be.closeTo(predicted, tol);
      } else if (!isWrongAgentMode()) {
        expect(nSolved, 'items the pixel solver decided').to.be.greaterThan(0);
        expect(agreement, `solver/key agreement (mismatches in ${MISMATCH_LOG})`).to.be.greaterThan(
          MIN_SOLVER_AGREEMENT,
        );
      } else {
        expect(nSolved, 'wrong agent acted on scored items').to.be.greaterThan(0);
      }
      expect(withAudio.length, 'captured narration transcripts').to.be.greaterThan(0);
    });
  }

  function handleItem(i: number, win: TaskWindow): void {
    const choices = readChoices(win);
    const choiceSrcs = readChoiceSrcs(win);
    const targetAlt = readTargetAlt(win);
    const targetSrc = readTargetSrc(win);
    const promptText = readPromptText(win);
    const sig = screenSig(win);
    const keyedIndex = appKeyedCorrectIndex(win);
    const hasKey = keyedIndex >= 0;

    // Re-presented with no intervening gap ⇒ our prior pick didn't advance a
    // gated practice item. Escape by clicking the key; do not re-score.
    if (sig === lastActedSig) {
      cy.get('body', { log: false }).then(($b) => {
        if ($b.find(CHOICE_BUTTON).length > 0) cy.chooseMrOption(hasKey ? keyedIndex : 0);
      });
      waitChangedThenStep(i, sig);
      return;
    }
    lastActedSig = sig;

    // Sim twin: IRT-calibrated clicks against the app key (no pixel solver).
    if (isSimMode()) {
      const actIndex = hasKey
        ? simDecideIndex(keyedIndex, choices.length, choices[keyedIndex] ?? `step-${i}`, choices)
            .index
        : 0;
      nItems += 1;
      if (!hasKey) {
        nNoKey += 1;
        cy.task(
          'writeJsonl',
          { path: NO_KEY_LOG, records: [{ step: i, promptText, targetAlt, choices }] },
          { log: false },
        );
      }
      currentAudioTranscript(win as unknown as AudioWindow).then((audio) => {
        logRecord({
          timestamp: new Date().toISOString(),
          task: TASK,
          step: i,
          itemType: 'item',
          promptText: promptText || null,
          targetAlt,
          choices,
          chosenIndex: actIndex,
          chosenValue: choices[actIndex] ?? null,
          correct: hasKey ? actIndex === keyedIndex : null,
          keyedIndex: hasKey ? keyedIndex : null,
          keyedValue: hasKey ? (choices[keyedIndex] ?? null) : null,
          solverIndex: null,
          solverMargin: null,
          oracle: trialRecordOracleFlag(),
          audioTranscript: audio.transcript,
          audioSource: audio.source,
        });
        cy.get('body', { log: false }).then(($b) => {
          if ($b.find(CHOICE_BUTTON).length > actIndex) cy.chooseMrOption(actIndex);
        });
        waitChangedThenStep(i, sig);
      });
      return;
    }

    cy.task<import('../../support/tasks/mentalRotation').SolveResult>(
      'solveMentalRotation',
      { targetUrl: targetSrc, choiceUrls: choiceSrcs },
      { log: false },
    ).then((solve) => {
      const solverIndex = solve?.index ?? -1;
      const solved = solverIndex >= 0 && solverIndex < choices.length;
      // Authentic: click the solver's own answer. Fall back to the key only if
      // the solver couldn't decide (decode failure), so the run still advances.
      const rightIndex = solved ? solverIndex : hasKey ? keyedIndex : 0;
      const actIndex = isWrongAgentMode()
        ? pickWrongIndex(hasKey ? keyedIndex : rightIndex, choices.length)
        : rightIndex;
      const agree = solved && hasKey ? solverIndex === keyedIndex : null;

      nItems += 1;
      if (!hasKey) {
        nNoKey += 1;
        cy.task(
          'writeJsonl',
          { path: NO_KEY_LOG, records: [{ step: i, promptText, targetAlt, choices }] },
          { log: false },
        );
      }
      if (solved && hasKey) {
        nSolved += 1;
        if (agree) nAgree += 1;
        else {
          cy.task(
            'writeJsonl',
            {
              path: MISMATCH_LOG,
              records: [
                {
                  step: i,
                  promptText,
                  targetAlt,
                  targetSrc,
                  choices,
                  solverIndex,
                  keyedIndex,
                  margin: solve?.margin ?? null,
                  perChoice: solve?.perChoice ?? null,
                },
              ],
            },
            { log: false },
          );
        }
      }

      currentAudioTranscript(win as unknown as AudioWindow).then((audio) => {
        logRecord({
          timestamp: new Date().toISOString(),
          task: TASK,
          step: i,
          itemType: 'item',
          promptText: promptText || null,
          targetAlt,
          choices,
          chosenIndex: actIndex,
          chosenValue: choices[actIndex] ?? null,
          correct: agree,
          keyedIndex: hasKey ? keyedIndex : null,
          keyedValue: hasKey ? (choices[keyedIndex] ?? null) : null,
          solverIndex: solved ? solverIndex : null,
          solverMargin: solve?.margin ?? null,
          oracle: trialRecordOracleFlag(),
          audioTranscript: audio.transcript,
          audioSource: audio.source,
        });
        cy.get('body', { log: false }).then(($b) => {
          if ($b.find(CHOICE_BUTTON).length > actIndex) cy.chooseMrOption(actIndex);
        });
        waitChangedThenStep(i, sig);
      });
    });
  }

  function step(i: number): void {
    if (i >= MAX_STEPS) {
      finalize();
      return;
    }
    cy.window({ log: false }).then((w) => {
      const win = w as unknown as TaskWindow;

      if (finished(win)) {
        taskComplete = true;
        finalize();
        return;
      }
      if (isComplete(win)) {
        // Fixation / between-trial gap: reset so a duplicate item that follows is
        // solved fresh rather than treated as a non-advancing re-presentation.
        lastActedSig = '';
        if (!started) {
          cy.wait(150, { log: false });
          step(i + 1);
          return;
        }
        emptyStreak += 1;
        if (emptyStreak >= EMPTY_DONE) {
          taskComplete = true;
          finalize();
          return;
        }
        cy.wait(200, { log: false });
        step(i + 1);
        return;
      }
      started = true;
      emptyStreak = 0;

      if (isItemReady(win)) {
        handleItem(i, win);
        return;
      }
      if (isInstructionScreen(win)) {
        const sig = screenSig(win);
        currentAudioTranscript(win as unknown as AudioWindow).then((audio) => {
          logRecord({
            timestamp: new Date().toISOString(),
            task: TASK,
            step: i,
            itemType: 'instructions',
            promptText: readPromptText(win) || null,
            oracle: trialRecordOracleFlag(),
            audioTranscript: audio.transcript,
            audioSource: audio.source,
          });
          cy.continueMr();
          waitChangedThenStep(i, sig);
        });
        return;
      }

      cy.wait(120, { log: false });
      step(i + 1);
    });
  }

  it(`completes the task as the ${AGENT_LABEL}`, () => {
    if (isSimMode()) {
      cy.task('getSimConfig', { taskSlug: 'mental_rotation' }).then((cfg) =>
        simInit(cfg as SimChildConfig),
      );
    }
    resetAudioCapture();
    launchTask({ taskId: 'mental-rotation', demoUrl: buildUrl(), onBeforeLoad: installAudioCapture });
    cy.get('button.primary', { timeout: 60_000 }).should('be.visible').click({ force: true });
    step(0);
  });
});
