import {
  appKeyedCorrectIndex,
  buildUrl,
  isComplete,
  isInstructionScreen,
  isItemReady,
  readChoices,
  scoreTrials,
  solveFromTranscript,
  targetWordFromTranscript,
  type TaskWindow,
} from '../../support/tasks/vocab';
import { installAudioCapture, type AudioWindow } from '../../support/audio/audioCapture';
import {
  currentAudioTranscript,
  resetAudioCapture,
  type CurrentAudio,
} from '../../support/audio/audioOracle';
import { launchTask } from '../../support/launch';
import {
  agentLogStem,
  expectedAccuracy,
  isWrongAgentMode,
  pickWrongIndex,
  trialRecordOracleFlag,
} from '../../support/agentMode';
import { parseVocabTrialRecord, type VocabTrialRecord } from '../../support/tasks/types';

// The default corpus is ~171 word items + 3 instruction screens; this cap is
// generous (feedback/fixation frames mean several loop iterations per item).
// The loop normally exits on the completion screen first.
const MAX_STEPS = 4000;
const TASK = 'vocab';
// The target word is delivered only by narration, so poll for the clip to start
// before solving (same as EGMA number-identification).
const PROMPT_POLLS = 14;

// Live, append-as-you-go log so a stalled/killed run still yields its records.
const LIVE_LOG = `cypress/logs/_vocab_${agentLogStem()}_live.jsonl`;
// Items the audio-driven solver could not match to a choice (for diagnosis).
const UNSOLVED_LOG = 'cypress/logs/_vocab_unsolved.jsonl';
// Items where our independently-matched answer disagreed with the task's own
// answer key (the `.correct` marker). Each is a real bug to investigate.
const MISMATCH_LOG = 'cypress/logs/_vocab_key_mismatch.jsonl';

describe(`Vocab — ${isWrongAgentMode() ? 'wrong agent' : 'oracle (deterministic)'}`, () => {
  const records: VocabTrialRecord[] = [];
  let taskComplete = false;
  let started = false;
  // The timeline briefly empties .jspsych-content between items, so a single
  // empty frame is not completion — require sustained emptiness.
  let emptyStreak = 0;
  const EMPTY_DONE = 20;
  // Key of the item we last answered, so lingering feedback/fixation frames of
  // the same item don't trigger a second click. Vocab is NOT gated, so no
  // gate-escape is needed — a new item simply has a different key.
  let actedKey = '';
  // Differential cross-check tallies.
  let keyedChecks = 0;
  let keyMismatches = 0;

  function logRecord(input: Parameters<typeof parseVocabTrialRecord>[0]): void {
    const rec = parseVocabTrialRecord(input);
    records.push(rec);
    cy.task('writeJsonl', { path: LIVE_LOG, records: [rec] }, { log: false });
  }

  function finalize(): void {
    const ts = Date.now();
    cy.task('writeJsonl', { path: `cypress/logs/${agentLogStem()}_vocab_${ts}.jsonl`, records });

    const stats = scoreTrials(records);
    const withAudio = records.filter((r) => r.audioTranscript);

    cy.wrap(null).then(() => {
      expect(taskComplete, 'task reached the completion screen').to.equal(true);
      expect(stats.nTrials, 'recorded word items').to.be.greaterThan(0);

      if (!isWrongAgentMode()) {
        cy.log(`answer-key cross-checks: ${keyedChecks} items, ${keyMismatches} mismatch(es)`);
        expect(keyedChecks, 'task exposed its answer key (so the cross-check ran)').to.be.greaterThan(
          0,
        );
        expect(
          keyMismatches,
          `audio-matched answers disagreeing with the task's key (see ${MISMATCH_LOG})`,
        ).to.equal(0);
      }

      expect(stats.accuracy ?? 0, `${agentLogStem()} accuracy on vocab items`).to.equal(
        expectedAccuracy(),
      );

      // Audio is a hard prerequisite: the target word is only in the narration.
      expect(withAudio.length, 'captured narration transcripts').to.be.greaterThan(0);
    });
  }

  function readPrompt(win: AudioWindow, attempts: number, cb: (audio: CurrentAudio) => void): void {
    currentAudioTranscript(win).then((audio) => {
      if (audio.url || attempts <= 0) {
        cb(audio);
        return;
      }
      cy.wait(120, { log: false });
      readPrompt(win, attempts - 1, cb);
    });
  }

  function handleItem(i: number, win: TaskWindow): void {
    const choices = readChoices(win);
    const key = choices.join('|');

    // Same item still on screen after we answered (feedback/fixation frames):
    // wait without re-acting. A new item has a different choice set.
    if (key === actedKey) {
      cy.wait(120, { log: false });
      step(i + 1);
      return;
    }

    cy.wait(250, { log: false });
    readPrompt(win as unknown as AudioWindow, PROMPT_POLLS, (audio) => {
      const computed = solveFromTranscript(audio.transcript, choices);
      const keyedIndex = appKeyedCorrectIndex(win);
      const hasKey = keyedIndex >= 0;
      // Act on our independently-computed choice; only if we could not match the
      // word do we fall back to the key (purely to advance), flagged incorrect.
      const rightIndex = computed >= 0 ? computed : hasKey ? keyedIndex : 0;
      const actIndex = isWrongAgentMode()
        ? pickWrongIndex(hasKey ? keyedIndex : rightIndex, choices.length)
        : rightIndex;
      const correct = hasKey ? actIndex === keyedIndex : computed >= 0 && actIndex === rightIndex;

      if (computed < 0) {
        cy.task(
          'writeJsonl',
          {
            path: UNSOLVED_LOG,
            records: [
              { step: i, transcript: audio.transcript, choices, keyedIndex },
            ],
          },
          { log: false },
        );
      }

      if (hasKey && !isWrongAgentMode()) {
        keyedChecks += 1;
        if (computed !== keyedIndex) {
          keyMismatches += 1;
          cy.task(
            'writeJsonl',
            {
              path: MISMATCH_LOG,
              records: [
                {
                  step: i,
                  transcript: audio.transcript,
                  targetWord: targetWordFromTranscript(audio.transcript),
                  choices,
                  computedIndex: computed,
                  computedValue: computed >= 0 ? choices[computed] : null,
                  keyedIndex,
                  keyedValue: choices[keyedIndex] ?? null,
                },
              ],
            },
            { log: false },
          );
        }
      }

      logRecord({
        timestamp: new Date().toISOString(),
        task: TASK,
        step: i,
        itemType: 'word',
        promptText: audio.transcript,
        targetWord: targetWordFromTranscript(audio.transcript),
        choices,
        chosenIndex: actIndex,
        chosenValue: choices[actIndex] ?? null,
        correct,
        keyedIndex: hasKey ? keyedIndex : null,
        keyedValue: hasKey ? (choices[keyedIndex] ?? null) : null,
        oracle: trialRecordOracleFlag(),
        audioTranscript: audio.transcript,
        audioSource: audio.source,
      });

      actedKey = key;
      cy.chooseVocabOption(actIndex);
      cy.wait(180, { log: false });
      step(i + 1);
    });
  }

  function step(i: number): void {
    if (i >= MAX_STEPS) {
      finalize();
      return;
    }
    cy.window({ log: false }).then((w) => {
      const win = w as unknown as TaskWindow;

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

      if (isItemReady(win)) {
        handleItem(i, win);
        return;
      }
      if (isInstructionScreen(win)) {
        currentAudioTranscript(win as unknown as AudioWindow).then((audio) => {
          if (audio.transcript) {
            logRecord({
              timestamp: new Date().toISOString(),
              task: TASK,
              step: i,
              itemType: 'instructions',
              promptText: audio.transcript,
              oracle: trialRecordOracleFlag(),
              audioTranscript: audio.transcript,
              audioSource: audio.source,
            });
          }
          cy.continueVocab();
          cy.wait(200, { log: false });
          step(i + 1);
        });
        return;
      }

      cy.wait(120, { log: false });
      step(i + 1);
    });
  }

  it('completes the task at 100% accuracy', () => {
    resetAudioCapture();
    launchTask({ taskId: 'vocab', demoUrl: buildUrl(), onBeforeLoad: installAudioCapture });
    cy.contains('OK', { timeout: 300000 }).should('be.visible').click({ force: true });
    step(0);
  });
});
