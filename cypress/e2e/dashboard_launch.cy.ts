import { installAudioCapture } from '../support/audio/audioCapture';
import { isDashboardLaunch, loginToDashboard, launchCoreTask } from '../support/launch';

/**
 * Dashboard launch smoke test.
 *
 * Validates the participant -> dashboard -> core-task launch path end to end:
 * log in to the -dev dashboard as the QA participant, confirm the bootstrapped
 * "QA All Tasks" assignment renders its core-task links, then launch egma-math
 * inline and confirm the core-tasks launcher reaches its first screen (the
 * "Switch to full screen mode / OK" prompt) — the same entrypoint the oracle
 * and VLM specs drive.
 *
 * The participant + assignment are provisioned by
 * `levante-support/scripts/e2e-init/setup-qa-site.ts`. This spec self-skips
 * unless dashboard launch is configured (LAUNCH=dashboard + participant creds),
 * so it never breaks the default standalone-demo runs.
 */
const dashboardConfigured = isDashboardLaunch() && !!Cypress.expose('PARTICIPANT_USER');

(dashboardConfigured ? describe : describe.skip)('dashboard launch', () => {
  it('logs in, shows the assignment, and launches egma-math', () => {
    loginToDashboard(installAudioCapture);

    // The home shows a spinner, then renders the assignment's core-task links.
    cy.get('a[href*="core-tasks/egma-math"]', { timeout: 60000 }).should('exist');
    cy.get('a[href*="core-tasks/hearts-and-flowers"]').should('exist');

    launchCoreTask('egma-math');
    cy.location('pathname', { timeout: 30000 }).should('contain', '/game/core-tasks/egma-math');

    // The core-tasks launcher renders its fullscreen prompt with an OK button.
    cy.contains('OK', { timeout: 300000 }).should('be.visible');
  });
});
