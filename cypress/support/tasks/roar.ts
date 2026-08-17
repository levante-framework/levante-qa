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
const ROAR_TRACE_LOG = 'cypress/logs/_roar_vlm_wait_trace.jsonl';

type RoarCypress = typeof Cypress & { __roarStartFailed?: string; __roarAlertHooked?: boolean };

function installRoarStartAlertHook(): void {
  const cyx = Cypress as RoarCypress;
  if (cyx.__roarAlertHooked) return;
  cyx.__roarAlertHooked = true;
  cy.on('window:alert', (text) => {
    if (ROAR_START_FAILED.test(String(text))) {
      cyx.__roarStartFailed = String(text);
    }
  });
}

function isRoarTraceOn(): boolean {
  const raw = String(Cypress.expose('QA_ROAR_TRACE') ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function traceWait(record: Record<string, unknown>): void {
  if (!isRoarTraceOn()) return;
  cy.task(
    'writeJsonl',
    {
      path: ROAR_TRACE_LOG,
      records: [{ ts: new Date().toISOString(), ...record }],
    },
    { log: false },
  );
}

function docHasRoarReady(doc: Document): boolean {
  // Some ROAR builds mount `#jspsych-target` first, then populate inner jsPsych
  // nodes lazily. Treat the mount point itself as "ready enough" so startup
  // helpers can take over, instead of spinning in waitForRoarJsPsych forever.
  if (doc.querySelector(JSPSYCH_TARGET)) return true;
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
export function waitForParticipantHomeReady(taskId: string, requireTaskLink = true): void {
  cy.get('[data-cy=app-initializing]', { timeout: 300000 }).should('not.exist');
  cy.get('h2.assignment__name', { timeout: 300000 }).should('be.visible');
  dismissLevanteConsentIfPresent();
  if (requireTaskLink) {
    cy.get(`a.game-btn[href*="/game/${taskId}"]`, { timeout: 300000 }).should('be.visible');
  }
}

function reloadAndRetryWait(reloadLeft: number): void {
  (Cypress as RoarCypress).__roarStartFailed = undefined;
  cy.reload();
  waitForRoarJsPsych(reloadLeft - 1, 0);
}

/**
 * Poll until roar-* leaves the fullscreen spinner (mirrors roar-dashboard
 * `waitForAssessmentReadyState`). Retries one full page reload if still stuck
 * or if the dashboard alerts "failed to start" (its own copy says to refresh;
 * this often flakes when two ROAR games boot at once).
 */
export function waitForRoarJsPsych(reloadLeft = 1, attempt = 0): void {
  const MAX_ATTEMPTS = 150;
  installRoarStartAlertHook();

  if (attempt >= MAX_ATTEMPTS) {
    if (reloadLeft > 0) {
      reloadAndRetryWait(reloadLeft);
      return;
    }
    cy.get(ROAR_READY_SELECTORS, { timeout: 1000 }).should('exist');
    return;
  }

  cy.window({ log: false }).then((win) => {
    const doc = win.document;
    const bodyText = doc.body?.textContent ?? '';
    const alertFail = (Cypress as RoarCypress).__roarStartFailed;
    if (attempt % 10 === 0) {
      traceWait({
        stage: 'waitForRoarJsPsych:poll',
        attempt,
        reloadLeft,
        path: win.location?.pathname ?? null,
        href: win.location?.href ?? null,
        ready: docHasRoarReady(doc),
        hasJsPsychTarget: !!doc.querySelector(JSPSYCH_TARGET),
        bodySnippet: bodyText.replace(/\s+/g, ' ').trim().slice(0, 220),
      });
    }
    if (alertFail || ROAR_START_FAILED.test(bodyText)) {
      traceWait({
        stage: 'waitForRoarJsPsych:start-failed',
        attempt,
        reloadLeft,
        path: win.location?.pathname ?? null,
        bodySnippet: (alertFail || bodyText).replace(/\s+/g, ' ').trim().slice(0, 400),
      });
      if (reloadLeft > 0) {
        cy.wait(2000, { log: false });
        reloadAndRetryWait(reloadLeft);
        return;
      }
      throw new Error(
        `Dashboard reported the ROAR task failed to start: ${alertFail || 'alert/body text visible'}`,
      );
    }
    // Require real jsPsych content, not merely #jspsych-target (TaskPA mounts
    // that node immediately under the Levante spinner, before start succeeds).
    const ready =
      !!doc.querySelector(`${JSPSYCH_TARGET} .jspsych-content-wrapper`) ||
      !!doc.querySelector(`${JSPSYCH_TARGET} .jspsych-content`) ||
      !!doc.querySelector('.jspsych-btn') ||
      !!doc.querySelector('.instructionCanvasNS');
    if (ready) {
      traceWait({
        stage: 'waitForRoarJsPsych:ready',
        attempt,
        path: win.location?.pathname ?? null,
      });
      return;
    }
    cy.wait(2000, { log: false });
    waitForRoarJsPsych(reloadLeft, attempt + 1);
  });
}
