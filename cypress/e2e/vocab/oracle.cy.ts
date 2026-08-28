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
import { dumpPreloadProbe, installPreloadProbe } from '../../support/preloadProbe';
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
import { parseVocabTrialRecord, type VocabTrialRecord } from '../../support/tasks/types';

// The default corpus is ~171 word items + 3 instruction screens; this cap is
// generous (feedback/fixation frames mean several loop iterations per item).
// The loop normally exits on the completion screen first.
const MAX_STEPS = 4000;
const TASK = 'vocab';
// Boot gate: wait for vocab's first interactive screen after launch. 300 s and
// 180 s were tested; when vocab fails on `-dev` it stalls on the LEVANTE splash
// (task never mounts), so a longer gate only wastes sweep time.
// See docs/known-issues/vocab-en-US-slow-boot.md.
const BOOT_TIMEOUT_MS = 60_000;
// The target word is delivered only by narration, so poll for the clip to start
// before solving (same as EGMA number-identification).
const PROMPT_POLLS = 14;

// Vocab image alts are English asset identifiers (e.g. "ball", "pitcher")
// regardless of the narration locale, so the independent transcript→alt
// cross-check is only meaningful when the narration is also English. For other
// locales the narration is localized (e.g. "la pelota") and cannot be matched
// to the English alts without a translation table; there we drive and score the
// oracle from the app's own answer key (the `.correct` marker) instead.
function crossCheckEnabled(): boolean {
  const lang = String(Cypress.expose('QA_LANGUAGE') ?? '')
    .trim()
    .toLowerCase();
  return lang === '' || lang.startsWith('en');
}
const CROSS_CHECK = crossCheckEnabled();

// Live, append-as-you-go log so a stalled/killed run still yields its records.
const LIVE_LOG = `cypress/logs/_vocab_${agentLogStem()}_live.jsonl`;
// Items the audio-driven solver could not match to a choice (for diagnosis).
const UNSOLVED_LOG = 'cypress/logs/_vocab_unsolved.jsonl';
// Narration names a word not among the choice alts while the task still keys an
// answer — almost always a wrong audio_file in the locale corpus (not a solver gap).
const AUDIO_CONTENT_LOG = 'cypress/logs/_vocab_audio_content.jsonl';
// Items where our independently-matched answer disagreed with the task's own
// answer key (the `.correct` marker). Each is a real bug to investigate.
const MISMATCH_LOG = 'cypress/logs/_vocab_key_mismatch.jsonl';

const AGENT_LABEL = isWrongAgentMode()
  ? 'wrong agent'
  : isSimMode()
    ? 'simulated child (IRT-calibrated)'
    : isRandomMode()
      ? 'random agent (seeded uniform)'
      : 'oracle (deterministic)';

describe(`Vocab — ${AGENT_LABEL}`, () => {
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
  let nUnsolved = 0;
  let nAudioContent = 0;
  // Audio-pipeline health: the target word is delivered only by narration, so if
  // no speech plays the items are unsolvable. Check once, fail fast.
  let audioHealthChecked = false;
  const AUDIO_HEALTH_MIN_RECORDS = 3;
  const PRELOAD_PROBE_LOG = 'cypress/logs/_vocab_preload_probe.jsonl';

  afterEach(function () {
    if (this.currentTest?.state !== 'failed') return;
    cy.window({ log: false }).then((win) => {
      const dump = dumpPreloadProbe(win);
      cy.task('writeJsonl', { path: PRELOAD_PROBE_LOG, records: [dump] }, { log: false });
      cy.log(
        `preload probe inFlight=${dump.inFlightN} done=${dump.doneN} errors=${dump.errorN}` +
          (dump.inFlight[0] ? ` oldest=${dump.inFlight[0].url}` : ''),
      );
    });
  });

  function logRecord(input: Parameters<typeof parseVocabTrialRecord>[0]): void {
    const rec = parseVocabTrialRecord(input);
    records.push(rec);
    cy.task('writeJsonl', { path: LIVE_LOG, records: [rec] }, { log: false });
  }

  function finalize(): void {
    const ts = Date.now();
    cy.task('writeJsonl', { path: `cypress/logs/${agentLogStem()}_vocab_${ts}.jsonl`, records });
    if (isStochasticMode()) {
      cy.task('writeJsonl', {
        path: `cypress/logs/${agentLogStem()}_vocab_${ts}_decisions.jsonl`,
        records: [{ config: simConfigInfo() && { ...simConfigInfo(), dByAnswer: undefined } },
          ...simDecisionLog()],
      });
    }

    const stats = scoreTrials(records);
    const withAudio = records.filter((r) => r.audioTranscript);

    cy.wrap(null).then(() => {
      expect(taskComplete, 'task reached the completion screen').to.equal(true);
      expect(stats.nTrials, 'recorded word items').to.be.greaterThan(0);

      if (!isWrongAgentMode()) {
        cy.log(
          `answer-key cross-checks: ${keyedChecks} items, ${keyMismatches} mismatch(es), ${nUnsolved} unsolved, ${nAudioContent} audio/corpus`,
        );
        expect(keyedChecks, 'task exposed its answer key').to.be.greaterThan(0);
        if (CROSS_CHECK) {
          expect(
            nAudioContent,
            `narration word not among choice alts — check audio_file in locale corpus (see ${AUDIO_CONTENT_LOG})`,
          ).to.equal(0);
          expect(
            nUnsolved,
            `narration could not be matched to any choice alt (see ${UNSOLVED_LOG})`,
          ).to.equal(0);
          expect(
            keyMismatches,
            `audio solver picked a different choice than the task key (see ${MISMATCH_LOG})`,
          ).to.equal(0);
        } else {
          cy.log(
            'non-English locale: image alts are English asset names, so the narration→alt cross-check is skipped; scored against the app answer key.',
          );
        }
      }

      if (isStochasticMode()) {
        const predicted = simPredictedAccuracy() ?? 0;
        const tol = simAccuracyTolerance();
        cy.log(`${agentLogStem()}: predicted accuracy ${predicted.toFixed(3)} ± ${tol.toFixed(3)}`);
        expect(
          stats.accuracy ?? 0,
          `${agentLogStem()} accuracy within the predicted band`,
        ).to.be.closeTo(predicted, tol);
      } else {
        expect(stats.accuracy ?? 0, `${agentLogStem()} accuracy on vocab items`).to.equal(
          expectedAccuracy(),
        );
      }

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
      // The independent transcript→alt solve only runs in cross-check (English)
      // locales; elsewhere the oracle is key-driven (see CROSS_CHECK).
      const computed = CROSS_CHECK ? solveFromTranscript(audio.transcript, choices) : -1;
      const keyedIndex = appKeyedCorrectIndex(win);
      const hasKey = keyedIndex >= 0;
      const independentlySolved = computed >= 0;
      // Act on our independently-computed choice when available; otherwise the
      // app key (cross-check off, or solver miss) purely to advance.
      const rightIndex = independentlySolved ? computed : hasKey ? keyedIndex : 0;
      // Sim decisions are keyed by the item's answer value (bank `answer` ==
      // the keyed choice's alt), so the same seed always replays the same run.
      const actIndex = isWrongAgentMode()
        ? pickWrongIndex(hasKey ? keyedIndex : rightIndex, choices.length)
        : isSimMode() && hasKey
          ? simDecideIndex(keyedIndex, choices.length, choices[keyedIndex] ?? `step-${i}`, choices)
              .index
          : isRandomMode() && hasKey
            ? randomDecideIndex(
                keyedIndex,
                choices.length,
                choices[keyedIndex] ?? `step-${i}`,
                choices,
              ).index
            : rightIndex;
      // Correctness: cross-check locales score the independent solve against the
      // key; key-driven locales (and the sim/random agents) score the action
      // against the key.
      const correct =
        !CROSS_CHECK || isStochasticMode()
          ? hasKey
            ? actIndex === keyedIndex
            : null
          : hasKey
            ? independentlySolved
              ? actIndex === keyedIndex
              : false
            : independentlySolved && actIndex === rightIndex;

      // Transcript-match diagnostics are only meaningful when cross-checking.
      if (CROSS_CHECK && computed < 0) {
        const record = {
          step: i,
          audioUrl: audio.url,
          transcript: audio.transcript,
          targetWord: targetWordFromTranscript(audio.transcript),
          choices,
          keyedIndex,
          keyedValue: hasKey ? (choices[keyedIndex] ?? null) : null,
        };
        if (hasKey) {
          nAudioContent += 1;
          cy.task('writeJsonl', { path: AUDIO_CONTENT_LOG, records: [record] }, { log: false });
        } else {
          nUnsolved += 1;
          cy.task('writeJsonl', { path: UNSOLVED_LOG, records: [record] }, { log: false });
        }
      }

      if (hasKey && !isWrongAgentMode()) {
        keyedChecks += 1;
        if (CROSS_CHECK && independentlySolved && computed !== keyedIndex) {
          keyMismatches += 1;
          cy.task(
            'writeJsonl',
            {
              path: MISMATCH_LOG,
              records: [
                {
                  step: i,
                  audioUrl: audio.url,
                  transcript: audio.transcript,
                  targetWord: targetWordFromTranscript(audio.transcript),
                  choices,
                  computedIndex: computed,
                  computedValue: choices[computed] ?? null,
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

      // Audio-pipeline health check (once, after a few items).
      if (!audioHealthChecked && records.length >= AUDIO_HEALTH_MIN_RECORDS) {
        audioHealthChecked = true;
        if (!speechHasPlayed(win as unknown as AudioWindow)) {
          throw new Error(
            `No narration clips played after ${records.length} items — audio pipeline or task startup is ` +
              `broken (window.__audioPlayLog has no speech). The Vocab target word is delivered only by ` +
              `narration, so items are unsolvable; check task startup on this build ` +
              `(e.g. the TaskLevante.vue startTask error).`,
          );
        }
      }

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

  it(`completes the task as the ${AGENT_LABEL}`, () => {
    if (isSimMode()) {
      cy.task('getSimConfig', { taskSlug: 'vocab' }).then((cfg) =>
        simInit(cfg as SimChildConfig),
      );
    }
    resetAudioCapture();
    launchTask({
      taskId: 'vocab',
      demoUrl: buildUrl(),
      onBeforeLoad: (win) => {
        installPreloadProbe(win);
        installAudioCapture(win);
      },
    });
    // Locale label varies ("OK" / "Continuar."); fail with splash/alert if the task never mounts.
    waitForFirstContinue({ timeoutMs: BOOT_TIMEOUT_MS });
    step(0);
  });
});
