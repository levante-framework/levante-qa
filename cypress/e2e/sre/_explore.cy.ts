/**
 * SRE — DOM exploration (dashboard launch).
 *
 *   LAUNCH=dashboard PARTICIPANT_USER=... PARTICIPANT_PASS=... \
 *     npx cypress run --spec cypress/e2e/sre/_explore.cy.ts
 */
import { installAudioCapture } from '../../support/audio/audioCapture';
import { launchTask } from '../../support/launch';
import {
  advanceSreStartup,
  readCorrectLrFromWindow,
  STIMULUS,
} from '../../support/tasks/sre';

const LIVE_LOG = 'cypress/logs/_sre_explore.jsonl';

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

describe('SRE — explore DOM (dashboard)', () => {
  it('launches roar-sre and records startup chrome', () => {
    launchTask({
      taskId: 'sre',
      demoUrl: 'about:blank',
      onBeforeLoad: installAudioCapture,
    });

    cy.get('.jspsych-content, .jspsych-display-element', { timeout: 300000 }).should('exist');
    advanceSreStartup();
    cy.window().then((w) => snapshot(w, 0, 'after_startup'));

    cy.get(STIMULUS, { timeout: 180000 }).should('exist');
    cy.window().then((w) => snapshot(w, 1, 'first_stimulus'));
  });
});
