import {
  appKeyedCorrectIndex,
  buildUrl,
  isComplete,
  isInstructionScreen,
  isItemReady,
  isItemStaggering,
  readChoices,
  readPromptText,
  scoreTrials,
  type TaskWindow,
} from '../../support/tasks/stories';
import { installAudioCapture, type AudioWindow } from '../../support/audio/audioCapture';
import {
  currentAudioTranscript,
  resetAudioCapture,
  type CurrentAudio,
} from '../../support/audio/audioOracle';
import { launchTask } from '../../support/launch';
import { parseStoriesTrialRecord, type StoriesTrialRecord } from '../../support/tasks/types';

// ~60 screens (story beats + ~31 questions) across 6 stories; staggered reveal
// means several loop iterations per item, so this cap is generous. The loop
// exits on the completion screen first.
const MAX_STEPS = 4000;
const TASK = 'theory-of-mind';
const NO_AUDIO: CurrentAudio = { url: null, transcript: null, source: null };

const LIVE_LOG = 'cypress/logs/_stories_oracle_live.jsonl';
// Question items the task shipped with NO answer key (a real content/regression
// bug — every scored item must mark its correct choice under Cypress).
const NO_KEY_LOG = 'cypress/logs/_stories_no_key.jsonl';

describe('Stories (Theory of Mind) — oracle (key-driven)', () => {
  const records: StoriesTrialRecord[] = [];
  let taskComplete = false;
  let started = false;
  let emptyStreak = 0;
  const EMPTY_DONE = 20;
  // Key of the last item we answered, so lingering frames of the same question
  // don't trigger a second click. Includes the question text so consecutive
  // yes/no items (identical choice sets) are not treated as the same item.
  let actedKey = '';
  // Question narration captured during the stagger (before choice-label audio),
  // keyed by item, so the record gets the question clip, not a choice label.
  const questionAudio = new Map<string, CurrentAudio>();
  let nQuestions = 0;
  let nNoKey = 0;

  function itemKey(win: TaskWindow): string {
    return `${readPromptText(win)}::${readChoices(win).join('|')}`;
  }

  function logRecord(input: Parameters<typeof parseStoriesTrialRecord>[0]): void {
    const rec = parseStoriesTrialRecord(input);
    records.push(rec);
    cy.task('writeJsonl', { path: LIVE_LOG, records: [rec] }, { log: false });
  }

  function finalize(): void {
    const ts = Date.now();
    cy.task('writeJsonl', { path: `cypress/logs/oracle_stories_${ts}.jsonl`, records });
    const stats = scoreTrials(records);
    const withAudio = records.filter((r) => r.audioTranscript);

    cy.wrap(null).then(() => {
      expect(taskComplete, 'task reached the completion screen').to.equal(true);
      expect(stats.nQuestions, 'recorded question items').to.be.greaterThan(0);

      // Every scored item must ship an answer key (the .correct marker). A
      // missing key is a real content/regression bug — see NO_KEY_LOG.
      cy.log(`questions: ${nQuestions}, missing answer key: ${nNoKey}`);
      expect(nNoKey, `question items with no answer key (see ${NO_KEY_LOG})`).to.equal(0);

      // The oracle clicks the keyed answer, so accuracy is 1.0 iff every item
      // had a key; this asserts the task is completable end to end.
      expect(stats.accuracy ?? 0, 'oracle accuracy (clicks the app key)').to.equal(1.0);

      // Audio is exercised: story beats and questions are narrated.
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

  function handleQuestion(i: number, win: TaskWindow): void {
    const choices = readChoices(win);
    const promptText = readPromptText(win);
    const key = `${promptText}::${choices.join('|')}`;

    // Same question lingering after we answered: wait without re-acting.
    if (key === actedKey) {
      cy.wait(120, { log: false });
      step(i + 1);
      return;
    }

    const keyedIndex = appKeyedCorrectIndex(win);
    const hasKey = keyedIndex >= 0;
    const actIndex = hasKey ? keyedIndex : 0;
    const audio = questionAudio.get(key) ?? NO_AUDIO;

    nQuestions += 1;
    if (!hasKey) {
      nNoKey += 1;
      cy.task(
        'writeJsonl',
        { path: NO_KEY_LOG, records: [{ step: i, promptText, choices }] },
        { log: false },
      );
    }

    logRecord({
      timestamp: new Date().toISOString(),
      task: TASK,
      step: i,
      itemType: 'question',
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

    actedKey = key;
    cy.chooseStoriesOption(actIndex);
    cy.wait(200, { log: false });
    step(i + 1);
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

      // Choices fully revealed → answer.
      if (isItemReady(win)) {
        handleQuestion(i, win);
        return;
      }

      // Choices present but still staggering → capture the question narration
      // once (it plays before the choice-label clips), then wait it out.
      if (isItemStaggering(win)) {
        const key = itemKey(win);
        if (!questionAudio.has(key)) {
          readPrompt(win as unknown as AudioWindow, 6, (audio) => {
            questionAudio.set(key, audio);
            cy.wait(150, { log: false });
            step(i + 1);
          });
          return;
        }
        cy.wait(150, { log: false });
        step(i + 1);
        return;
      }

      // Story beat / instruction screen → capture narration, advance via OK.
      if (isInstructionScreen(win)) {
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
          cy.continueStories();
          cy.wait(200, { log: false });
          step(i + 1);
        });
        return;
      }

      cy.wait(120, { log: false });
      step(i + 1);
    });
  }

  it('completes the task by clicking the app answer key', () => {
    resetAudioCapture();
    launchTask({ taskId: 'theory-of-mind', demoUrl: buildUrl(), onBeforeLoad: installAudioCapture });
    cy.contains('OK', { timeout: 300000 }).should('be.visible').click({ force: true });
    step(0);
  });
});
