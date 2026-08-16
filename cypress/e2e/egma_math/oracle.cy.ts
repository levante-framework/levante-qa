import {
  appKeyedCorrectIndex,
  buildUrl,
  classifyItem,
  isComplete,
  isFractionItem,
  isInstructionScreen,
  isItemReady,
  isSliderScreen,
  readChoices,
  readStimulusText,
  scoreTrials,
  solveFractionItem,
  solveItem,
  solveNumberLine,
  RESPONSE_ROW,
  SLIDER,
  type TaskWindow,
} from '../../support/tasks/egmaMath';
import { installAudioCapture, type AudioWindow } from '../../support/audio/audioCapture';
import {
  currentAudioTranscript,
  resetAudioCapture,
  speechHasPlayed,
  type CurrentAudio,
} from '../../support/audio/audioOracle';
import { isDashboardLaunch, launchTask } from '../../support/launch';
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

const NO_AUDIO: CurrentAudio = { url: null, transcript: null, source: null };
import {
  parseEgmaTrialRecord,
  type EgmaItemType,
  type EgmaTrialRecord,
} from '../../support/tasks/types';

// Safety cap on loop iterations. The task is long (~90+ items across 7 sections)
// so this is generous; the loop normally exits on the completion screen first.
// The full task is ~320 items across 7 sections, and feedback/transition frames
// mean ~10 loop iterations per item, so the cap is generous. The loop exits
// early on real completion (sustained empty content); this only guards a stall.
const MAX_STEPS = 4500;
const TASK = 'egma-math';
// Polls for the item's narration to start before solving. Audio-only types
// (number identification, comparison) carry the question only in the clip.
const PROMPT_POLLS = 12;
// A placement whose target falls within the slider's range is exact; a larger
// fractional error would indicate the input scale != the number-line scale.
const NUMBER_LINE_TOLERANCE = 0.02;
// After this many consecutive frames showing the same item we just answered, we
// treat it as a gated practice re-presentation (a wrong answer that won't
// advance) rather than transient feedback, and cycle to another choice so the
// run can complete. Must exceed the longest feedback animation.
const GATE_PERSIST = 18;

// Live, append-as-you-go log so a stalled/killed run still yields the records
// captured so far (useful for diagnosing where the task got stuck).
const LIVE_LOG = `cypress/logs/_egma_${agentLogStem()}_live.jsonl`;
// Full-DOM dumps of items the deterministic solver could not answer, so new/odd
// item formats can be diagnosed without a live debugging session.
const UNSOLVED_LOG = 'cypress/logs/_egma_unsolved_dom.jsonl';
// Items where our computed answer disagreed with the task's own embedded answer
// key (the `.correct`/`aria-label=correct` marker rendered under Cypress). Each
// entry is a real bug to investigate — in the task's key or in our solver.
const MISMATCH_LOG = 'cypress/logs/_egma_key_mismatch.jsonl';

const AGENT_LABEL = isWrongAgentMode()
  ? 'wrong agent'
  : isSimMode()
    ? 'simulated child (IRT-calibrated)'
    : isRandomMode()
      ? 'random agent (seeded uniform)'
      : 'oracle (deterministic)';

describe(`EGMA math — ${AGENT_LABEL}`, () => {
  const records: EgmaTrialRecord[] = [];
  let taskComplete = false;
  let started = false;
  // EGMA empties .jspsych-content for a beat when moving between sections, so a
  // single empty frame is NOT completion — require sustained emptiness.
  let emptyStreak = 0;
  const EMPTY_DONE = 20; // ~4s at 200ms/poll
  // While the same item lingers (feedback "Good job!" frames after a response)
  // we wait instead of re-acting. Choice items key on their choices; slider
  // items on their stimulus.
  // Gate-escape bookkeeping: the key of the item we last acted on, how many
  // consecutive frames it has persisted, and which choice indices we have tried
  // for it (so a gated practice item can be escaped by cycling choices).
  let actedKey = '';
  let sameKeyFrames = 0;
  let triedIndices = new Set<number>();
  let lastSliderKey = '';
  let sliderDumped = false;
  // Differential cross-check tallies: how many items exposed the app's answer
  // key, and how many of those disagreed with our computed answer.
  let keyedChecks = 0;
  let keyMismatches = 0;
  // Audio-pipeline health: if no narration clip ever plays, audio-only items
  // (number identification) are unsolvable and surface as confusing key
  // mismatches. We check once, after a few items, and fail fast with a clear
  // message pointing at the audio pipeline / task startup instead.
  let audioHealthChecked = false;
  const AUDIO_HEALTH_MIN_ITEMS = 5;

  /** Record a trial: keep it in memory and append it to the live log. */
  function logRecord(input: Parameters<typeof parseEgmaTrialRecord>[0]): void {
    const rec = parseEgmaTrialRecord(input);
    records.push(rec);
    cy.task('writeJsonl', { path: LIVE_LOG, records: [rec] }, { log: false });
  }

  function finalize(): void {
    const ts = Date.now();
    // Diagnose HOW the task ended: EGMA's only completion signal is sustained
    // empty jspsych content, so record what the final screen actually shows
    // (any visible text? an exit button?) plus a screenshot. A run that ends
    // with no text and no exit affordance ended on a genuinely blank screen.
    cy.window({ log: false }).then((w) => {
      const doc = (w as unknown as TaskWindow).document;
      const bodyText = (doc.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
      const content = doc.querySelector('.jspsych-content');
      cy.task('writeJsonl', {
        path: 'cypress/logs/_egma_final_screen.jsonl',
        records: [
          {
            timestamp: new Date().toISOString(),
            agent: agentLogStem(),
            bodyText,
            jspsychChildren: content ? content.children.length : -1,
            hasExitButton: Array.from(doc.querySelectorAll('button')).some((b) =>
              /exit/i.test(b.textContent ?? ''),
            ),
          },
        ],
      });
    });
    cy.screenshot(`egma-final-${agentLogStem()}`, { capture: 'viewport' });
    cy.task('writeJsonl', { path: `cypress/logs/${agentLogStem()}_egma_${ts}.jsonl`, records });
    if (isStochasticMode()) {
      cy.task('writeJsonl', {
        path: `cypress/logs/${agentLogStem()}_egma_${ts}_decisions.jsonl`,
        records: [{ config: simConfigInfo() && { ...simConfigInfo(), dByAnswer: undefined } },
          ...simDecisionLog()],
      });
    }

    const stats = scoreTrials(records);
    const typesObserved = new Set<EgmaItemType>(records.map((r) => r.itemType));
    const withAudio = records.filter((r) => r.audioTranscript);

    cy.wrap(null).then(() => {
      expect(taskComplete, 'task reached the completion screen').to.equal(true);
      expect(stats.nTrials, 'recorded response items').to.be.greaterThan(0);

      if (!isWrongAgentMode()) {
        cy.log(`answer-key cross-checks: ${keyedChecks} items, ${keyMismatches} mismatch(es)`);
        expect(keyedChecks, "task exposed its answer key (so the cross-check ran)").to.be.greaterThan(0);
        expect(keyMismatches, `computed answers disagreeing with the task's key (see ${MISMATCH_LOG})`).to.equal(0);
        if (typesObserved.has('number-line')) {
          expect(
            stats.numberLineMeanError ?? 1,
            'number-line mean placement error',
          ).to.be.lessThan(NUMBER_LINE_TOLERANCE);
        }
      }

      if (isStochasticMode()) {
        const predicted = simPredictedAccuracy() ?? 0;
        const tol = simAccuracyTolerance();
        cy.log(`${agentLogStem()}: predicted accuracy ${predicted.toFixed(3)} ± ${tol.toFixed(3)}`);
        expect(
          stats.accChoice ?? 0,
          `${agentLogStem()} choice accuracy within the predicted band`,
        ).to.be.closeTo(predicted, tol);
      } else {
        expect(stats.accChoice, `${agentLogStem()} accuracy on multiple-choice items`).to.equal(
          expectedAccuracy(),
        );
      }

      // Audio is a hard prerequisite: number identification has no on-screen text.
      expect(withAudio.length, 'captured narration transcripts').to.be.greaterThan(0);

      // The signature audio-driven and visual types must all have been exercised.
      expect(typesObserved.has('number-identification'), 'number-identification observed').to.equal(
        true,
      );
      expect(typesObserved.has('number-comparison'), 'number-comparison observed').to.equal(true);
      expect(typesObserved.has('arithmetic'), 'arithmetic observed').to.equal(true);
      // Dashboard CAT (age 8 sweep) often never serves a fraction item. The
      // demo full bank still must exercise that type.
      if (!isDashboardLaunch()) {
        expect(typesObserved.has('fraction'), 'fraction observed').to.equal(true);
      }
    });
  }

  /** Poll the play log until this item's narration has started (or we give up). */
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

  function handleChoiceItem(i: number, win: TaskWindow): void {
    const choices = readChoices(win);
    const stim = readStimulusText(win);
    const choicesKey = `${stim}::${choices.join('|')}`;

    // Same item still showing after we answered it: usually transient feedback,
    // but if it persists it is a gated practice re-presentation (our answer was
    // wrong and the task won't advance). Wait through feedback; once it crosses
    // GATE_PERSIST, cycle to an untried choice so the long run can complete.
    if (choicesKey === actedKey) {
      sameKeyFrames += 1;
      if (sameKeyFrames < GATE_PERSIST) {
        cy.wait(120, { log: false });
        step(i + 1);
        return;
      }
      const next = choices.findIndex((_c, ix) => !triedIndices.has(ix));
      if (next < 0) {
        // Exhausted every choice and none advanced; give up escaping and let the
        // completion guard / MAX_STEPS handle it.
        cy.wait(120, { log: false });
        step(i + 1);
        return;
      }
      triedIndices.add(next);
      sameKeyFrames = 0;
      cy.chooseOption(next);
      cy.wait(200, { log: false });
      step(i + 1);
      return;
    }

    // Only number identification needs the audio (its target is narrated and not
    // on screen). Visual types (arithmetic, sequences) and comparison are solved
    // from the screen, so we skip the audio poll for a big speedup.
    const screenType = classifyItem(null, stim, choices);
    const needsAudio = screenType === 'unknown' || screenType === 'number-identification';

    const solveAndAct = (audio: CurrentAudio): void => {
      // Fraction items render operands/choices as MathML <mfrac>; their text
      // collapses ambiguously ("1/5" -> "15"), so they get a dedicated solver.
      const fraction = isFractionItem(win);
      const itemType: EgmaItemType = fraction
        ? 'fraction'
        : classifyItem(audio.transcript, stim, choices);
      const solution = fraction
        ? solveFractionItem(win)
        : solveItem(itemType, audio.transcript, choices, stim);
      // The solver's own answer, kept separate from the acted index so the
      // key cross-check below stays valid when a stochastic agent deliberately
      // answers wrong.
      const computedIndex = solution ? solution.index : 0;
      let index = computedIndex;
      const keyedIndexEarly = appKeyedCorrectIndex(win);
      if (isWrongAgentMode() && choices.length > 0) {
        const ref = keyedIndexEarly >= 0 ? keyedIndexEarly : index;
        index = pickWrongIndex(ref, choices.length);
      } else if (isStochasticMode() && choices.length > 0) {
        // Reference = the app key when exposed, else the solver's answer. The
        // hash key is stim + sorted choices (EGMA's bank isn't deployed, so
        // there's no difficulty join — the sim uses the age-accuracy fallback).
        const ref = keyedIndexEarly >= 0 ? keyedIndexEarly : index;
        const simKey = `${stim}::${[...choices].sort().join('|')}`;
        index = isSimMode()
          ? simDecideIndex(ref, choices.length, simKey, choices).index
          : randomDecideIndex(ref, choices.length, simKey, choices).index;
      }
      const recordType: EgmaItemType =
        itemType === 'instructions' ? 'unknown' : itemType;

      // Diagnostic: capture the DOM of anything we could not solve, so unknown
      // formats (e.g. a new mixed section) can be fixed from the artifact.
      if (!solution) {
        const stimEl = win.document.querySelector('.lev-stimulus-container');
        const rowEl = win.document.querySelector('.lev-response-row');
        cy.task(
          'writeJsonl',
          {
            path: UNSOLVED_LOG,
            records: [
              {
                step: i,
                screenType,
                itemType,
                stim,
                transcript: audio.transcript,
                choices,
                stimHtml: stimEl?.outerHTML ?? null,
                rowHtml: rowEl?.outerHTML?.slice(0, 4000) ?? null,
              },
            ],
          },
          { log: false },
        );
      }

      // Differential cross-check: when the task exposes its own answer key
      // (under Cypress it marks the correct button), require our independently
      // computed choice to match it. Agreement = both confirmed; a mismatch is a
      // real bug (in the task key or our solver) — log it and let finalize fail.
      // We still ACT on our own computed index, never the key, so the oracle is
      // genuinely independent. Where no key is present (instructions / untagged
      // types) we fall back to "did the solver produce an answer".
      const keyedIndex = appKeyedCorrectIndex(win);
      const hasKey = keyedIndex >= 0;
      // Stochastic agents score their acted click against the best reference
      // (key, else solver); the oracle scores its solver as before.
      const correct = isStochasticMode()
        ? index === (hasKey ? keyedIndex : computedIndex)
        : hasKey
          ? solution !== null && index === keyedIndex
          : solution !== null;
      // The solver-vs-key differential cross-check stays on the SOLVER's answer,
      // so it keeps running (and stays meaningful) under sim/random agents.
      if (hasKey && solution && !isWrongAgentMode()) {
        keyedChecks += 1;
        if (computedIndex !== keyedIndex) {
          keyMismatches += 1;
          const stimEl = win.document.querySelector('.lev-stimulus-container');
          const rowEl = win.document.querySelector('.lev-response-row');
          cy.task(
            'writeJsonl',
            {
              path: MISMATCH_LOG,
              records: [
                {
                  step: i,
                  itemType: recordType,
                  stim,
                  transcript: audio.transcript,
                  choices,
                  computedIndex,
                  computedValue: choices[computedIndex] ?? null,
                  keyedIndex,
                  keyedValue: choices[keyedIndex] ?? null,
                  // Raw DOM so the operands/answer key can be confirmed offline.
                  stimHtml: stimEl?.outerHTML ?? null,
                  rowHtml: rowEl?.outerHTML?.slice(0, 4000) ?? null,
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
        itemType: recordType,
        promptText: audio.transcript ?? (stim || null),
        choices,
        chosenIndex: index,
        chosenValue: choices[index] ?? null,
        correctValue: solution ? solution.value : null,
        correct,
        keyedIndex: hasKey ? keyedIndex : null,
        keyedValue: hasKey ? (choices[keyedIndex] ?? null) : null,
        oracle: trialRecordOracleFlag(),
        audioTranscript: audio.transcript,
        audioSource: audio.source,
      });

      actedKey = choicesKey;
      sameKeyFrames = 0;
      triedIndices = new Set<number>([index]);
      cy.chooseOption(index);
      cy.wait(150, { log: false });
      step(i + 1);
    };

    if (needsAudio) {
      cy.wait(250, { log: false });
      readPrompt(win as unknown as AudioWindow, PROMPT_POLLS, solveAndAct);
    } else {
      solveAndAct(NO_AUDIO);
    }
  }

  function handleSlider(i: number, win: TaskWindow): void {
    const stim = readStimulusText(win);
    if (stim === lastSliderKey) {
      cy.wait(120, { log: false });
      step(i + 1);
      return;
    }

    // One-time diagnostic: dump the slider markup so the input scale vs. the
    // number-line scale can be verified if a placement ever lands off.
    if (!sliderDumped) {
      sliderDumped = true;
      const slider = win.document.querySelector(SLIDER) as HTMLInputElement | null;
      const html = win.document.querySelector(RESPONSE_ROW)?.outerHTML ?? '';
      cy.task('writeJsonl', {
        path: 'cypress/logs/_egma_slider_dom.json',
        records: [
          { stim, min: slider?.min, max: slider?.max, step: slider?.step, value: slider?.value, html },
        ],
      });
    }

    // The target is in the stimulus ("...mark the number. N"), not the audio, so
    // we solve from the screen and skip the audio poll for speed.
    cy.wait(200, { log: false });
    cy.window({ log: false }).then((w2) => {
      const w2win = w2 as unknown as TaskWindow;
      const plan = solveNumberLine(w2win, stim);
      lastSliderKey = stim;

      if (!plan) {
        logRecord({
          timestamp: new Date().toISOString(),
          task: TASK,
          step: i,
          itemType: 'number-line',
          promptText: stim || null,
          correct: false,
          oracle: trialRecordOracleFlag(),
        });
        cy.continueEgma();
        cy.wait(200, { log: false });
        step(i + 1);
        return;
      }

      const placement = isWrongAgentMode()
        ? plan.target > (plan.min + plan.max) / 2
          ? plan.min
          : plan.max
        : plan.value;
      const error = Math.abs(placement - plan.target) / (plan.max - plan.min);
      logRecord({
        timestamp: new Date().toISOString(),
        task: TASK,
        step: i,
        itemType: 'number-line',
        promptText: stim || null,
        correctValue: String(plan.target),
        chosenValue: String(placement),
        correct: isWrongAgentMode() ? false : error <= NUMBER_LINE_TOLERANCE,
        numberLineError: error,
        oracle: trialRecordOracleFlag(),
      });

      cy.placeSlider(placement);
      cy.wait(150, { log: false });
      cy.continueEgma();
      cy.wait(200, { log: false });
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

      // 1. Done? Empty before the task starts is just loading; between sections
      //    it is transient, so require sustained emptiness.
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

      // 1b. Audio-pipeline health check. Once a handful of items have rendered,
      //     the app should have played at least one narration clip. If
      //     __audioPlayLog has no speech, audio capture (or task startup) is
      //     broken — fail fast with a clear cause rather than letting audio-only
      //     items mis-solve into key mismatches.
      if (!audioHealthChecked && records.length >= AUDIO_HEALTH_MIN_ITEMS) {
        audioHealthChecked = true;
        if (!speechHasPlayed(win as unknown as AudioWindow)) {
          throw new Error(
            `No narration clips played after ${records.length} items — audio pipeline or task startup is broken ` +
              `(window.__audioPlayLog has no speech). Audio-only EGMA items (number identification) cannot be ` +
              `solved without narration, so they surface as key mismatches. Check task startup on this build ` +
              `(e.g. the TaskLevante.vue startTask error) before trusting accuracy.`,
          );
        }
      }

      // 2. Number-line slider (checked before instructions: it also shows a
      //    .primary submit button).
      if (isSliderScreen(win)) {
        handleSlider(i, win);
        return;
      }

      // 3. Multiple-choice response item.
      if (isItemReady(win)) {
        handleChoiceItem(i, win);
        return;
      }

      // 4. Instruction / section screen: capture its narration, then advance.
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
          cy.continueEgma();
          cy.wait(180, { log: false });
          step(i + 1);
        });
        return;
      }

      // 5. Transition / loading frame: wait WITHOUT consuming audio so the next
      //    item's narration is not prematurely attributed.
      cy.wait(120, { log: false });
      step(i + 1);
    });
  }

  it(`completes the task as the ${AGENT_LABEL}`, () => {
    if (isSimMode()) {
      cy.task('getSimConfig', { taskSlug: 'egma_math' }).then((cfg) =>
        simInit(cfg as SimChildConfig),
      );
    }
    resetAudioCapture();
    launchTask({ taskId: 'egma-math', demoUrl: buildUrl(), onBeforeLoad: installAudioCapture });
    cy.contains('OK', { timeout: 300000 }).should('be.visible').click({ force: true });
    step(0);
  });
});
