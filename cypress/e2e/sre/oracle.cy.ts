import { installAudioCapture } from '../../support/audio/audioCapture';
import {
  agentLogStem,
  expectedAccuracy,
  isWrongAgentMode,
  trialRecordOracleFlag,
} from '../../support/agentMode';
import { launchTask } from '../../support/launch';
import { waitForRoarJsPsych } from '../../support/tasks/roar';
import {
  advanceSreStartup,
  arrowKeyForLr,
  bodyHasSreCompletion,
  clickSreContinueIfPresent,
  dumpStoreKeys,
  hasActiveStimulus,
  isDashboardReroute,
  isProgressComplete,
  readCorrectLrFromWindow,
  scoreTrials,
  SRE_ASSET_WAIT_MS,
  SRE_STEP_MS,
} from '../../support/tasks/sre';
import { parseSreTrialRecord, type SreTrialRecord } from '../../support/tasks/types';

const TASK = 'sre';
const LIVE_LOG = `cypress/logs/_sre_${agentLogStem()}_live.jsonl`;
const NO_LR_LOG = 'cypress/logs/_sre_no_correct_lr.jsonl';
// Dumped when the same screen persists for STALL_LIMIT passes — the loop is
// wedged on a screen no branch advances (e.g. a locale-specific end screen that
// completion detection misses). Captures the DOM so it can be fixed fast.
const STUCK_LOG = `cypress/logs/_sre_${agentLogStem()}_screen_stuck.jsonl`;
const STALL_LIMIT = 30;
const MAX_ITER = 600;

describe(`SRE — ${isWrongAgentMode() ? 'wrong agent' : 'oracle (session correctLR)'}`, () => {
  const records: SreTrialRecord[] = [];
  let step = 0;
  let taskComplete = false;
  let gameComplete = false;
  let nItems = 0;
  let nNoLr = 0;
  // No-progress guard: signature of the current screen + how many consecutive
  // passes it has stayed identical, so a wedged screen fails fast with a dump.
  let lastScreenSig = '';
  let screenStall = 0;

  function logRecord(
    input: Pick<SreTrialRecord, 'timestamp' | 'itemType' | 'oracle'> &
      Partial<Pick<SreTrialRecord, 'correctLr' | 'correct'>>,
  ): void {
    step += 1;
    const rec = parseSreTrialRecord({ ...input, task: TASK, step });
    records.push(rec);
    cy.task('writeJsonl', { path: LIVE_LOG, records: [rec] }, { log: false });
  }

  function finalize(): void {
    const ts = Date.now();
    cy.task('writeJsonl', { path: `cypress/logs/${agentLogStem()}_sre_${ts}.jsonl`, records });
    const stats = scoreTrials(records);

    cy.wrap(null).then(() => {
      expect(taskComplete || gameComplete, 'SRE run reached completion').to.equal(true);
      expect(stats.nItems, 'scored SRE item trials').to.be.greaterThan(0);
      expect(nNoLr, `trials with no session correctLR (see ${NO_LR_LOG})`).to.equal(0);
      expect(stats.accuracy ?? 0, `${agentLogStem()} accuracy`).to.equal(expectedAccuracy());
      cy.log(`items: ${nItems}`);
    });
  }

  function playTrials(iterLeft = MAX_ITER): void {
    if (taskComplete || gameComplete || iterLeft <= 0) {
      if (!taskComplete && !gameComplete) finalize();
      return;
    }

    cy.wait(SRE_ASSET_WAIT_MS * 0.15, { log: false });
    cy.get('body', { log: false })
      .invoke('text')
      .then((text) => {
        if (isDashboardReroute(text)) {
          taskComplete = true;
          finalize();
          return;
        }
        if (bodyHasSreCompletion(text)) {
          gameComplete = true;
          finalize();
          return;
        }

        cy.window({ log: false }).then((win) => {
          if (isProgressComplete(win.document)) {
            gameComplete = true;
            finalize();
            return;
          }

          const doc = win.document;

          // No-progress guard: if the screen is unchanged for STALL_LIMIT passes
          // the loop is wedged (e.g. an end screen completion detection misses).
          // Dump it and fail fast instead of spinning to MAX_ITER.
          const active = hasActiveStimulus(doc);
          const sig = `${text.trim().slice(0, 120)}#${active ? 'S' : ''}#${nItems}`;
          if (sig === lastScreenSig) screenStall += 1;
          else {
            screenStall = 0;
            lastScreenSig = sig;
          }
          if (screenStall >= STALL_LIMIT) {
            cy.task(
              'writeJsonl',
              {
                path: STUCK_LOG,
                records: [
                  {
                    step,
                    nItems,
                    active,
                    progressComplete: isProgressComplete(doc),
                    buttons: [...doc.querySelectorAll('button, .continue, .jspsych-btn')]
                      .filter((el) => (el as HTMLElement).offsetParent !== null)
                      .map((el) => ({ cls: el.className, text: (el.textContent ?? '').trim().slice(0, 60) }))
                      .slice(0, 12),
                    bodyText: text.trim().slice(0, 600),
                    bodyHtml: doc.body?.innerHTML?.slice(0, 4000) ?? null,
                  },
                ],
              },
              { log: false },
            );
            cy.wrap(null).then(() => {
              expect(
                false,
                `SRE screen never advanced for ${STALL_LIMIT} passes — unhandled screen (see ${STUCK_LOG})`,
              ).to.equal(true);
            });
            return;
          }

          if (!active) {
            // Practice feedback ("Correct! ... Press the left arrow key to
            // continue.") and block transitions advance on an arrow key, not a
            // button — press both (mirrors roar-dashboard's blind arrow presses)
            // and click any continue button that is present.
            clickSreContinueIfPresent();
            cy.get('body', { log: false }).type('{leftarrow}{rightarrow}', { log: false });
            cy.wait(SRE_STEP_MS * 0.2, { log: false });
            playTrials(iterLeft - 1);
            return;
          }

          const lr = readCorrectLrFromWindow(win);
          if (!lr) {
            nNoLr += 1;
            cy.task(
              'writeJsonl',
              {
                path: NO_LR_LOG,
                records: [
                  {
                    step,
                    snippet: text.slice(0, 240),
                    // Capture the storage layout on the first miss so a missing
                    // key can be diagnosed without another 30-min hang.
                    store: nNoLr <= 3 ? dumpStoreKeys(win) : undefined,
                  },
                ],
              },
              { log: false },
            );
            // Advance anyway (mirrors roar-dashboard's blind arrow presses) so a
            // single unreadable trial can't stall the whole run.
            cy.get('body', { log: false }).type('{leftarrow}', { log: false });
            cy.wait(SRE_STEP_MS * 0.08, { log: false });
            playTrials(iterLeft - 1);
            return;
          }

          nItems += 1;
          logRecord({
            timestamp: new Date().toISOString(),
            itemType: 'item',
            correctLr: lr,
            correct: !isWrongAgentMode(),
            oracle: trialRecordOracleFlag(),
          });

          cy.get('body', { log: false }).type(arrowKeyForLr(lr, isWrongAgentMode()), {
            log: false,
          });
          cy.wait(SRE_STEP_MS * 0.08, { log: false });
          playTrials(iterLeft - 1);
        });
      });
  }

  it('completes roar-sre by pressing the sessionStorage correctLR on every trial', () => {
    launchTask({
      taskId: 'sre',
      demoUrl: 'about:blank',
      onBeforeLoad: installAudioCapture,
    });

    waitForRoarJsPsych();
    advanceSreStartup();
    logRecord({
      timestamp: new Date().toISOString(),
      itemType: 'intro',
      correctLr: null,
      correct: null,
      oracle: trialRecordOracleFlag(),
    });

    playTrials();
  });
});
