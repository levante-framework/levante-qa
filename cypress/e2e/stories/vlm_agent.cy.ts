import storiesVlmAgent from '../../support/agents/storiesVlmAgent';
import {
  appKeyedCorrectIndex,
  buildUrl,
  isComplete,
  isInstructionScreen,
  isItemReady,
  isItemStaggering,
  isStoryBoundary,
  readChoices,
  readPromptText,
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

const MAX_STEPS = Number(Cypress.env('QA_STORIES_MAX_STEPS') ?? 4000);
const TASK = 'theory-of-mind';
const TIMEOUT_MS = 10000;
const NO_AUDIO: CurrentAudio = { url: null, transcript: null, source: null };
const STOP_AFTER_TEXT = String(Cypress.env('QA_STORIES_STOP_AFTER_TEXT') ?? '').trim();

const LIVE_LOG = 'cypress/logs/_stories_vlm_live.jsonl';

const provider = String(Cypress.env('provider') ?? 'gemini');

describe(`Stories (Theory of Mind) — VLM agent (${provider})`, () => {
  const records: StoriesTrialRecord[] = [];
  let started = false;
  let emptyStreak = 0;
  const EMPTY_DONE = 20;
  let actedKey = '';
  // Running narration of the current story, given to the model as context.
  // Reset at each story boundary so one story doesn't bleed into the next.
  let storyBeats: string[] = [];
  const questionAudio = new Map<string, CurrentAudio>();

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
    cy.task('writeJsonl', { path: `cypress/logs/vlm_stories_${provider}_${ts}.jsonl`, records });
    const scored = records.filter((r) => r.itemType === 'question' && typeof r.correct === 'boolean');
    const withAudio = records.filter((r) => r.audioTranscript);
    cy.wrap(null).then(() => {
      expect(records.length, 'recorded at least one item').to.be.greaterThan(0);
      const correct = scored.filter((r) => r.correct === true).length;
      cy.log(`VLM (${provider}) accuracy: ${correct}/${scored.length}`);
      cy.log(`audio transcripts captured: ${withAudio.length}/${records.length}`);
      expect(withAudio.length, 'captured at least one narration transcript').to.be.greaterThan(0);
    });
  }

  function shouldStopAfter(text: string | null): boolean {
    return !!STOP_AFTER_TEXT && !!text && text.toLowerCase().includes(STOP_AFTER_TEXT.toLowerCase());
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

    if (key === actedKey) {
      cy.wait(120, { log: false });
      step(i + 1);
      return;
    }

    const keyedIndex = appKeyedCorrectIndex(win);
    const hasKey = keyedIndex >= 0;
    const audio = questionAudio.get(key) ?? NO_AUDIO;
    const storyContext = storyBeats.join(' ').trim() || null;

    const screenshotName = `vlm_stories_step_${String(i).padStart(4, '0')}`;
    cy.captureViewportBase64(screenshotName).then((pngBase64: string) => {
      storiesVlmAgent.decide(pngBase64, storyContext, promptText || null, choices.length).then(
        (decision) => {
          const vlmIndex = decision.index;
          const inRange = vlmIndex !== null && vlmIndex >= 0 && vlmIndex < choices.length;
          const correct = hasKey ? inRange && vlmIndex === keyedIndex : null;
          const actIndex = inRange ? (vlmIndex as number) : hasKey ? keyedIndex : 0;

          logRecord({
            timestamp: new Date().toISOString(),
            task: TASK,
            step: i,
            itemType: 'question',
            promptText: promptText || null,
            storyContext,
            choices,
            chosenIndex: inRange ? vlmIndex : null,
            chosenValue: inRange ? (choices[vlmIndex as number] ?? null) : null,
            correct,
            keyedIndex: hasKey ? keyedIndex : null,
            keyedValue: hasKey ? (choices[keyedIndex] ?? null) : null,
            rtMs: decision.latencyMs,
            oracle: false,
            provider,
            modelRaw: decision.raw,
            latencyMs: decision.latencyMs,
            timedOut: decision.latencyMs > TIMEOUT_MS,
            audioTranscript: audio.transcript,
            audioSource: audio.source,
          });

          actedKey = key;
          cy.chooseStoriesOption(actIndex);
          cy.wait(200, { log: false });
          step(i + 1);
        },
      );
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
        handleQuestion(i, win);
        return;
      }

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

      if (isInstructionScreen(win)) {
        currentAudioTranscript(win as unknown as AudioWindow).then((audio) => {
          const text = readPromptText(win);
          // Reset story context at a story boundary; otherwise accumulate this
          // beat into the running story the model reasons over.
          if (isStoryBoundary(text)) {
            storyBeats = [];
          } else if (text) {
            storyBeats.push(text);
          }
          logRecord({
            timestamp: new Date().toISOString(),
            task: TASK,
            step: i,
            itemType: 'instructions',
            promptText: text || null,
            oracle: false,
            provider,
            audioTranscript: audio.transcript,
            audioSource: audio.source,
          });
          if (shouldStopAfter(text || audio.transcript)) {
            finalize();
            return;
          }
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

  it('drives the task via the configured VLM provider', () => {
    resetAudioCapture();
    launchTask({ taskId: 'theory-of-mind', demoUrl: buildUrl(), onBeforeLoad: installAudioCapture });
    cy.contains('OK', { timeout: 300000 }).should('be.visible').click({ force: true });
    step(0);
  });
});
