import {
  appKeyedSequence,
  blockCount,
  buildUrl,
  clearObservedFlashes,
  installFlashRecorder,
  isComplete,
  isInputPhase,
  isInstructionScreen,
  isGridVisible,
  observedSequence,
  readAppInputScores,
  readPromptText,
  scoreTrials,
  sequencesEqual,
  EXIT_BUTTON,
  JSPSYCH_CONTENT,
  type MemoryWindow,
} from '../../support/tasks/memoryGame';
import { installAudioCapture, type AudioWindow } from '../../support/audio/audioCapture';
import { currentAudioTranscript, resetAudioCapture } from '../../support/audio/audioOracle';
import { launchTask } from '../../support/launch';
import {
  agentLogStem,
  isWrongAgentMode,
  trialRecordOracleFlag,
  wrongReproductionSequence,
} from '../../support/agentMode';
import { parseMemoryGameTrialRecord, type MemoryGameTrialRecord } from '../../support/tasks/types';

// ~3 practice + 21 forward + 3 practice + 21 backward input trials, each preceded
// by a multi-second display; MAX_STEPS is generous since display-phase polling
// adds many no-op iterations.
const MAX_STEPS = 30000;
const TASK = 'memory-game';

const LIVE_LOG = `cypress/logs/_memory_${agentLogStem()}_live.jsonl`;
// Items where the observed flash sequence disagreed with the internal key
// (a real animation/scoring regression).
const MISMATCH_LOG = 'cypress/logs/_memory_key_mismatch.jsonl';

// The full run is ~24 forward + ~24 backward sequence trials; cap well above
// that so a runaway can never loop forever.
const MAX_SEQUENCES = 70;

describe(`Memory Game — ${isWrongAgentMode() ? 'wrong agent' : 'oracle (observe flashes, then reproduce)'}`, () => {
  const records: MemoryGameTrialRecord[] = [];
  let taskComplete = false;
  let started = false;
  let finalized = false;
  let seqCount = 0;
  // Pure safety net: only treat sustained emptiness as "done" after a long idle
  // (the real end is the Exit screen, detected by finished()). Memory Game has
  // multi-second transitions, so this must be generous to avoid a false finish.
  let emptyStreak = 0;
  const EMPTY_DONE = 150;
  // The forward input prompt (set on the first input trial, which is always
  // forward). Any later input trial with a different prompt is the backward
  // block. `backward` is sticky once detected.
  let forwardPromptText: string | null = null;
  let backward = false;
  let nMismatch = 0;
  let lastActedSig = '';

  function composedOnBeforeLoad(win: Window): void {
    installAudioCapture(win);
    installFlashRecorder(win);
  }

  function logRecord(input: Parameters<typeof parseMemoryGameTrialRecord>[0]): void {
    const rec = parseMemoryGameTrialRecord(input);
    records.push(rec);
    cy.task('writeJsonl', { path: LIVE_LOG, records: [rec] }, { log: false });
  }

  function finished(win: MemoryWindow): boolean {
    const doc = win.document;
    if (doc.querySelector(EXIT_BUTTON)) return true;
    const stim = doc.querySelector('.lev-stimulus-container');
    if (stim && stim.querySelector('footer')) return true;
    return Array.from(doc.querySelectorAll('button')).some((b) =>
      /^\s*exit\s*$/i.test(b.textContent ?? ''),
    );
  }

  function screenSig(win: MemoryWindow): string {
    const doc = win.document;
    const content = doc.querySelector(JSPSYCH_CONTENT);
    if (!content || content.children.length === 0) return 'EMPTY';
    const phase = isInputPhase(win) ? 'input' : isGridVisible(win) ? 'display' : 'instr';
    const keyed = appKeyedSequence(win)?.join(',') ?? '';
    return [phase, blockCount(win), readPromptText(win), keyed].join('#');
  }

  function waitChangedThenStep(i: number, prevSig: string, attempts = 40): void {
    if (finalized) return;
    cy.wait(100, { log: false });
    cy.window({ log: false }).then((w) => {
      if (finalized) return;
      const win = w as unknown as MemoryWindow;
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

  function clickSequence(order: number[]): void {
    order.forEach((id) => {
      cy.chooseMemoryBlock(id);
      cy.wait(90, { log: false });
    });
  }

  function finalize(): void {
    if (finalized) return;
    finalized = true;
    cy.window({ log: false }).then((w) => {
      const win = w as unknown as MemoryWindow;
      const appScores = readAppInputScores(win);
      const seqRecords = records.filter((r) => r.itemType === 'sequence');

      // Backfill each sequence record's `correct` from the app's own per-trial
      // scoring when the counts line up (records are 1:1 with input trials).
      if (appScores && appScores.length === seqRecords.length) {
        seqRecords.forEach((r, k) => {
          r.correct = appScores[k].correct;
        });
      } else {
        seqRecords.forEach((r) => {
          if (r.correct === null) r.correct = r.observedMatchesKey;
        });
      }

      const ts = Date.now();
      cy.task('writeJsonl', { path: `cypress/logs/${agentLogStem()}_memory_${ts}.jsonl`, records });

      const stats = scoreTrials(records);
      const appTotal = appScores?.length ?? 0;
      const appCorrect = appScores?.filter((s) => s.correct).length ?? 0;

      cy.wrap(null).then(() => {
        expect(taskComplete, 'task reached the completion screen').to.equal(true);
        expect(stats.nSequences, 'recorded sequence trials').to.be.greaterThan(20);
        expect(stats.nForward, 'forward sequence trials').to.be.greaterThan(0);
        expect(stats.nBackward, 'backward sequence trials').to.be.greaterThan(0);
        cy.log(`sequences: ${stats.nSequences}, max span: ${stats.maxSpan}`);
        cy.log(`observe/key agreement: ${stats.observeKeyAgreement}, mismatches: ${nMismatch}`);
        cy.log(`app scoring: ${appCorrect}/${appTotal} input trials correct`);
        // Authentic check: the flashed animation matched the internal key on
        // every item we observed.
        if (!isWrongAgentMode()) {
          expect(nMismatch, `observed≠key items (see ${MISMATCH_LOG})`).to.equal(0);
          expect(stats.observeKeyAgreement ?? 0, 'observed-sequence / key agreement').to.equal(1.0);
          if (appScores) {
            expect(appTotal, 'app recorded input trials').to.be.greaterThan(20);
            expect(appCorrect, 'app marked every reproduction correct').to.equal(appTotal);
          }
        } else if (appScores) {
          expect(appTotal, 'app recorded input trials').to.be.greaterThan(20);
          expect(appCorrect, 'app rejected wrong reproductions').to.equal(0);
        }
        expect(stats.nWithAudio, 'captured narration transcripts').to.be.greaterThan(0);
      });
    });
  }

  function handleSequence(i: number, win: MemoryWindow): void {
    const promptText = readPromptText(win);
    if (forwardPromptText === null && promptText) forwardPromptText = promptText;
    if (!backward && forwardPromptText && promptText && promptText !== forwardPromptText) {
      backward = true;
    }
    const phase: 'forward' | 'backward' = backward ? 'backward' : 'forward';

    const keyed = appKeyedSequence(win);
    const observed = observedSequence(win);
    clearObservedFlashes(win);
    const observedOk = observed.length > 0;
    // Reproduce the OBSERVED sequence (fall back to the key only if observation
    // somehow missed, just to keep the run advancing).
    const baseSeq = observedOk ? observed : keyed ?? [];
    const clickOrder = isWrongAgentMode()
      ? wrongReproductionSequence(baseSeq, backward, blockCount(win))
      : backward
        ? [...baseSeq].reverse()
        : baseSeq;
    const observedMatchesKey =
      keyed && observedOk ? sequencesEqual(observed, keyed) : null;

    const sig = screenSig(win);
    // Gated re-presentation (our reproduction didn't advance): re-click, no recount.
    if (sig === lastActedSig) {
      clickSequence(clickOrder);
      waitChangedThenStep(i, sig);
      return;
    }
    lastActedSig = sig;
    seqCount += 1;
    if (seqCount > MAX_SEQUENCES) {
      finalize();
      return;
    }

    if (observedMatchesKey === false) {
      nMismatch += 1;
      cy.task(
        'writeJsonl',
        { path: MISMATCH_LOG, records: [{ step: i, phase, observed, keyed }] },
        { log: false },
      );
    }

    currentAudioTranscript(win as unknown as AudioWindow).then((audio) => {
      logRecord({
        timestamp: new Date().toISOString(),
        task: TASK,
        step: i,
        itemType: 'sequence',
        phase,
        gridBlocks: blockCount(win),
        spanLength: baseSeq.length,
        observedSequence: observed,
        keyedSequence: keyed,
        clickOrder,
        observedMatchesKey,
        correct: null,
        oracle: trialRecordOracleFlag(),
        audioTranscript: audio.transcript,
        audioSource: audio.source,
      });
      clickSequence(clickOrder);
      waitChangedThenStep(i, sig);
    });
  }

  function step(i: number): void {
    if (finalized) return;
    if (i >= MAX_STEPS) {
      finalize();
      return;
    }
    cy.window({ log: false }).then((w) => {
      if (finalized) return;
      const win = w as unknown as MemoryWindow;

      // The real end of the task: the Exit/"Thank you" screen. Checked first so
      // we never click the Exit button as if it were an instruction OK.
      if (finished(win)) {
        taskComplete = true;
        finalize();
        return;
      }
      // Empty content is just an inter-trial transition here (NOT completion).
      // Wait it out; only a very long idle trips the safety net.
      if (isComplete(win)) {
        lastActedSig = '';
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

      if (isGridVisible(win)) {
        if (isInputPhase(win)) {
          handleSequence(i, win);
        } else {
          // Presentation phase: the recorder is capturing the flashes; just wait
          // for the input trial to load.
          cy.wait(100, { log: false });
          step(i + 1);
        }
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
          } as Parameters<typeof parseMemoryGameTrialRecord>[0]);
          cy.continueMemory();
          waitChangedThenStep(i, sig);
        });
        return;
      }

      cy.wait(120, { log: false });
      step(i + 1);
    });
  }

  it('reproduces every observed sequence; the app accepts them all', () => {
    resetAudioCapture();
    launchTask({ taskId: 'memory-game', demoUrl: buildUrl(), onBeforeLoad: composedOnBeforeLoad });
    // Memory Game preloads its audio/asset bank; allow extra time for the loading
    // screen before the fullscreen continue (label is locale-specific).
    cy.get('button.primary', { timeout: 60_000 }).should('be.visible').click({ force: true });
    step(0);
  });
});
