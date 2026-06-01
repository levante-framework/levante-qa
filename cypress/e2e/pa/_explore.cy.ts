/**
 * PA (Phonological Awareness / @bdelab/roar-pa) — DOM exploration.
 *
 * Provisions via dashboard or uses PARTICIPANT_* from .env. Run:
 *   LAUNCH=dashboard PARTICIPANT_USER=... PARTICIPANT_PASS=... \
 *     npx cypress run --spec cypress/e2e/pa/_explore.cy.ts
 *
 * Writes cypress/logs/_pa_explore.jsonl with one snapshot per step.
 */
import { installAudioCapture } from '../../support/audio/audioCapture';
import { launchTask } from '../../support/launch';
import {
  advancePaIntro,
  AUDIO_CHOICE,
  correctImageSelector,
  readGoalFromWindow,
} from '../../support/tasks/pa';

const LIVE_LOG = 'cypress/logs/_pa_explore.jsonl';

function snapshotStep(win: Window, step: number, label: string): void {
  const doc = win.document;
  const buttons = [...doc.querySelectorAll('button')].map((b) => ({
    text: (b.textContent ?? '').trim().slice(0, 80),
    class: b.className,
    id: b.id,
  }));
  const imgs = [...doc.querySelectorAll('img')].map((img) => ({
    alt: img.getAttribute('alt') ?? '',
    src: (img.getAttribute('src') ?? '').slice(-60),
  }));
  const audioBtns = doc.querySelectorAll('.jspsych-audio-button-response-button').length;
  const htmlBtns = doc.querySelectorAll('.jspsych-html-button-response-button').length;
  const correct = doc.querySelectorAll('.correct, [aria-label="correct"]').length;
  cy.task(
    'writeJsonl',
    {
      path: LIVE_LOG,
      records: [
        {
          step,
          label,
          audioBtns,
          htmlBtns,
          correctMarkers: correct,
          buttonCount: buttons.length,
          buttons: buttons.slice(0, 12),
          imgs: imgs.slice(0, 8),
          hasJspsych: !!doc.querySelector('.jspsych-content'),
        },
      ],
    },
    { log: false },
  );
}

describe('PA — explore DOM (dashboard)', () => {
  it('launches roar-pa and records trial chrome', () => {
    launchTask({
      taskId: 'pa',
      demoUrl: 'about:blank',
      onBeforeLoad: installAudioCapture,
    });

    cy.get('.jspsych-content-wrapper, .jspsych-content', { timeout: 300000 }).should('exist');
    advancePaIntro();
    cy.window().then((w) => snapshotStep(w, 0, 'after_pa_intro'));

    // First tutorial pair (map + rope) — from roar-dashboard paHelpers.
    cy.get('img[src*="map.webp"]', { timeout: 120000 }).click({ force: true });
    cy.wait(800, { log: false });
    cy.get('img[src*="rope.webp"]').click({ force: true });
    cy.window().then((w) => snapshotStep(w, 1, 'after_tutorial_1'));

    cy.get(AUDIO_CHOICE, { timeout: 180000 })
      .should('have.length.at.least', 2)
      .then(() => {
        cy.window().then((w) => {
          const goal = readGoalFromWindow(w);
          snapshotStep(w, 2, 'first_scored_trial');
          cy.task(
            'writeJsonl',
            {
              path: LIVE_LOG,
              records: [{ label: 'session_goal', goal, selector: goal ? correctImageSelector(goal) : null }],
            },
            { log: false },
          );
        });
      });
  });
});
