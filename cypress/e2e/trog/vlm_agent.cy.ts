import trogVlmAgent from '../../support/agents/trogVlmAgent';
import {
  gateLogFields,
  initVlmIrtGateIfEnabled,
  resolveVlmChoice,
} from '../../support/agents/vlmIrtGate';
import {
  appKeyedCorrectIndex,
  buildUrl,
  isComplete,
  isInstructionScreen,
  isItemReady,
  readChoices,
  readPromptText,
  CHOICE_BUTTON,
  JSPSYCH_CONTENT,
  STIMULUS_CONTAINER,
  EXIT_BUTTON,
  type TaskWindow,
} from '../../support/tasks/trog';
import { installAudioCapture, type AudioWindow } from '../../support/audio/audioCapture';
import { currentAudioTranscript, resetAudioCapture } from '../../support/audio/audioOracle';
import { launchTask } from '../../support/launch';
import { parseTrogTrialRecord, type TrogTrialRecord } from '../../support/tasks/types';

const MAX_STEPS = 2500;
const TASK = 'trog';
const TIMEOUT_MS = 10000;

const LIVE_LOG = 'cypress/logs/_trog_vlm_live.jsonl';
const provider = String(Cypress.expose('provider') ?? 'gemini');

describe(`TROG — VLM agent (${provider})`, () => {
  const records: TrogTrialRecord[] = [];
  let taskComplete = false;
  let started = false;
  let emptyStreak = 0;
  const EMPTY_DONE = 20;
  // Items the VLM has already answered (keyed by sentence+choices). Gate-escape:
  // if the same item re-appears (a wrong pick didn't advance a practice item),
  // click the keyed choice to move on without re-scoring.
  const answeredItems = new Set<string>();

  function logRecord(input: Parameters<typeof parseTrogTrialRecord>[0]): void {
    const rec = parseTrogTrialRecord(input);
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
    return [readPromptText(win), readChoices(win).join(','), corrects].join('#');
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
    cy.task('writeJsonl', { path: `cypress/logs/vlm_trog_${provider}_${ts}.jsonl`, records });
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
    const promptText = readPromptText(win);
    const keyedIndex = appKeyedCorrectIndex(win);
    const hasKey = keyedIndex >= 0;
    const sig = screenSig(win);

    currentAudioTranscript(win as unknown as AudioWindow).then((audio) => {
      const sentence = audio.transcript;
      const key = `${sentence ?? ''}::${choices.join('|')}`;

      // Re-presented (a wrong pick didn't advance a practice item): escape by
      // clicking the keyed choice, without re-scoring.
      if (answeredItems.has(key)) {
        cy.get('body', { log: false }).then(($b) => {
          if ($b.find(CHOICE_BUTTON).length > 0) cy.chooseTrogOption(hasKey ? keyedIndex : 0);
        });
        waitChangedThenStep(i, sig);
        return;
      }
      answeredItems.add(key);

      const name = `vlm_trog_step_${String(i).padStart(4, '0')}`;
      cy.captureViewportBase64(name).then((pngBase64: string) => {
        trogVlmAgent.decide(pngBase64, sentence).then((decision) => {
          const itemKey = choices[keyedIndex] ?? `step-${i}`;
          const resolved = resolveVlmChoice({
            keyedIndex,
            hasKey,
            vlmIndex: decision.index,
            choices,
            itemKey,
          });

          logRecord({
            timestamp: new Date().toISOString(),
            task: TASK,
            step: i,
            itemType: 'item',
            promptText: promptText || null,
            choices,
            // Gated: log final click (age-matched). Ungated: log raw VLM only.
            chosenIndex: resolved.gate ? resolved.actIndex : resolved.vlmIndex,
            chosenValue: resolved.gate
              ? (choices[resolved.actIndex] ?? null)
              : resolved.vlmIndex !== null
                ? (choices[resolved.vlmIndex] ?? null)
                : null,
            correct: resolved.correct,
            keyedIndex: hasKey ? keyedIndex : null,
            keyedValue: hasKey ? (choices[keyedIndex] ?? null) : null,
            rtMs: decision.latencyMs,
            oracle: false,
            provider,
            modelRaw: decision.raw,
            latencyMs: decision.latencyMs,
            timedOut: decision.latencyMs > TIMEOUT_MS,
            audioTranscript: sentence,
            audioSource: audio.source,
            ...gateLogFields(resolved.gate, resolved.vlmIndex),
          });
          cy.get('body', { log: false }).then(($b) => {
            if ($b.find(CHOICE_BUTTON).length > resolved.actIndex) {
              cy.chooseTrogOption(resolved.actIndex);
            }
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
        cy.continueTrog();
        waitChangedThenStep(i, sig);
        return;
      }

      cy.wait(120, { log: false });
      step(i + 1);
    });
  }

  it('benchmarks sentence→picture matching via the VLM, scored against the app key', () => {
    initVlmIrtGateIfEnabled('trog');
    resetAudioCapture();
    launchTask({
      taskId: 'trog',
      demoUrl: buildUrl(),
      onBeforeLoad: installAudioCapture,
    });
    // TROG preloads a sizeable image bank; allow extra time before first continue.
    cy.get('button.primary', { timeout: 300000 }).should('be.visible');
    cy.continueTrog();
    step(0);
  });
});
