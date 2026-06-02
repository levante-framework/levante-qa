/**
 * SWR — DOM exploration (dashboard launch).
 *
 *   LAUNCH=dashboard PARTICIPANT_USER=... PARTICIPANT_PASS=... \
 *     npx cypress run --spec cypress/e2e/swr/_explore.cy.ts
 */
import { installAudioCapture } from '../../support/audio/audioCapture';
import { launchTask } from '../../support/launch';
import { waitForRoarJsPsych } from '../../support/tasks/roar';
import {
  advanceSwrLexicalityTutorial,
  advanceSwrStartup,
  readCorrectLrFromWindow,
  STIMULUS,
} from '../../support/tasks/swr';

const LIVE_LOG = 'cypress/logs/_swr_explore.jsonl';

function snapshot(win: Window, step: number, label: string): void {
  const doc = win.document;
  cy.task(
    'writeJsonl',
    {
      path: LIVE_LOG,
      records: [
        {
          step,
          label,
          correctLr: readCorrectLrFromWindow(win),
          stimulus: doc.querySelectorAll(STIMULUS).length,
          jspsychBtns: doc.querySelectorAll('.jspsych-btn').length,
          bodySnippet: (doc.body?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
        },
      ],
    },
    { log: false },
  );
}

describe('SWR — explore DOM (dashboard)', () => {
  it('launches roar-swr and records startup chrome', () => {
    launchTask({
      taskId: 'swr',
      demoUrl: 'about:blank',
      onBeforeLoad: installAudioCapture,
    });

    waitForRoarJsPsych();
    advanceSwrStartup();
    advanceSwrLexicalityTutorial();
    cy.window().then((w) => snapshot(w, 0, 'after_lexicality_tutorial'));

    cy.get(STIMULUS, { timeout: 180000 }).should('exist');
    cy.window().then((w) => snapshot(w, 1, 'first_stimulus'));
  });
});
