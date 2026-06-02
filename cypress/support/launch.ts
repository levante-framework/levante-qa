import { waitForParticipantHomeReady } from './tasks/roar';

/**
 * Task launch strategies.
 *
 * By default a spec loads the standalone hosted demo (`?task=…`): fast, no auth,
 * ideal for the regression/benchmark loops. Set `LAUNCH=dashboard` to instead
 * drive the *real* participant flow: log in to the `-dev` dashboard and start
 * the assigned task.
 *
 * Core tasks run INLINE at `/game/core-tasks/:taskId` (`#jspsych-target`).
 * ROAR literacy tasks (PA, SRE, SWR) use separate routes `/game/pa`, `/game/sre`,
 * `/game/swr` with `@bdelab/roar-*` packages — same `#jspsych-target` container.
 */

/** Default `-dev` dashboard host (admin-dev, where the QA participant has
 * assignments). Override with the `DASHBOARD_URL` env var. */
const DEFAULT_DASHBOARD_URL = 'https://hs-levante-admin-dev.web.app';

export interface LaunchOptions {
  /** Core-tasks id (`egma-math`) or ROAR id (`pa`, `sre`, `swr`). */
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

/** ROAR tasks are not served from levante-tasks-demo; they require dashboard launch. */
export function isRoarTaskId(taskId: string): boolean {
  return taskId === 'pa' || taskId === 'sre' || taskId === 'swr';
}

function dashboardBase(): string {
  return String(Cypress.env('DASHBOARD_URL') ?? DEFAULT_DASHBOARD_URL).replace(/\/+$/, '');
}

/**
 * Log in to the dashboard as a participant. Credentials come from the
 * `PARTICIPANT_USER` / `PARTICIPANT_PASS` env vars.
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

  cy.location('pathname', { timeout: 60000 }).should((p) =>
    expect(p, 'navigated away from /signin after login').to.not.match(/\/signin$/),
  );
}

/**
 * From the participant home, start an assigned **core** task (`/game/core-tasks/…`).
 */
export function launchCoreTask(taskId: string): void {
  cy.get('[data-pc-section=tablist]', { timeout: 300000 }).should('exist');
  cy.get(`a[href*="core-tasks/${taskId}"]`, { timeout: 60000 })
    .first()
    .scrollIntoView()
    .click({ force: true });
}

/**
 * From the participant home, start an assigned **ROAR** task via its game-btn
 * (never cold-navigate — assignment + Firekit must be ready on home first).
 */
export function launchRoarTask(taskId: string): void {
  waitForParticipantHomeReady(taskId);

  cy.get(`a.game-btn[href*="/game/${taskId}"]`, { timeout: 120000 })
    .first()
    .scrollIntoView()
    .click({ force: true });

  cy.location('pathname', { timeout: 120000 }).should('include', `/game/${taskId}`);
}

/**
 * Launch a task by the configured strategy.
 * ROAR tasks always use dashboard mode (no standalone demo URL).
 */
export function launchTask(opts: LaunchOptions): void {
  if (isRoarTaskId(opts.taskId)) {
    expect(isDashboardLaunch(), 'ROAR tasks (pa/sre/swr) require LAUNCH=dashboard').to.equal(
      true,
    );
    loginToDashboard(opts.onBeforeLoad);
    launchRoarTask(opts.taskId);
    return;
  }
  if (isDashboardLaunch()) {
    loginToDashboard(opts.onBeforeLoad);
    launchCoreTask(opts.taskId);
    return;
  }
  cy.visit(opts.demoUrl, { onBeforeLoad: opts.onBeforeLoad });
}
