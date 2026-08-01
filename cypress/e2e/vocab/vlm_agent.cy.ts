import vocabVlmAgent from '../../support/agents/vocabVlmAgent';
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
  solveFromTranscript,
  targetWordFromTranscript,
  type TaskWindow,
} from '../../support/tasks/vocab';
import { installAudioCapture, type AudioWindow } from '../../support/audio/audioCapture';
import {
  currentAudioTranscript,
  resetAudioCapture,
  type CurrentAudio,
} from '../../support/audio/audioOracle';
import { launchTask } from '../../support/launch';
import { parseVocabTrialRecord, type VocabTrialRecord } from '../../support/tasks/types';

const MAX_STEPS = 4000;
const TASK = 'vocab';
const TIMEOUT_MS = 8000;
const PROMPT_POLLS = 14;

// Live, append-as-you-go log (so a long/killed run still yields partial data).
const LIVE_LOG = 'cypress/logs/_vocab_vlm_live.jsonl';

// Provider is chosen node-side by VLM_PROVIDER, surfaced here for log labelling
// and so the spec can be run with `--env provider=gemini`.
const provider = String(Cypress.expose('provider') ?? 'gemini');

describe(`Vocab — VLM agent (${provider})`, () => {
  const records: VocabTrialRecord[] = [];
  let started = false;
  let emptyStreak = 0;
  const EMPTY_DONE = 20;
  let actedKey = '';

  function logRecord(input: Parameters<typeof parseVocabTrialRecord>[0]): void {
    const rec = parseVocabTrialRecord(input);
    records.push(rec);
    cy.task('writeJsonl', { path: LIVE_LOG, records: [rec] }, { log: false });
  }

  function finalize(): void {
    const ts = Date.now();
    cy.task('writeJsonl', { path: `cypress/logs/vlm_vocab_${provider}_${ts}.jsonl`, records });
    const scored = records.filter((r) => r.itemType === 'word' && typeof r.correct === 'boolean');
    const withAudio = records.filter((r) => r.audioTranscript);
    cy.wrap(null).then(() => {
      expect(records.length, 'recorded at least one item').to.be.greaterThan(0);
      const correct = scored.filter((r) => r.correct === true).length;
      cy.log(`VLM (${provider}) accuracy: ${correct}/${scored.length}`);
      cy.log(`audio transcripts captured: ${withAudio.length}/${records.length}`);
      // The VLM run is a benchmark, not a pass/fail gate on accuracy, but the
      // audio pipeline must work (the target word is only in the narration).
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

  function handleItem(i: number, win: TaskWindow): void {
    const choices = readChoices(win);
    const key = choices.join('|');

    // Same item lingering (feedback/fixation): wait without re-acting.
    if (key === actedKey) {
      cy.wait(120, { log: false });
      step(i + 1);
      return;
    }

    cy.wait(250, { log: false });
    readPrompt(win as unknown as AudioWindow, PROMPT_POLLS, (audio) => {
      const keyedIndex = appKeyedCorrectIndex(win);
      const hasKey = keyedIndex >= 0;

      const screenshotName = `vlm_vocab_step_${String(i).padStart(4, '0')}`;
      cy.captureViewportBase64(screenshotName).then((pngBase64: string) => {
        vocabVlmAgent.decide(pngBase64, audio.transcript).then((decision) => {
          const itemKey = choices[keyedIndex] ?? `step-${i}`;
          let resolved = resolveVlmChoice({
            keyedIndex,
            hasKey,
            vlmIndex: decision.index,
            choices,
            itemKey,
          });
          // Ungated fallback when no app key: score vs audio-matched oracle.
          if (!hasKey) {
            const vlmIndex = decision.index;
            const inRange =
              vlmIndex !== null && vlmIndex >= 0 && vlmIndex < choices.length;
            const oracleIdx = solveFromTranscript(audio.transcript, choices);
            resolved = {
              actIndex: inRange ? (vlmIndex as number) : 0,
              correct: inRange && vlmIndex === oracleIdx,
              vlmIndex: inRange ? vlmIndex : null,
              gate: null,
            };
          }

          logRecord({
            timestamp: new Date().toISOString(),
            task: TASK,
            step: i,
            itemType: 'word',
            promptText: audio.transcript,
            targetWord: targetWordFromTranscript(audio.transcript),
            choices,
            // When gated, chosen* is the final (age-matched) click; otherwise
            // preserve prior behavior of logging the raw VLM proposal.
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
            audioTranscript: audio.transcript,
            audioSource: audio.source,
            ...gateLogFields(resolved.gate, resolved.vlmIndex),
          });

          actedKey = key;
          cy.chooseVocabOption(resolved.actIndex);
          cy.wait(180, { log: false });
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
              oracle: false,
              provider,
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

  it('drives the task via the configured VLM provider', () => {
    initVlmIrtGateIfEnabled('vocab');
    resetAudioCapture();
    launchTask({ taskId: 'vocab', demoUrl: buildUrl(), onBeforeLoad: installAudioCapture });
    cy.get('.primary', { timeout: 300000 }).should('be.visible');
    cy.continueVocab();
    step(0);
  });
});
