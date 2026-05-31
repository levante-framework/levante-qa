import {
  appKeyedCorrectIndex,
  buildUrl,
  isComplete,
  isInstructionScreen,
  isMultiSelectReady,
  isSingleSelectReady,
  nextMatchPair,
  newMatchState,
  readMatchChoices,
  readPromptText,
  readSingleChoices,
  scoreTrials,
  SINGLE_CHOICE,
  MULTI_CHOICE,
  JSPSYCH_CONTENT,
  STIMULUS_CONTAINER,
  EXIT_BUTTON,
  type MatchState,
  type TaskWindow,
} from '../../support/tasks/sameDifferent';
import { installAudioCapture, type AudioWindow } from '../../support/audio/audioCapture';
import { currentAudioTranscript, resetAudioCapture } from '../../support/audio/audioOracle';
import { launchTask } from '../../support/launch';
import { parseSdsTrialRecord, type SdsTrialRecord } from '../../support/tasks/types';

// 31 single + 90 match + instructions ≈ 132 screens; this cap is generous.
const MAX_STEPS = 1500;
const TASK = 'same-different-selection';

const LIVE_LOG = 'cypress/logs/_sds_oracle_live.jsonl';
// Single-select items that shipped no answer key (a real content/regression bug).
const NO_KEY_LOG = 'cypress/logs/_sds_no_key.jsonl';

describe('Same-Different Selection — oracle', () => {
  const records: SdsTrialRecord[] = [];
  let taskComplete = false;
  let started = false;
  let emptyStreak = 0;
  const EMPTY_DONE = 20;
  let match: MatchState = newMatchState();
  // Single-select items already handled (keyed by prompt+cards). The oracle
  // clicks the correct card, so a single never re-presents on purpose; a repeat
  // sighting is just a lingering feedback frame, which we skip (re-handling it
  // would race the trial transition and click a vanished button).
  const answeredSingles = new Set<string>();
  let nSingle = 0;
  let nMatch = 0;
  let nNoKey = 0;

  function logRecord(input: Parameters<typeof parseSdsTrialRecord>[0]): void {
    const rec = parseSdsTrialRecord(input);
    records.push(rec);
    cy.task('writeJsonl', { path: LIVE_LOG, records: [rec] }, { log: false });
  }

  function finished(win: TaskWindow): boolean {
    const doc = win.document;
    if (doc.querySelector(EXIT_BUTTON)) return true;
    const stim = doc.querySelector(STIMULUS_CONTAINER);
    return !!(stim && stim.querySelector('footer'));
  }

  /** A fingerprint of the current screen. When it changes, the trial has
   * transitioned (or a fixation gap appeared), so it is safe to make the next
   * decision — this avoids re-detecting and double-acting on one render, which
   * would corrupt the match heuristic's per-set state. */
  function screenSig(win: TaskWindow): string {
    const doc = win.document;
    const content = doc.querySelector(JSPSYCH_CONTENT);
    if (!content || content.children.length === 0) return 'EMPTY';
    const corrects = doc.querySelectorAll('.correct').length;
    return [
      readPromptText(win),
      readSingleChoices(win).join(','),
      readMatchChoices(win).join(','),
      corrects,
    ].join('#');
  }

  /** Poll until the screen signature differs from `prevSig` (the trial advanced)
   * or we give up after ~3s, then take the next step. */
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
    cy.task('writeJsonl', { path: `cypress/logs/oracle_sds_${ts}.jsonl`, records });
    const stats = scoreTrials(records);
    const withAudio = records.filter((r) => r.audioTranscript);
    cy.wrap(null).then(() => {
      expect(taskComplete, 'task reached the completion screen').to.equal(true);
      expect(stats.nSingle, 'single-select items recorded').to.be.greaterThan(0);
      expect(stats.nMatch, 'multi-select match items recorded').to.be.greaterThan(0);

      // Every single-select item must ship an answer key (the `.correct` marker).
      cy.log(`single: ${nSingle} (no key: ${nNoKey}), match: ${nMatch}`);
      expect(nNoKey, `single-select items with no answer key (see ${NO_KEY_LOG})`).to.equal(0);

      // The oracle clicks the keyed card, so single-select accuracy is 1.0 iff
      // every single item had a key; this asserts the run completes end to end.
      expect(stats.accuracySingle ?? 0, 'oracle single-select accuracy').to.equal(1.0);
      expect(withAudio.length, 'captured narration transcripts').to.be.greaterThan(0);
    });
  }

  function handleSingle(i: number, win: TaskWindow): void {
    const choices = readSingleChoices(win);
    const promptText = readPromptText(win);
    const key = `${promptText}::${choices.join('|')}`;
    // Lingering frame of an already-answered single: wait for it to clear.
    if (answeredSingles.has(key)) {
      cy.wait(150, { log: false });
      step(i + 1);
      return;
    }
    answeredSingles.add(key);
    const sig = screenSig(win);

    const keyedIndex = appKeyedCorrectIndex(win);
    const hasKey = keyedIndex >= 0;
    const actIndex = hasKey ? keyedIndex : 0;
    nSingle += 1;
    if (!hasKey) {
      nNoKey += 1;
      cy.task('writeJsonl', { path: NO_KEY_LOG, records: [{ step: i, promptText, choices }] }, { log: false });
    }
    currentAudioTranscript(win as unknown as AudioWindow).then((audio) => {
      logRecord({
        timestamp: new Date().toISOString(),
        task: TASK,
        step: i,
        itemType: 'single',
        promptText: promptText || null,
        choices,
        chosenIndex: actIndex,
        chosenValue: choices[actIndex] ?? null,
        correct: hasKey,
        keyedIndex: hasKey ? keyedIndex : null,
        keyedValue: hasKey ? (choices[keyedIndex] ?? null) : null,
        oracle: true,
        audioTranscript: audio.transcript,
        audioSource: audio.source,
      });
      cy.get('body', { log: false }).then(($b) => {
        if ($b.find(SINGLE_CHOICE).length > actIndex) cy.chooseSdsSingle(actIndex);
      });
      waitChangedThenStep(i, sig);
    });
  }

  function handleMatch(i: number, win: TaskWindow): void {
    const choices = readMatchChoices(win);
    const promptText = readPromptText(win);
    const sig = screenSig(win);
    const { pair, state } = nextMatchPair(choices, match);
    match = state;
    const a = pair ? pair.a : 0;
    const b = pair ? pair.b : 1;
    nMatch += 1;
    currentAudioTranscript(win as unknown as AudioWindow).then((audio) => {
      logRecord({
        timestamp: new Date().toISOString(),
        task: TASK,
        step: i,
        itemType: 'match',
        promptText: promptText || null,
        choices,
        selectedIndices: [a, b],
        selectedValues: [choices[a] ?? '', choices[b] ?? ''],
        matchedDimension: pair ? pair.dim : null,
        // No answer key for match rounds; completion is the regression signal.
        correct: null,
        oracle: true,
        audioTranscript: audio.transcript,
        audioSource: audio.source,
      });
      cy.get('body', { log: false }).then(($b) => {
        if ($b.find(MULTI_CHOICE).length > Math.max(a, b)) {
          cy.chooseSdsMatch(a);
          cy.chooseSdsMatch(b);
        }
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

      if (isSingleSelectReady(win)) {
        handleSingle(i, win);
        return;
      }
      if (isMultiSelectReady(win)) {
        handleMatch(i, win);
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
            oracle: true,
            audioTranscript: audio.transcript,
            audioSource: audio.source,
          });
          cy.continueSds();
          waitChangedThenStep(i, sig);
        });
        return;
      }

      cy.wait(120, { log: false });
      step(i + 1);
    });
  }

  it('completes the task (single-select via the key, match via the proven heuristic)', () => {
    resetAudioCapture();
    launchTask({
      taskId: 'same-different-selection',
      demoUrl: buildUrl(),
      onBeforeLoad: installAudioCapture,
    });
    cy.contains('OK', { timeout: 120000 }).should('be.visible').click({ force: true });
    step(0);
  });
});
