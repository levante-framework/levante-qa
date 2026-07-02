import {
  appKeyedCorrectIndex,
  buildUrl,
  isComplete,
  isInstructionScreen,
  isItemReady,
  dismissMatrixStartup,
  isMatrixPreloadBlank,
  waitForMatrixTaskResilient,
  readChoices,
  readPromptText,
  readStimulusAlt,
  scoreTrials,
  CHOICE_BUTTON,
  JSPSYCH_CONTENT,
  STIMULUS_CONTAINER,
  EXIT_BUTTON,
  type TaskWindow,
} from '../../support/tasks/matrixReasoning';
import { installAudioCapture, type AudioWindow } from '../../support/audio/audioCapture';
import { currentAudioTranscript, resetAudioCapture } from '../../support/audio/audioOracle';
import { launchTask } from '../../support/launch';
import {
  agentLogStem,
  expectedAccuracy,
  isSimMode,
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
  parseMatrixReasoningTrialRecord,
  type MatrixReasoningTrialRecord,
} from '../../support/tasks/types';

// ~78 test items + 2 practice + instructions + transitions.
const MAX_STEPS = 4000;
const TASK = 'matrix-reasoning';

const LIVE_LOG = `cypress/logs/_matrix_${agentLogStem()}_live.jsonl`;
// Items that shipped no answer key (a real content/regression bug).
const NO_KEY_LOG = 'cypress/logs/_matrix_no_key.jsonl';

const AGENT_LABEL = isWrongAgentMode()
  ? 'wrong agent'
  : isSimMode()
    ? 'simulated child (IRT-calibrated)'
    : 'oracle (key-driven)';

describe(`Matrix Reasoning — ${AGENT_LABEL}`, () => {
  const records: MatrixReasoningTrialRecord[] = [];
  let taskComplete = false;
  let started = false;
  let emptyStreak = 0;
  const EMPTY_DONE = 20;
  let nItems = 0;
  let nNoKey = 0;
  // No-key screens that turned out to be GATED (re-presented until the right
  // answer): these are the task's intro demo screens (e.g. the orange-square /
  // blue-circle example), which render like items but ship no `.correct` key by
  // design. Real test items never gate, so an ungated no-key item is still a
  // genuine content/regression bug.
  const noKeySigGated = new Map<string, boolean>();
  // Signature of the screen we last acted on. If it recurs with no intervening
  // gap (a click that didn't advance a gated practice item), we re-click rather
  // than double-count. Reset at each fixation gap so genuine new items are
  // handled fresh.
  let lastActedSig = '';
  // Consecutive re-presentations of the same NO-KEY gated screen (e.g. the
  // intro demo): with no key we don't know the right answer, so rotate through
  // the choices until the gate opens instead of repeating one wrong click
  // forever (which stalls the run until the command chain overflows).
  let gateEscapes = 0;

  function logRecord(input: Parameters<typeof parseMatrixReasoningTrialRecord>[0]): void {
    const rec = parseMatrixReasoningTrialRecord(input);
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
    return [readPromptText(win), readStimulusAlt(win), readChoices(win).join(','), corrects].join(
      '#',
    );
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
    cy.task('writeJsonl', { path: `cypress/logs/${agentLogStem()}_matrix_${ts}.jsonl`, records });
    if (isSimMode()) {
      cy.task('writeJsonl', {
        path: `cypress/logs/sim_matrix_${ts}_decisions.jsonl`,
        records: [{ config: simConfigInfo() && { ...simConfigInfo(), dByAnswer: undefined } },
          ...simDecisionLog()],
      });
    }
    const stats = scoreTrials(records);
    const withAudio = records.filter((r) => r.audioTranscript);
    cy.wrap(null).then(() => {
      expect(taskComplete, 'task reached the completion screen').to.equal(true);
      expect(stats.nItems, 'recorded item trials').to.be.greaterThan(0);
      cy.log(`items: ${nItems}, missing answer key: ${nNoKey}`);
      expect(nNoKey, `items with no answer key (see ${NO_KEY_LOG})`).to.equal(0);
      if (isSimMode()) {
        const predicted = simPredictedAccuracy() ?? 0;
        const tol = simAccuracyTolerance();
        cy.log(`sim: predicted accuracy ${predicted.toFixed(3)} ± ${tol.toFixed(3)}`);
        expect(stats.accuracy ?? 0, 'sim accuracy within the calibrated band').to.be.closeTo(
          predicted,
          tol,
        );
      } else {
        expect(stats.accuracy ?? 0, `${agentLogStem()} accuracy`).to.equal(expectedAccuracy());
      }
      expect(withAudio.length, 'captured narration transcripts').to.be.greaterThan(0);
    });
  }

  function handleItem(i: number, win: TaskWindow): void {
    const choices = readChoices(win);
    const stimulusAlt = readStimulusAlt(win);
    const promptText = readPromptText(win);
    const sig = screenSig(win);
    const keyedIndex = appKeyedCorrectIndex(win);
    const hasKey = keyedIndex >= 0;
    // Sim decisions are keyed by the item's answer value (bank `answer` ==
    // trial keyedValue) and hashed over choice values, so the same seed always
    // replays the same choices even if the app shuffles positions.
    const actIndex = hasKey
      ? isWrongAgentMode()
        ? pickWrongIndex(keyedIndex, choices.length)
        : isSimMode()
          ? simDecideIndex(keyedIndex, choices.length, choices[keyedIndex] ?? `step-${i}`, choices)
              .index
          : keyedIndex
      : 0;

    // Re-presented with no intervening gap ⇒ our prior click didn't advance a
    // gated practice item. Re-click; do not re-count. The sim escalates to the
    // keyed answer here (its recorded first answer stands) — gated practice
    // re-presents until correct, so replaying the same wrong pick would loop
    // forever, and a real child is corrected during practice anyway. No-key
    // gated screens rotate through the choices (all modes) and are retroactively
    // excluded from the no-key count: gating identifies them as intro demo
    // screens, which ship no `.correct` key by design.
    if (sig === lastActedSig) {
      gateEscapes += 1;
      if (!hasKey && !noKeySigGated.get(sig)) {
        noKeySigGated.set(sig, true);
        nNoKey -= 1;
      }
      const escIndex = hasKey
        ? isSimMode()
          ? keyedIndex
          : actIndex
        : (actIndex + gateEscapes) % Math.max(choices.length, 1);
      cy.get('body', { log: false }).then(($b) => {
        if ($b.find(CHOICE_BUTTON).length > escIndex) cy.chooseMatrixOption(escIndex);
      });
      waitChangedThenStep(i, sig);
      return;
    }
    lastActedSig = sig;
    gateEscapes = 0;

    nItems += 1;
    if (!hasKey) {
      nNoKey += 1;
      cy.task(
        'writeJsonl',
        { path: NO_KEY_LOG, records: [{ step: i, promptText, stimulusAlt, choices }] },
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
        stimulusAlt,
        choices,
        chosenIndex: actIndex,
        chosenValue: choices[actIndex] ?? null,
        correct: hasKey ? actIndex === keyedIndex : null,
        keyedIndex: hasKey ? keyedIndex : null,
        keyedValue: hasKey ? (choices[keyedIndex] ?? null) : null,
        oracle: trialRecordOracleFlag(),
        audioTranscript: audio.transcript,
        audioSource: audio.source,
      });
      cy.get('body', { log: false }).then(($b) => {
        if ($b.find(CHOICE_BUTTON).length > actIndex) cy.chooseMatrixOption(actIndex);
      });
      waitChangedThenStep(i, sig);
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
      if (isMatrixPreloadBlank(win)) {
        cy.wait(300, { log: false });
        step(i + 1);
        return;
      }
      if (isComplete(win)) {
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
          cy.continueMatrix();
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
      cy.task('getSimConfig', { taskSlug: 'matrix_reasoning' }).then((cfg) =>
        simInit(cfg as SimChildConfig),
      );
    }
    resetAudioCapture();
    launchTask({ taskId: 'matrix-reasoning', demoUrl: buildUrl(), onBeforeLoad: installAudioCapture });
    dismissMatrixStartup();
    waitForMatrixTaskResilient(installAudioCapture);
    step(0);
  });
});
