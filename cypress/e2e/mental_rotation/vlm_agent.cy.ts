import mentalRotationVlmAgent from '../../support/agents/mentalRotationVlmAgent';
import {
  appKeyedCorrectIndex,
  buildUrl,
  isComplete,
  isInstructionScreen,
  isItemReady,
  readChoices,
  readPromptText,
  readTargetAlt,
  CHOICE_BUTTON,
  JSPSYCH_CONTENT,
  STIMULUS_CONTAINER,
  EXIT_BUTTON,
  type TaskWindow,
} from '../../support/tasks/mentalRotation';
import { installAudioCapture, type AudioWindow } from '../../support/audio/audioCapture';
import { currentAudioTranscript, resetAudioCapture } from '../../support/audio/audioOracle';
import { launchTask } from '../../support/launch';
import { parseMentalRotationTrialRecord, type MentalRotationTrialRecord } from '../../support/tasks/types';

const MAX_STEPS = 2500;
const TASK = 'mental-rotation';
const TIMEOUT_MS = 10000;

const LIVE_LOG = 'cypress/logs/_mr_vlm_live.jsonl';
const provider = String(Cypress.expose('provider') ?? 'gemini');

describe(`Mental Rotation — VLM agent (${provider})`, () => {
  const records: MentalRotationTrialRecord[] = [];
  let taskComplete = false;
  let started = false;
  let emptyStreak = 0;
  const EMPTY_DONE = 20;
  // Items the VLM has already answered (keyed by target+choices). Gate-escape:
  // if the same item re-appears (our wrong pick didn't advance a practice item),
  // click the keyed choice to move on without re-scoring.
  const answeredItems = new Set<string>();

  function logRecord(input: Parameters<typeof parseMentalRotationTrialRecord>[0]): void {
    const rec = parseMentalRotationTrialRecord(input);
    records.push(rec);
    cy.task('writeJsonl', { path: LIVE_LOG, records: [rec] }, { log: false });
  }

  function finished(win: TaskWindow): boolean {
    const doc = win.document;
    if (doc.querySelector(EXIT_BUTTON)) return true;
    const stim = doc.querySelector(STIMULUS_CONTAINER);
    return !!(stim && stim.querySelector('footer'));
  }

  function screenSig(win: TaskWindow): string {
    const doc = win.document;
    const content = doc.querySelector(JSPSYCH_CONTENT);
    if (!content || content.children.length === 0) return 'EMPTY';
    const corrects = doc.querySelectorAll('.correct').length;
    return [readPromptText(win), readTargetAlt(win), readChoices(win).join(','), corrects].join('#');
  }

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
    cy.task('writeJsonl', { path: `cypress/logs/vlm_mr_${provider}_${ts}.jsonl`, records });
    const scored = records.filter((r) => r.itemType === 'item' && typeof r.correct === 'boolean');
    const correct = scored.filter((r) => r.correct === true).length;
    cy.wrap(null).then(() => {
      expect(records.length, 'recorded at least one item').to.be.greaterThan(0);
      cy.log(`task completed: ${taskComplete}`);
      cy.log(`VLM (${provider}) accuracy: ${correct}/${scored.length}`);
    });
  }

  function handleItem(i: number, win: TaskWindow): void {
    const choices = readChoices(win);
    const targetAlt = readTargetAlt(win);
    const promptText = readPromptText(win);
    const key = `${targetAlt}::${choices.join('|')}`;
    const keyedIndex = appKeyedCorrectIndex(win);
    const hasKey = keyedIndex >= 0;
    const sig = screenSig(win);

    // Re-presented (our earlier wrong pick didn't advance a practice item):
    // escape by clicking the keyed choice, without re-scoring.
    if (answeredItems.has(key)) {
      cy.get('body', { log: false }).then(($b) => {
        if ($b.find(CHOICE_BUTTON).length > 0) cy.chooseMrOption(hasKey ? keyedIndex : 0);
      });
      waitChangedThenStep(i, sig);
      return;
    }
    answeredItems.add(key);

    const name = `vlm_mr_step_${String(i).padStart(4, '0')}`;
    cy.captureViewportBase64(name).then((pngBase64: string) => {
      currentAudioTranscript(win as unknown as AudioWindow).then((audio) => {
        mentalRotationVlmAgent.decide(pngBase64, audio.transcript).then((decision) => {
          const vlmIndex = decision.index;
          const inRange = vlmIndex !== null && vlmIndex >= 0 && vlmIndex < choices.length;
          const correct = hasKey ? inRange && vlmIndex === keyedIndex : null;
          const actIndex = inRange ? (vlmIndex as number) : hasKey ? keyedIndex : 0;

          logRecord({
            timestamp: new Date().toISOString(),
            task: TASK,
            step: i,
            itemType: 'item',
            promptText: promptText || null,
            targetAlt,
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
            if ($b.find(CHOICE_BUTTON).length > actIndex) cy.chooseMrOption(actIndex);
          });
          waitChangedThenStep(i, sig);
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

      if (isItemReady(win)) {
        handleItem(i, win);
        return;
      }
      if (isInstructionScreen(win)) {
        const sig = screenSig(win);
        cy.continueMr();
        waitChangedThenStep(i, sig);
        return;
      }

      cy.wait(120, { log: false });
      step(i + 1);
    });
  }

  it('benchmarks rotation judgments via the VLM, scored against the app key', () => {
    resetAudioCapture();
    launchTask({
      taskId: 'mental-rotation',
      demoUrl: buildUrl(),
      onBeforeLoad: installAudioCapture,
    });
    cy.get('button.primary', { timeout: 60_000 }).should('be.visible').click({ force: true });
    step(0);
  });
});
