import {
  appKeyedCorrectIndex,
  buildUrl,
  isComplete,
  isInstructionScreen,
  isItemReady,
  readChoices,
  readPromptText,
  scoreTrials,
  CHOICE_BUTTON,
  JSPSYCH_CONTENT,
  STIMULUS_CONTAINER,
  EXIT_BUTTON,
  type TaskWindow,
} from '../../support/tasks/trog';
import { installAudioCapture, type AudioWindow } from '../../support/audio/audioCapture';
import { currentAudioTranscript, resetAudioCapture } from '../../support/audio/audioOracle';
import { launchTask } from '../../support/launch';
import {
  agentLogStem,
  expectedAccuracy,
  isWrongAgentMode,
  pickWrongIndex,
  trialRecordOracleFlag,
} from '../../support/agentMode';
import { parseTrogTrialRecord, type TrogTrialRecord } from '../../support/tasks/types';

// ~99 test items + instructions; this cap is generous.
const MAX_STEPS = 2500;
const TASK = 'trog';

const LIVE_LOG = `cypress/logs/_trog_${agentLogStem()}_live.jsonl`;
// Items that shipped no answer key (a real content/regression bug).
const NO_KEY_LOG = 'cypress/logs/_trog_no_key.jsonl';

describe(`TROG — ${isWrongAgentMode() ? 'wrong agent' : 'oracle (key-driven)'}`, () => {
  const records: TrogTrialRecord[] = [];
  let taskComplete = false;
  let started = false;
  let emptyStreak = 0;
  const EMPTY_DONE = 20;
  let nItems = 0;
  let nNoKey = 0;
  // Signature of the screen we last acted on. If it recurs with no intervening
  // gap (a click that didn't advance a gated practice item), we re-click rather
  // than double-count. Reset at each fixation gap.
  let lastActedSig = '';

  function logRecord(input: Parameters<typeof parseTrogTrialRecord>[0]): void {
    const rec = parseTrogTrialRecord(input);
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
    return [readPromptText(win), readChoices(win).join(','), corrects].join('#');
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
    cy.task('writeJsonl', { path: `cypress/logs/${agentLogStem()}_trog_${ts}.jsonl`, records });
    const stats = scoreTrials(records);
    const withAudio = records.filter((r) => r.audioTranscript);
    cy.wrap(null).then(() => {
      expect(taskComplete, 'task reached the completion screen').to.equal(true);
      expect(stats.nItems, 'recorded item trials').to.be.greaterThan(0);
      cy.log(`items: ${nItems}, missing answer key: ${nNoKey}`);
      expect(nNoKey, `items with no answer key (see ${NO_KEY_LOG})`).to.equal(0);
      expect(stats.accuracy ?? 0, `${agentLogStem()} accuracy`).to.equal(expectedAccuracy());
      expect(withAudio.length, 'captured narration (sentence) transcripts').to.be.greaterThan(0);
    });
  }

  function handleItem(i: number, win: TaskWindow): void {
    const choices = readChoices(win);
    const promptText = readPromptText(win);
    const sig = screenSig(win);
    const keyedIndex = appKeyedCorrectIndex(win);
    const hasKey = keyedIndex >= 0;
    const actIndex = hasKey
      ? isWrongAgentMode()
        ? pickWrongIndex(keyedIndex, choices.length)
        : keyedIndex
      : 0;

    // Re-presented with no intervening gap ⇒ our prior click didn't advance a
    // gated practice item. Re-click the key; do not re-count.
    if (sig === lastActedSig) {
      cy.get('body', { log: false }).then(($b) => {
        if ($b.find(CHOICE_BUTTON).length > actIndex) cy.chooseTrogOption(actIndex);
      });
      waitChangedThenStep(i, sig);
      return;
    }
    lastActedSig = sig;

    nItems += 1;
    if (!hasKey) {
      nNoKey += 1;
      cy.task(
        'writeJsonl',
        { path: NO_KEY_LOG, records: [{ step: i, promptText, choices }] },
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
        if ($b.find(CHOICE_BUTTON).length > actIndex) cy.chooseTrogOption(actIndex);
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
          cy.continueTrog();
          waitChangedThenStep(i, sig);
        });
        return;
      }

      cy.wait(120, { log: false });
      step(i + 1);
    });
  }

  it('completes the task by clicking the app answer key', () => {
    resetAudioCapture();
    launchTask({ taskId: 'trog', demoUrl: buildUrl(), onBeforeLoad: installAudioCapture });
    // TROG preloads a sizeable image bank; allow extra time for the loading
    // screen before the fullscreen "OK".
    cy.contains('OK', { timeout: 300000 }).should('be.visible').click({ force: true });
    step(0);
  });
});
