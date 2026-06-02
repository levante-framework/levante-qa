import sdsVlmAgent from '../../support/agents/sdsVlmAgent';
import {
  appKeyedCorrectIndex,
  buildUrl,
  isComplete,
  isInstructionScreen,
  advanceSomethingSameScreen,
  dismissSdsStartup,
  isMultiSelectReady,
  isSingleSelectReady,
  isSomethingSameScreen,
  commitMatchPair,
  matchLayoutKey,
  nextMatchPair,
  newMatchState,
  readMatchChoices,
  readPromptText,
  readSingleChoices,
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

const MAX_STEPS = 1500;
const TASK = 'same-different-selection';
const TIMEOUT_MS = 10000;

const LIVE_LOG = 'cypress/logs/_sds_vlm_live.jsonl';
const MATCH_STUCK_LOG = 'cypress/logs/_sds_match_stuck.jsonl';
const MATCH_STALL_LIMIT = 15;
const provider = String(Cypress.env('provider') ?? 'gemini');

describe(`Same-Different Selection — VLM agent (${provider})`, () => {
  const records: SdsTrialRecord[] = [];
  let taskComplete = false;
  let started = false;
  let emptyStreak = 0;
  const EMPTY_DONE = 20;
  let match: MatchState = newMatchState();
  let matchLayoutSig = '';
  let lastMatchStallSig = '';
  let matchStallCount = 0;
  // Single-select items the VLM has already answered (keyed by prompt+cards).
  // Used as a gate-escape: if the same single re-appears (our click of a wrong
  // card did not advance a practice item), click the keyed card to move on
  // without re-scoring.
  const answeredSingles = new Set<string>();

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

  /** Fingerprint of the current screen; when it changes the trial advanced. */
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

  /** Poll until the screen signature differs from `prevSig` (trial advanced) or
   * we give up after ~3s, then take the next step. Avoids double-acting on one
   * render (which would corrupt the match heuristic's per-set state). */
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

  function finalize(): void {
    const ts = Date.now();
    cy.task('writeJsonl', { path: `cypress/logs/vlm_sds_${provider}_${ts}.jsonl`, records });
    const scored = records.filter((r) => r.itemType === 'single' && typeof r.correct === 'boolean');
    const correct = scored.filter((r) => r.correct === true).length;
    cy.wrap(null).then(() => {
      expect(records.length, 'recorded at least one item').to.be.greaterThan(0);
      cy.log(`task completed: ${taskComplete}`);
      cy.log(`VLM (${provider}) single-select accuracy: ${correct}/${scored.length}`);
    });
  }

  function handleSingle(i: number, win: TaskWindow): void {
    const choices = readSingleChoices(win);
    const promptText = readPromptText(win);
    const key = `${promptText}::${choices.join('|')}`;
    const keyedIndex = appKeyedCorrectIndex(win);
    const hasKey = keyedIndex >= 0;
    const sig = screenSig(win);

    // Re-presented (our earlier wrong pick didn't advance a practice item):
    // escape by clicking the keyed card, without re-scoring.
    if (answeredSingles.has(key)) {
      cy.chooseSdsSingle(hasKey ? keyedIndex : 0);
      waitChangedThenStep(i, sig);
      return;
    }
    answeredSingles.add(key);

    const name = `vlm_sds_step_${String(i).padStart(4, '0')}`;
    let shotPath = '';
    cy.screenshot(name, {
      capture: 'viewport',
      overwrite: true,
      onAfterScreenshot(_doc, props) {
        shotPath = props.path;
      },
    });

    cy.then(() => cy.readFile(shotPath, 'base64')).then((pngBase64: string) => {
      sdsVlmAgent.decide(pngBase64, promptText || null, choices.length).then((decision) => {
        const vlmIndex = decision.index;
        const inRange = vlmIndex !== null && vlmIndex >= 0 && vlmIndex < choices.length;
        const correct = hasKey ? inRange && vlmIndex === keyedIndex : null;
        // Click the model's choice (benchmark); fall back to the key if it's out
        // of range so the run still advances.
        const actIndex = inRange ? (vlmIndex as number) : hasKey ? keyedIndex : 0;

        currentAudioTranscript(win as unknown as AudioWindow).then((audio) => {
          logRecord({
            timestamp: new Date().toISOString(),
            task: TASK,
            step: i,
            itemType: 'single',
            promptText: promptText || null,
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
          cy.get('body', { log: false }).then(($b) => {
            if ($b.find(SINGLE_CHOICE).length > actIndex) cy.chooseSdsSingle(actIndex);
          });
          waitChangedThenStep(i, sig);
        });
      });
    });
  }

  // Match rounds expose no answer key, so the VLM can't be scored on them; we
  // drive them with the proven heuristic to complete the run, recording the
  // pair (unscored) for completeness.
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
    const a = pair ? pair.a : 0;
    const b = pair ? pair.b : 1;
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
      correct: null,
      oracle: false,
      provider,
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
        matchLayoutSig = '';
        lastMatchStallSig = '';
        matchStallCount = 0;
        handleSingle(i, win);
        return;
      }
      if (isMultiSelectReady(win)) {
        handleMatch(i, win);
        return;
      }
      if (isSomethingSameScreen(win)) {
        const sig = screenSig(win);
        advanceSomethingSameScreen();
        waitChangedThenStep(i, sig);
        return;
      }
      if (isInstructionScreen(win)) {
        const sig = screenSig(win);
        cy.continueSds();
        waitChangedThenStep(i, sig);
        return;
      }

      cy.wait(120, { log: false });
      step(i + 1);
    });
  }

  it('benchmarks single-select via the VLM; auto-drives match rounds', () => {
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
