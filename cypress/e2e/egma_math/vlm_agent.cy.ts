import egmaVlmAgent from '../../support/agents/egmaVlmAgent';
import {
  appKeyedCorrectIndex,
  buildUrl,
  choiceIndexForValue,
  classifyItem,
  fractionChoiceIndexForValue,
  isComplete,
  isFractionItem,
  isInstructionScreen,
  isItemReady,
  isSliderScreen,
  readChoices,
  readStimulusText,
  solveFractionItem,
  solveItem,
  solveNumberLine,
  type TaskWindow,
} from '../../support/tasks/egmaMath';
import { installAudioCapture, type AudioWindow } from '../../support/audio/audioCapture';
import {
  currentAudioTranscript,
  resetAudioCapture,
  type CurrentAudio,
} from '../../support/audio/audioOracle';
import { parseEgmaTrialRecord, type EgmaItemType, type EgmaTrialRecord } from '../../support/tasks/types';
import { launchTask } from '../../support/launch';

const NO_AUDIO: CurrentAudio = { url: null, transcript: null, source: null };

// Live, append-as-you-go log (so a long/killed run still yields partial data).
const LIVE_LOG = 'cypress/logs/_egma_vlm_live.jsonl';

const MAX_STEPS = 4500;
const TASK = 'egma-math';
const TIMEOUT_MS = 8000;
// Normalized number-line placement error (fraction of the line length) within
// which a placement counts as correct — same threshold the oracle uses.
const NUMBER_LINE_TOLERANCE = 0.02;
const PROMPT_POLLS = 12;
// After this many consecutive frames showing the same item we just answered we
// treat it as a gated practice re-presentation (a wrong VLM answer that won't
// advance) rather than transient feedback, and cycle to the deterministic /
// next choice so the run completes. Must exceed the longest feedback animation.
// The VLM's original answer is the one already scored.
const GATE_PERSIST = 18;

// Provider is chosen node-side by VLM_PROVIDER, surfaced here for log labelling
// and so the spec can be run with `--env provider=gemini`.
const provider = String(Cypress.env('provider') ?? 'gemini');

describe(`EGMA math — VLM agent (${provider})`, () => {
  const records: EgmaTrialRecord[] = [];
  let started = false;
  let emptyStreak = 0;
  const EMPTY_DONE = 20;
  let actedKey = '';
  let sameKeyFrames = 0;
  let triedIndices = new Set<number>();
  let lastSliderKey = '';

  /** Record a trial: keep it in memory and append it to the live log. */
  function logRecord(input: Parameters<typeof parseEgmaTrialRecord>[0]): void {
    const rec = parseEgmaTrialRecord(input);
    records.push(rec);
    cy.task('writeJsonl', { path: LIVE_LOG, records: [rec] }, { log: false });
  }

  function finalize(): void {
    const ts = Date.now();
    cy.task('writeJsonl', { path: `cypress/logs/vlm_egma_${provider}_${ts}.jsonl`, records });
    const scored = records.filter((r) => typeof r.correct === 'boolean' && r.itemType !== 'number-line');
    const withAudio = records.filter((r) => r.audioTranscript);
    cy.wrap(null).then(() => {
      expect(records.length, 'recorded at least one item').to.be.greaterThan(0);
      const correct = scored.filter((r) => r.correct === true).length;
      cy.log(`VLM (${provider}) accuracy: ${correct}/${scored.length}`);
      cy.log(`audio transcripts captured: ${withAudio.length}/${records.length}`);
      // The VLM run is a benchmark, not a pass/fail gate on accuracy, but the
      // audio pipeline must work (number identification depends on it).
      expect(withAudio.length, 'captured at least one narration transcript').to.be.greaterThan(0);
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

  function handleChoiceItem(i: number, win: TaskWindow): void {
    const choices = readChoices(win);
    const stim = readStimulusText(win);
    const key = `${stim}::${choices.join('|')}`;

    // Same item still on screen after we answered: usually transient feedback,
    // but if it persists it is a gated practice re-presentation (a wrong VLM
    // answer that won't advance). Wait through feedback; once it crosses
    // GATE_PERSIST, cycle to an untried choice so the long run completes. The
    // VLM's original answer is already scored.
    if (key === actedKey) {
      sameKeyFrames += 1;
      if (sameKeyFrames < GATE_PERSIST) {
        cy.wait(120, { log: false });
        step(i + 1);
        return;
      }
      const fraction = isFractionItem(win);
      const sol = fraction
        ? solveFractionItem(win)
        : solveItem(classifyItem(null, stim, choices), null, choices, stim);
      const det = sol ? sol.index : choices.findIndex((_c, ix) => !triedIndices.has(ix));
      const next = det >= 0 ? det : 0;
      triedIndices.add(next);
      sameKeyFrames = 0;
      cy.chooseOption(next);
      cy.wait(200, { log: false });
      step(i + 1);
      return;
    }

    const screenType = classifyItem(null, stim, choices);
    const needsAudio = screenType === 'unknown' || screenType === 'number-identification';

    const ask = (audio: CurrentAudio): void => {
      const fraction = isFractionItem(win);
      const itemType: EgmaItemType = fraction
        ? 'fraction'
        : classifyItem(audio.transcript, stim, choices);
      const oracleSol = fraction
        ? solveFractionItem(win)
        : solveItem(itemType, audio.transcript, choices, stim);
      const recordType: EgmaItemType = itemType === 'instructions' ? 'unknown' : itemType;

      const screenshotName = `vlm_egma_step_${String(i).padStart(4, '0')}`;
      let shotPath = '';
      cy.screenshot(screenshotName, {
        capture: 'viewport',
        overwrite: true,
        onAfterScreenshot(_doc, props) {
          shotPath = props.path;
        },
      });

      cy.then(() => cy.readFile(shotPath, 'base64')).then((pngBase64: string) => {
        egmaVlmAgent.decide(pngBase64, audio.transcript).then((decision) => {
          // Fractions render as MathML; match the VLM's rational answer against
          // the choices' <mfrac> values rather than their ambiguous textContent.
          const vlmIndex = fraction
            ? fractionChoiceIndexForValue(win, decision.value)
            : choiceIndexForValue(choices, decision.value);

          // Ground truth: prefer the task's OWN answer key (the choice the app
          // marks correct under Cypress) so the benchmark doesn't depend on our
          // solver being right. Fall back to the deterministic solver only where
          // no marker is present (untagged types).
          const keyedIndex = appKeyedCorrectIndex(win);
          const hasKey = keyedIndex >= 0;
          const correct = hasKey
            ? vlmIndex >= 0 && vlmIndex === keyedIndex
            : oracleSol === null
              ? null
              : fraction
                ? vlmIndex >= 0 && vlmIndex === oracleSol.index
                : decision.value !== null && decision.value === Number(oracleSol.value);

          logRecord({
            timestamp: new Date().toISOString(),
            task: TASK,
            step: i,
            itemType: recordType,
            promptText: audio.transcript ?? (stim || null),
            choices,
            chosenIndex: vlmIndex >= 0 ? vlmIndex : null,
            chosenValue: vlmIndex >= 0 ? choices[vlmIndex] : null,
            correctValue: oracleSol ? oracleSol.value : null,
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

          // Act on the VLM's choice when it maps to a real option; otherwise fall
          // back to the deterministic answer so a malformed reply doesn't stall
          // the run (the malformed reply is still scored as incorrect above).
          const actIndex = vlmIndex >= 0 ? vlmIndex : oracleSol ? oracleSol.index : 0;
          actedKey = key;
          sameKeyFrames = 0;
          triedIndices = new Set<number>([actIndex]);
          cy.chooseOption(actIndex);
          cy.wait(180, { log: false });
          step(i + 1);
        });
      });
    };

    if (needsAudio) {
      cy.wait(250, { log: false });
      readPrompt(win as unknown as AudioWindow, PROMPT_POLLS, ask);
    } else {
      ask(NO_AUDIO);
    }
  }

  function handleSlider(i: number, win: TaskWindow): void {
    // Number-line items: the VLM sees the line + target and decides the value to
    // place; we set the slider there and score by proximity to the true target
    // (normalized error), mirroring the oracle's metric.
    const stim = readStimulusText(win);
    if (stim === lastSliderKey) {
      cy.wait(120, { log: false });
      step(i + 1);
      return;
    }
    cy.wait(200, { log: false });
    cy.window({ log: false }).then((w2) => {
      const w2win = w2 as unknown as TaskWindow;
      const plan = solveNumberLine(w2win, stim);
      lastSliderKey = stim;

      // No parseable target/range: advance without a score so the run completes.
      if (!plan) {
        logRecord({
          timestamp: new Date().toISOString(),
          task: TASK,
          step: i,
          itemType: 'number-line',
          promptText: stim || null,
          oracle: false,
          provider,
        });
        cy.continueEgma();
        cy.wait(200, { log: false });
        step(i + 1);
        return;
      }

      const screenshotName = `vlm_egma_step_${String(i).padStart(4, '0')}`;
      let shotPath = '';
      cy.screenshot(screenshotName, {
        capture: 'viewport',
        overwrite: true,
        onAfterScreenshot(_doc, props) {
          shotPath = props.path;
        },
      });

      const instruction =
        `This is a number-line item. The line runs from ${plan.min} on the left to ` +
        `${plan.max} on the right. Reply with ONLY the number the marker should be placed at.`;

      cy.then(() => cy.readFile(shotPath, 'base64')).then((pngBase64: string) => {
        egmaVlmAgent.decide(pngBase64, null, instruction).then((decision) => {
          // Place the VLM's value (clamped to the line); if unparseable, place the
          // true target so the run advances, but score it as max error.
          const placed =
            decision.value === null ? plan.target : Math.min(plan.max, Math.max(plan.min, decision.value));
          const error =
            decision.value === null ? 1 : Math.abs(placed - plan.target) / (plan.max - plan.min);

          logRecord({
            timestamp: new Date().toISOString(),
            task: TASK,
            step: i,
            itemType: 'number-line',
            promptText: stim || null,
            correctValue: String(plan.target),
            chosenValue: String(placed),
            correct: error <= NUMBER_LINE_TOLERANCE,
            numberLineError: error,
            rtMs: decision.latencyMs,
            oracle: false,
            provider,
            modelRaw: decision.raw,
            latencyMs: decision.latencyMs,
            timedOut: decision.latencyMs > TIMEOUT_MS,
          });

          cy.placeSlider(placed);
          cy.wait(150, { log: false });
          cy.continueEgma();
          cy.wait(200, { log: false });
          step(i + 1);
        });
      });
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

      if (isSliderScreen(win)) {
        handleSlider(i, win);
        return;
      }
      if (isItemReady(win)) {
        handleChoiceItem(i, win);
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
              oracle: false,
              provider,
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

      cy.wait(120, { log: false });
      step(i + 1);
    });
  }

  it('drives the task via the configured VLM provider', () => {
    resetAudioCapture();
    launchTask({ taskId: 'egma-math', demoUrl: buildUrl(), onBeforeLoad: installAudioCapture });
    cy.contains('OK', { timeout: 300000 }).should('be.visible').click({ force: true });
    step(0);
  });
});
