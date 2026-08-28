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
  speechHasPlayed,
  type CurrentAudio,
} from '../../support/audio/audioOracle';
import { launchTask } from '../../support/launch';
import { waitForFirstContinue } from '../../support/waitForFirstContinue';
import {
  agentLogStem,
  expectedAccuracy,
  isRandomMode,
  isSimMode,
  isStochasticMode,
  isWrongAgentMode,
  pickWrongIndex,
  randomDecideIndex,
  simAccuracyTolerance,
  simConfigInfo,
  simDecideIndex,
  simDecisionLog,
  simInit,
  simPredictedAccuracy,
  trialRecordOracleFlag,
} from '../../support/agentMode';
import type { SimChildConfig } from '../../plugins/simChildConfig';
import { parseStoriesTrialRecord, type StoriesTrialRecord } from '../../support/tasks/types';

// ~60 screens (story beats + ~31 questions) across 6 stories; staggered reveal
// means several loop iterations per item, so this cap is generous. The loop
// exits on the completion screen first.
const MAX_STEPS = 8000;
const TASK = 'theory-of-mind';
const NO_AUDIO: CurrentAudio = { url: null, transcript: null, source: null };
const STARTUP_OK_TIMEOUT_MS = 60_000;
const MAX_STARTUP_EMPTY_TICKS = 300; // ~45s at 150ms polls before first screen appears
const MAX_IDLE_TICKS = 600; // ~72s at 120ms polls with no actionable screen state
const STARTUP_ERROR_PATTERNS: RegExp[] = [
  /error occurred while starting the task/i,
  /not a constructor/i,
  /something went wrong/i,
  /unexpected error/i,
];

const LIVE_LOG = `cypress/logs/_stories_${agentLogStem()}_live.jsonl`;
// Question items the task shipped with NO answer key (a real content/regression
// bug — every scored item must mark its correct choice under Cypress).
const NO_KEY_LOG = 'cypress/logs/_stories_no_key.jsonl';

const AGENT_LABEL = isWrongAgentMode()
  ? 'wrong agent'
  : isSimMode()
    ? 'simulated child (IRT-calibrated)'
    : isRandomMode()
      ? 'random agent (seeded uniform)'
      : 'oracle (key-driven)';

describe(`Stories (Theory of Mind) — ${AGENT_LABEL}`, () => {
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
  let startupEmptyTicks = 0;
  let idleTicks = 0;
  // Audio-pipeline health: story beats are narrated, so once a few screens have
  // rendered the app should have played speech. If not, audio capture / task
  // startup is broken — fail fast with that cause rather than a generic stall.
  let audioHealthChecked = false;
  const AUDIO_HEALTH_MIN_RECORDS = 3;

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
    cy.task('writeJsonl', { path: `cypress/logs/${agentLogStem()}_stories_${ts}.jsonl`, records });
    if (isStochasticMode()) {
      cy.task('writeJsonl', {
        path: `cypress/logs/${agentLogStem()}_stories_${ts}_decisions.jsonl`,
        records: [{ config: simConfigInfo() && { ...simConfigInfo(), dByAnswer: undefined } },
          ...simDecisionLog()],
      });
    }
    const stats = scoreTrials(records);
    const withAudio = records.filter((r) => r.audioTranscript);

    cy.wrap(null).then(() => {
      expect(taskComplete, 'task reached the completion screen').to.equal(true);
      expect(stats.nQuestions, 'recorded question items').to.be.greaterThan(0);

      // Every scored item must ship an answer key (the .correct marker). A
      // missing key is a real content/regression bug — see NO_KEY_LOG.
      cy.log(`questions: ${nQuestions}, missing answer key: ${nNoKey}`);
      expect(nNoKey, `question items with no answer key (see ${NO_KEY_LOG})`).to.equal(0);

      if (isStochasticMode()) {
        const predicted = simPredictedAccuracy() ?? 0;
        const tol = simAccuracyTolerance();
        cy.log(`${agentLogStem()}: predicted accuracy ${predicted.toFixed(3)} ± ${tol.toFixed(3)}`);
        expect(
          stats.accuracy ?? 0,
          `${agentLogStem()} accuracy within the predicted band`,
        ).to.be.closeTo(predicted, tol);
      } else {
        // The oracle clicks the keyed answer, so accuracy is 1.0 iff every item
        // had a key; this asserts the task is completable end to end.
        expect(stats.accuracy ?? 0, `${agentLogStem()} accuracy`).to.equal(expectedAccuracy());
      }

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
    // Stories answer values repeat across questions ("no", "happy", ...), so the
    // sim hash/memo key is a composite of the prompt + sorted choices + answer;
    // the bank difficulty lookup still uses the answer value alone.
    const simKey = `${promptText}::${[...choices].sort().join('|')}::${choices[keyedIndex] ?? ''}`;
    const actIndex = hasKey
      ? isWrongAgentMode()
        ? pickWrongIndex(keyedIndex, choices.length)
        : isSimMode()
          ? simDecideIndex(keyedIndex, choices.length, simKey, choices, choices[keyedIndex]).index
          : isRandomMode()
            ? randomDecideIndex(keyedIndex, choices.length, simKey, choices).index
            : keyedIndex
      : 0;
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
      correct: hasKey ? actIndex === keyedIndex : null,
      keyedIndex: hasKey ? keyedIndex : null,
      keyedValue: hasKey ? (choices[keyedIndex] ?? null) : null,
      oracle: trialRecordOracleFlag(),
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
      const bodyText = (win.document.body?.innerText ?? win.document.body?.textContent ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      const startupErr = STARTUP_ERROR_PATTERNS.find((re) => re.test(bodyText));
      if (startupErr) {
        throw new Error(
          `Stories startup/runtime error detected (${startupErr}): ${bodyText.slice(0, 300)}`,
        );
      }

      if (isComplete(win)) {
        if (!started) {
          startupEmptyTicks += 1;
          if (startupEmptyTicks >= MAX_STARTUP_EMPTY_TICKS) {
            throw new Error(
              'Stories startup made no visible progress for ~45s (jsPsych content remained empty).',
            );
          }
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
      startupEmptyTicks = 0;
      emptyStreak = 0;

      // Audio-pipeline health check (once, after a few narrated beats).
      if (!audioHealthChecked && records.length >= AUDIO_HEALTH_MIN_RECORDS) {
        audioHealthChecked = true;
        if (!speechHasPlayed(win as unknown as AudioWindow)) {
          throw new Error(
            `No narration clips played after ${records.length} screens — audio pipeline or task startup is ` +
              `broken (window.__audioPlayLog has no speech). Stories questions depend on narrated context; ` +
              `check task startup on this build (e.g. the TaskLevante.vue startTask error).`,
          );
        }
      }

      // Choices fully revealed → answer.
      if (isItemReady(win)) {
        idleTicks = 0;
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
            idleTicks = 0;
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
        idleTicks = 0;
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
          cy.continueStories();
          cy.wait(200, { log: false });
          step(i + 1);
        });
        return;
      }

      idleTicks += 1;
      if (idleTicks >= MAX_IDLE_TICKS) {
        throw new Error(
          'Stories runner made no actionable progress for ~72s (no ready question or enabled instruction button).',
        );
      }
      cy.wait(120, { log: false });
      step(i + 1);
    });
  }

  it(`completes the task as the ${AGENT_LABEL}`, () => {
    if (isSimMode()) {
      cy.task('getSimConfig', { taskSlug: 'stories' }).then((cfg) =>
        simInit(cfg as SimChildConfig),
      );
    }
    resetAudioCapture();
    launchTask({ taskId: 'theory-of-mind', demoUrl: buildUrl(), onBeforeLoad: installAudioCapture });
    // Fail fast when the task never mounts (start alert / splash), not just when
    // the Continue selector is missing.
    waitForFirstContinue({ timeoutMs: STARTUP_OK_TIMEOUT_MS });
    step(0);
  });
});
