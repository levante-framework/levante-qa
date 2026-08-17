import {
  appKeyedCorrectIndex,
  buildUrl,
  isComplete,
  isInstructionScreen,
  advanceSomethingSameScreen,
  dismissFullscreenReprompt,
  dismissSdsStartup,
  isMultiSelectReady,
  isSingleSelectReady,
  isUnkeyedSingleSelect,
  isSomethingSameScreen,
  isSomethingSameItem,
  readReferenceAlt,
  solveSomethingSame,
  commitMatchPair,
  matchLayoutKey,
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
import {
  agentLogStem,
  expectedAccuracy,
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
  wrongMatchIndices,
} from '../../support/agentMode';
import type { SimChildConfig } from '../../plugins/simChildConfig';
import { parseSdsTrialRecord, type SdsTrialRecord } from '../../support/tasks/types';

// 31 single + 90 match + instructions ≈ 132 screens; this cap is generous.
const MAX_STEPS = 1500;
const TASK = 'same-different-selection';

const LIVE_LOG = `cypress/logs/_sds_${agentLogStem()}_live.jsonl`;
// Single-select items that shipped no answer key (a real content/regression bug).
const NO_KEY_LOG = 'cypress/logs/_sds_no_key.jsonl';
// Match round that never advanced (same card set + prompt repeatedly).
const MATCH_STUCK_LOG = 'cypress/logs/_sds_match_stuck.jsonl';
const MATCH_STALL_LIMIT = 15;
// Any screen (instructions / something-same / unclassified) that never advances.
// Bounds the recursive step loop so a genuine stall fails fast with a diagnostic
// instead of running until the Cypress command-chain stack overflows.
const SCREEN_STUCK_LOG = 'cypress/logs/_sds_screen_stuck.jsonl';
const SCREEN_STALL_LIMIT = 40;
/** How long to wait for `.correct` on a 4-card test-dimensions screen. */
const SINGLE_KEY_WAIT_MS = 20_000;

const AGENT_LABEL = isWrongAgentMode()
  ? 'wrong agent'
  : isSimMode()
    ? 'simulated child (IRT-calibrated)'
    : 'oracle';

describe(`Same-Different Selection — ${AGENT_LABEL}`, () => {
  const records: SdsTrialRecord[] = [];
  let taskComplete = false;
  let started = false;
  let emptyStreak = 0;
  const EMPTY_DONE = 20;
  let match: MatchState = newMatchState();
  // Single-select items already handled (keyed by prompt+cards). The oracle
  // clicks the correct card, so a single never re-presents on purpose; a repeat
  // sighting is just a lingering feedback frame, which we skip (re-handling it
  // would race the trial transition and click a vanished button). Sim may miss
  // gated practice — then we escape with the keyed answer (see handleSingle).
  const answeredSingles = new Set<string>();
  let nSingle = 0;
  let nMatch = 0;
  let nNoKey = 0;
  let matchLayoutSig = '';
  let lastMatchStallSig = '';
  let matchStallCount = 0;
  let lastScreenSig = '';
  let screenStallCount = 0;

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
   * or we give up after ~3s, then take the next step. Iterative (not recursive)
   * to avoid blowing the Cypress command-chain stack on long match stalls. */
  function waitChangedThenStep(i: number, prevSig: string, attemptsLeft = 30): void {
    if (attemptsLeft <= 0) {
      step(i + 1);
      return;
    }
    cy.wait(100, { log: false });
    cy.window({ log: false }).then((w) => {
      const win = w as unknown as TaskWindow;
      if (finished(win)) {
        taskComplete = true;
        finalize();
        return;
      }
      if (screenSig(win) !== prevSig) {
        step(i + 1);
        return;
      }
      waitChangedThenStep(i, prevSig, attemptsLeft - 1);
    });
  }

  /** Poll until `.correct` appears on an unkeyed 4-card screen, then handleSingle. */
  function waitForSingleKeyThenHandle(i: number, win: TaskWindow): void {
    const sig = screenSig(win);
    cy.wrap(null, { log: false }).then(() => {
      const deadline = Date.now() + SINGLE_KEY_WAIT_MS;
      const poll = (): void => {
        cy.window({ log: false }).then((w) => {
          const next = w as unknown as TaskWindow;
          if (finished(next) || isComplete(next)) {
            step(i + 1);
            return;
          }
          if (isSingleSelectReady(next)) {
            handleSingle(i, next);
            return;
          }
          if (screenSig(next) !== sig) {
            step(i + 1);
            return;
          }
          if (Date.now() >= deadline) {
            handleSingle(i, next);
            return;
          }
          cy.wait(250, { log: false });
          poll();
        });
      };
      poll();
    });
  }

  function finalize(): void {
    const ts = Date.now();
    cy.task('writeJsonl', { path: `cypress/logs/${agentLogStem()}_sds_${ts}.jsonl`, records });
    if (isStochasticMode()) {
      cy.task('writeJsonl', {
        path: `cypress/logs/${agentLogStem()}_sds_${ts}_decisions.jsonl`,
        records: [
          { config: simConfigInfo() && { ...simConfigInfo(), dByAnswer: undefined } },
          ...simDecisionLog(),
        ],
      });
    }
    const stats = scoreTrials(records);
    const withAudio = records.filter((r) => r.audioTranscript);
    cy.wrap(null).then(() => {
      expect(taskComplete, 'task reached the completion screen').to.equal(true);
      expect(stats.nSingle, 'single-select items recorded').to.be.greaterThan(0);
      expect(stats.nMatch, 'multi-select match items recorded').to.be.greaterThan(0);

      // Every single-select item must ship an answer key (the `.correct` marker).
      cy.log(`single: ${nSingle} (no key: ${nNoKey}), match: ${nMatch}`);
      expect(nNoKey, `single-select items with no answer key (see ${NO_KEY_LOG})`).to.equal(0);

      if (isStochasticMode()) {
        const predicted = simPredictedAccuracy() ?? 0;
        const tol = simAccuracyTolerance();
        cy.log(`${agentLogStem()}: predicted accuracy ${predicted.toFixed(3)} ± ${tol.toFixed(3)}`);
        expect(
          stats.accuracySingle ?? 0,
          `${agentLogStem()} single-select accuracy within the predicted band`,
        ).to.be.closeTo(predicted, tol);
      } else {
        // The oracle clicks the keyed card, so single-select accuracy is 1.0 iff
        // every single item had a key; this asserts the run completes end to end.
        expect(stats.accuracySingle ?? 0, `${agentLogStem()} single-select accuracy`).to.equal(
          expectedAccuracy(),
        );
      }
      expect(withAudio.length, 'captured narration transcripts').to.be.greaterThan(0);
    });
  }

  function handleSingle(i: number, win: TaskWindow): void {
    const choices = readSingleChoices(win);
    const promptText = readPromptText(win);
    const keyedIndex = appKeyedCorrectIndex(win);
    const hasKey = keyedIndex >= 0;
    // Include the keyed answer: test-dimensions items share the same card set
    // and often render prompt text as the literal "undefined" when a translation
    // key is missing, so prompt+choices alone collides across distinct items and
    // the oracle skips clicking — permanently stalling the trial.
    const key = `${promptText}::${hasKey ? choices[keyedIndex] : ''}::${choices.join('|')}`;
    const sig = screenSig(win);
    if (answeredSingles.has(key)) {
      // Sim gated practice: escalate to the keyed answer. Oracle: lingering
      // feedback frame — wait for it to clear without re-clicking.
      if (isStochasticMode() && hasKey) {
        cy.get('body', { log: false }).then(($b) => {
          if ($b.find(SINGLE_CHOICE).length > keyedIndex) cy.chooseSdsSingle(keyedIndex);
        });
        waitChangedThenStep(i, sig);
        return;
      }
      cy.wait(150, { log: false });
      step(i + 1);
      return;
    }
    answeredSingles.add(key);
    const actIndex = hasKey
      ? isWrongAgentMode()
        ? pickWrongIndex(keyedIndex, choices.length)
        : isSimMode()
          ? simDecideIndex(keyedIndex, choices.length, choices[keyedIndex] ?? `step-${i}`, choices)
              .index
          : keyedIndex
      : 0;
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
        correct: hasKey ? actIndex === keyedIndex : null,
        keyedIndex: hasKey ? keyedIndex : null,
        keyedValue: hasKey ? (choices[keyedIndex] ?? null) : null,
        oracle: trialRecordOracleFlag(),
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
    const layoutKey = `MATCH#${matchLayoutKey(choices)}`;
    if (layoutKey !== matchLayoutSig) {
      matchLayoutSig = layoutKey;
      match = newMatchState();
      matchStallCount = 0;
      lastMatchStallSig = '';
    }
    if (sig === lastMatchStallSig) {
      matchStallCount += 1;
    } else {
      matchStallCount = 0;
      lastMatchStallSig = sig;
    }
    if (matchStallCount >= MATCH_STALL_LIMIT) {
      cy.task(
        'writeJsonl',
        {
          path: MATCH_STUCK_LOG,
          records: [{ step: i, promptText, choices, matchStallCount, match }],
        },
        { log: false },
      );
      cy.wrap(null).then(() => {
        expect(
          matchStallCount,
          `match round stuck on the same card set (see ${MATCH_STUCK_LOG})`,
        ).to.be.lessThan(MATCH_STALL_LIMIT);
      });
      return;
    }
    const pair = nextMatchPair(choices, match);
    const [a, b] = isWrongAgentMode()
      ? wrongMatchIndices(pair, choices.length)
      : [pair ? pair.a : 0, pair ? pair.b : 1];
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
        oracle: trialRecordOracleFlag(),
        audioTranscript: audio.transcript,
        audioSource: audio.source,
      });
      cy.get('body', { log: false }).then(($b) => {
        if ($b.find(MULTI_CHOICE).length > Math.max(a, b)) {
          cy.chooseSdsMatch(a);
          cy.wait(100, { log: false });
          cy.chooseSdsMatch(b);
          cy.wait(100, { log: false });
          cy.confirmSdsMatch();
        }
      });
      if (pair) match = commitMatchPair(match, pair);
      waitChangedThenStep(i, sig);
    });
  }

  function handleSomethingSameTest(i: number, win: TaskWindow): void {
    const choices = readSingleChoices(win);
    const reference = readReferenceAlt(win);
    const sig = screenSig(win);
    const solved = solveSomethingSame(reference, choices);
    const baseIndex = solved >= 0 ? solved : 0;
    const actIndex = isWrongAgentMode() ? pickWrongIndex(baseIndex, choices.length) : baseIndex;
    nSingle += 1;
    currentAudioTranscript(win as unknown as AudioWindow).then((audio) => {
      logRecord({
        timestamp: new Date().toISOString(),
        task: TASK,
        step: i,
        itemType: 'single',
        promptText: readPromptText(win) || null,
        choices,
        chosenIndex: actIndex,
        chosenValue: choices[actIndex] ?? null,
        // "Something same" test items expose no DOM answer key; the choice is
        // resolved structurally (max dimension overlap with the reference card)
        // and reaching completion is the regression signal, as with match rounds.
        correct: null,
        oracle: trialRecordOracleFlag(),
        audioTranscript: audio.transcript,
        audioSource: audio.source,
      });
      cy.get('body', { log: false }).then(($b) => {
        if ($b.find(SINGLE_CHOICE).length > actIndex) cy.chooseSdsSingle(actIndex);
      });
      waitChangedThenStep(i, sig);
    });
  }

  function step(i: number): void {
    if (i >= MAX_STEPS) {
      cy.wrap(null).then(() => {
        expect(taskComplete, 'SDS reached completion before step cap').to.equal(true);
      });
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

      // Global no-progress guard: if the same screen presents unchanged for too
      // many consecutive steps it will never advance on its own (a stuck
      // practice/instruction screen). Fail fast with a diagnostic rather than
      // recursing until the command-chain stack overflows.
      const curSig = screenSig(win);
      if (curSig === lastScreenSig) {
        screenStallCount += 1;
      } else {
        screenStallCount = 0;
        lastScreenSig = curSig;
      }
      if (screenStallCount >= SCREEN_STALL_LIMIT) {
        const promptText = readPromptText(win);
        cy.task(
          'writeJsonl',
          {
            path: SCREEN_STUCK_LOG,
            records: [
              {
                step: i,
                promptText,
                screenSig: curSig,
                somethingSame: isSomethingSameScreen(win),
                instruction: isInstructionScreen(win),
                singleChoices: readSingleChoices(win),
                matchChoices: readMatchChoices(win),
              },
            ],
          },
          { log: false },
        );
        cy.wrap(null).then(() => {
          expect(
            screenStallCount,
            `screen never advanced for ${SCREEN_STALL_LIMIT} steps — likely an unhandled SDS screen (see ${SCREEN_STUCK_LOG})`,
          ).to.be.lessThan(SCREEN_STALL_LIMIT);
        });
        return;
      }

      if (isSingleSelectReady(win)) {
        matchLayoutSig = '';
        lastMatchStallSig = '';
        matchStallCount = 0;
        screenStallCount = 0;
        handleSingle(i, win);
        return;
      }
      // Same 4-card layout, key not painted yet (audio-gated / first item).
      // Wait for `.correct` so we don't stall at 5s; click anyway if it never comes.
      if (isUnkeyedSingleSelect(win)) {
        matchLayoutSig = '';
        lastMatchStallSig = '';
        matchStallCount = 0;
        screenStallCount = 0;
        waitForSingleKeyThenHandle(i, win);
        return;
      }
      if (isMultiSelectReady(win)) {
        handleMatch(i, win);
        return;
      }
      // Legacy "something same" test item (reference card + choices, no `.correct`
      // marker): resolve the matching card structurally. Checked before the wide
      // something-same demo and instruction branches it would otherwise fall past.
      if (isSomethingSameItem(win)) {
        handleSomethingSameTest(i, win);
        return;
      }
      if (isSomethingSameScreen(win)) {
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
          advanceSomethingSameScreen();
          waitChangedThenStep(i, sig);
        });
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
          cy.continueSds();
          waitChangedThenStep(i, sig);
        });
        return;
      }

      // A re-displayed fullscreen / start prompt (the browser left fullscreen)
      // is not a trial — dismiss it so the run can reach the finish screen
      // instead of polling here until the step cap.
      if (dismissFullscreenReprompt(win)) {
        cy.wait(250, { log: false });
        step(i + 1);
        return;
      }

      cy.wait(120, { log: false });
      step(i + 1);
    });
  }

  it(`completes the task as the ${AGENT_LABEL}`, () => {
    if (isSimMode()) {
      cy.task('getSimConfig', { taskSlug: 'same_different' }).then((cfg) =>
        simInit(cfg as SimChildConfig),
      );
    }
    resetAudioCapture();
    launchTask({
      taskId: 'same-different-selection',
      demoUrl: buildUrl(),
      onBeforeLoad: installAudioCapture,
    });
    dismissSdsStartup();
    step(0);
  });
});
