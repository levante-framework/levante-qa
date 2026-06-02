/**
 * Shared helpers for ROAR dashboard tasks (PA, SRE, SWR) mounted in `#jspsych-target`.
 * levante-dashboard polls `.jspsych-content-wrapper` before hiding LevanteSpinner.
 */

export const JSPSYCH_TARGET = '#jspsych-target';

const ROAR_READY_SELECTORS = [
  `${JSPSYCH_TARGET} .jspsych-content-wrapper`,
  `${JSPSYCH_TARGET} .jspsych-content`,
  `${JSPSYCH_TARGET} .jspsych-display-element`,
  `${JSPSYCH_TARGET} .jspsych-btn`,
  '.jspsych-content-wrapper',
  '.jspsych-content',
  '.jspsych-display-element',
  '.jspsych-btn',
  '.instructionCanvasNS',
].join(', ');

const ROAR_START_FAILED = /error occurred while starting the task/i;

function docHasRoarReady(doc: Document): boolean {
  return ROAR_READY_SELECTORS.split(', ').some((sel) => doc.querySelector(sel));
}

/** Accept PrimeVue consent/assent if it blocks the participant home. */
export function dismissLevanteConsentIfPresent(): void {
  cy.get('body', { log: false }).then(($body) => {
    const $accept = $body
      .find('.p-confirm-dialog .p-button, .p-dialog .p-button, button')
      .filter((_, el) => /^accept$/i.test((el.textContent ?? '').trim()));
    if ($accept.length) cy.wrap($accept.first()).click({ force: true });
  });
}

/**
 * Participant home finished loading: app shell, assignment header, and the task
 * start link for this run's provisioned administration.
 */
export function waitForParticipantHomeReady(taskId: string): void {
  cy.get('[data-cy=app-initializing]', { timeout: 300000 }).should('not.exist');
  cy.get('h2.assignment__name', { timeout: 300000 }).should('be.visible');
  dismissLevanteConsentIfPresent();
  cy.get(`a.game-btn[href*="/game/${taskId}"]`, { timeout: 300000 })
    .should('be.visible');
}

/**
 * Poll until roar-* leaves the fullscreen spinner (mirrors roar-dashboard
 * `waitForAssessmentReadyState`). Retries one full page reload if still stuck.
 */
export function waitForRoarJsPsych(reloadLeft = 1, attempt = 0): void {
  const MAX_ATTEMPTS = 150;

  if (attempt >= MAX_ATTEMPTS) {
    if (reloadLeft > 0) {
      cy.reload();
      waitForRoarJsPsych(reloadLeft - 1, 0);
      return;
    }
    cy.get(ROAR_READY_SELECTORS, { timeout: 1000 }).should('exist');
    return;
  }

  cy.window({ log: false }).then((win) => {
    const doc = win.document;
    const bodyText = doc.body?.textContent ?? '';
    if (ROAR_START_FAILED.test(bodyText)) {
      throw new Error('Dashboard reported the ROAR task failed to start (alert text visible)');
    }
    if (docHasRoarReady(doc)) return;
    cy.wait(2000, { log: false });
    waitForRoarJsPsych(reloadLeft, attempt + 1);
  });
}
