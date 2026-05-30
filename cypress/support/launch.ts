/**
 * Task launch strategies.
 *
 * By default a spec loads the standalone hosted demo (`?task=…`): fast, no auth,
 * ideal for the regression/benchmark loops. Set `LAUNCH=dashboard` to instead
 * drive the *real* participant flow: log in to the `-dev` dashboard and start
 * the assigned core task.
 *
 * The core task runs INLINE in the same dashboard SPA (`#jspsych-target`,
 * route `/game/core-tasks/:taskId`) — same origin, no iframe — so the Web Audio
 * capture installed via `onBeforeLoad` and every task selector keep working
 * exactly as they do against the demo. Because the dashboard navigates to the
 * task client-side (Vue router, no full reload), the patch installed at the
 * sign-in page load persists into the task.
 */

/** Default `-dev` dashboard host (admin-dev, where the QA participant has
 * assignments). Override with the `DASHBOARD_URL` env var. */
const DEFAULT_DASHBOARD_URL = 'https://hs-levante-admin-dev.web.app';

export interface LaunchOptions {
  /** Core-tasks task id, e.g. `egma-math` or `hearts-and-flowers`. */
  taskId: string;
  /** Standalone demo URL (with `?task=…`) used when not in dashboard mode. */
  demoUrl: string;
  /** Hook to install the Web Audio capture in the target window. */
  onBeforeLoad: (win: Window) => void;
}

/** True when specs should launch via the dashboard participant flow. */
export function isDashboardLaunch(): boolean {
  return String(Cypress.env('LAUNCH') ?? '').toLowerCase() === 'dashboard';
}

function dashboardBase(): string {
  return String(Cypress.env('DASHBOARD_URL') ?? DEFAULT_DASHBOARD_URL).replace(/\/+$/, '');
}

/**
 * Log in to the dashboard as a participant. Credentials come from the
 * `PARTICIPANT_USER` / `PARTICIPANT_PASS` env vars (a bare username is mapped to
 * an internal auth email by the dashboard itself). The audio capture is
 * installed at this initial page load and survives the later client-side
 * navigation into the task.
 */
export function loginToDashboard(onBeforeLoad: (win: Window) => void): void {
  const user = String(Cypress.env('PARTICIPANT_USER') ?? '');
  const pass = String(Cypress.env('PARTICIPANT_PASS') ?? '');
  expect(user, 'PARTICIPANT_USER env is set').to.not.equal('');
  expect(pass, 'PARTICIPANT_PASS env is set').to.not.equal('');

  cy.visit(`${dashboardBase()}/signin`, { onBeforeLoad });
  cy.get('[data-cy=input-username-email]', { timeout: 60000 })
    .should('be.visible')
    .clear()
    .type(user, { log: false });
  cy.get('[data-cy=input-password]').clear().type(pass, { log: false });
  cy.get('[data-cy=submit-sign-in-with-password]').click();

  // Fail fast if auth did not take (otherwise the task wait would just hang).
  cy.location('pathname', { timeout: 60000 }).should((p) =>
    expect(p, 'navigated away from /signin after login').to.not.match(/\/signin$/),
  );
}

/**
 * From the participant home, start the assigned core task whose route targets
 * `taskId`. GameTabs renders the launch control as a router-link to
 * `/game/core-tasks/<taskId>`; clicking it is a same-window SPA navigation, so
 * the previously installed audio patch is preserved.
 */
export function launchCoreTask(taskId: string): void {
  cy.get('[data-pc-section=tablist]', { timeout: 120000 }).should('exist');
  cy.get(`a[href*="core-tasks/${taskId}"]`, { timeout: 60000 })
    .first()
    .scrollIntoView()
    .click({ force: true });
}

/**
 * Launch a task by the configured strategy. In demo mode this is a plain
 * `cy.visit`; in dashboard mode it logs in and starts the assigned task. In both
 * cases the caller then proceeds with the same instruction/trial loop.
 */
export function launchTask(opts: LaunchOptions): void {
  if (isDashboardLaunch()) {
    loginToDashboard(opts.onBeforeLoad);
    launchCoreTask(opts.taskId);
    return;
  }
  cy.visit(opts.demoUrl, { onBeforeLoad: opts.onBeforeLoad });
}
