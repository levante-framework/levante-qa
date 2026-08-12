import { waitForParticipantHomeReady } from './tasks/roar';
import {
  installAudioAssetIntercept,
  installCrowdinApprovedTranslationIntercept,
} from './crowdinTranslations';

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
const ROAR_TRACE_LOG = 'cypress/logs/_roar_vlm_startup_trace.jsonl';

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
  return String(Cypress.expose('LAUNCH') ?? '').toLowerCase() === 'dashboard';
}

/** ROAR tasks are not served from levante-tasks-demo; they require dashboard launch. */
export function isRoarTaskId(taskId: string): boolean {
  return taskId === 'pa' || taskId === 'sre' || taskId === 'swr';
}

function isRoarTraceOn(): boolean {
  const raw = String(Cypress.expose('QA_ROAR_TRACE') ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function traceRoar(stage: string, detail?: Record<string, unknown>): void {
  if (!isRoarTraceOn()) return;
  cy.task(
    'writeJsonl',
    {
      path: ROAR_TRACE_LOG,
      records: [
        {
          ts: new Date().toISOString(),
          stage,
          taskId: String(Cypress.expose('TASK_ID') ?? ''),
          launch: String(Cypress.expose('LAUNCH') ?? ''),
          language: String(Cypress.expose('QA_LANGUAGE') ?? ''),
          ...detail,
        },
      ],
    },
    { log: false },
  );
}

function dashboardBase(): string {
  return String(Cypress.expose('DASHBOARD_URL') ?? DEFAULT_DASHBOARD_URL).replace(/\/+$/, '');
}

/** App UI + narration locale for this run (set by the dashboard language picker). */
function qaLocale(): string {
  return String(Cypress.expose('QA_LANGUAGE') ?? '').trim();
}

/**
 * Wrap an `onBeforeLoad` hook so it also pins the LEVANTE platform locale in
 * sessionStorage before the app boots. This is what drives the task's UI and
 * audio-narration language (assets are served per-locale, e.g. `audio/es-CO/…`).
 * It must run on the FIRST visit (signin/demo) so the app reads it during init.
 * No-op when QA_LANGUAGE is unset (manual runs keep the app default).
 */
function withQaLocale(onBeforeLoad: (win: Window) => void): (win: Window) => void {
  const locale = qaLocale();
  return (win: Window) => {
    if (locale) {
      try {
        win.sessionStorage.setItem('levantePlatformLocale', locale);
        win.sessionStorage.setItem('roarPlatformLocale', locale);
      } catch {
        // sessionStorage may be unavailable this early; locale pin is best-effort.
      }
    }
    onBeforeLoad(win);
  };
}

/**
 * Log in to the dashboard as a participant. Credentials come from the
 * `PARTICIPANT_USER` / `PARTICIPANT_PASS` env vars.
 */
export function loginToDashboard(onBeforeLoad: (win: Window) => void): void {
  const user = String(Cypress.expose('PARTICIPANT_USER') ?? '');
  const pass = String(Cypress.expose('PARTICIPANT_PASS') ?? '');
  expect(user, 'PARTICIPANT_USER env is set').to.not.equal('');
  expect(pass, 'PARTICIPANT_PASS env is set').to.not.equal('');

  traceRoar('login:start', { dashboard: dashboardBase() });
  cy.visit(`${dashboardBase()}/signin`, { onBeforeLoad: withQaLocale(onBeforeLoad) });
  cy.get('[data-cy=input-username-email]', { timeout: 60000 })
    .should('be.visible')
    .clear()
    .type(user, { log: false });
  cy.get('[data-cy=input-password]').clear().type(pass, { log: false });
  cy.get('[data-cy=submit-sign-in-with-password]').click();

  cy.location('pathname', { timeout: 60000 }).should((p) =>
    expect(p, 'navigated away from /signin after login').to.not.match(/\/signin$/),
  );
  traceRoar('login:done');
}

/**
 * From the participant home, start an assigned **core** task (`/game/core-tasks/…`).
 */
export function launchCoreTask(taskId: string): void {
  // Dashboard home variants no longer guarantee PrimeVue tab markup
  // (`[data-pc-section=tablist]`). Wait for the home shell, then prefer any
  // visible launch link; fall back to direct route if cards are not rendered.
  waitForParticipantHomeReady(taskId, false);
  cy.get('body', { timeout: 120000 }).then(($b) => {
    const selectors = [
      `a[href*="/game/core-tasks/${taskId}"]`,
      `a[href*="core-tasks/${taskId}"]`,
      `a[href*="/game/${taskId}"]`,
    ];
    const $link = $b.find(selectors.join(', ')).filter(':visible');
    if ($link.length) {
      cy.wrap($link.first()).scrollIntoView().click({ force: true });
      return;
    }
    cy.visit(`${dashboardBase()}/game/core-tasks/${taskId}`, { onBeforeLoad: withQaLocale(() => {}) });
  });
  cy.location('pathname', { timeout: 120000 }).should('include', `/game/core-tasks/${taskId}`);
}

/**
 * From the participant home, start an assigned **ROAR** task via its game-btn
 * (never cold-navigate — assignment + Firekit must be ready on home first).
 */
export function launchRoarTask(taskId: string): void {
  traceRoar('launchRoarTask:start', { taskId });
  // Some provisioned participants occasionally land on home before the ROAR
  // game card renders (or the card is hidden by assignment UI state). Do not
  // fail launch solely on a missing card: click it when present, otherwise
  // navigate directly to the known route once the home shell is ready.
  waitForParticipantHomeReady(taskId, false);
  traceRoar('launchRoarTask:home-ready', { taskId });

  cy.get('body', { timeout: 120000 }).then(($b) => {
    // Some dashboard variants render ROAR launch links without `.game-btn`;
    // prefer any visible anchor to `/game/<task>` before direct fallback.
    const $link = $b.find(`a[href*="/game/${taskId}"]`).filter(':visible');
    if ($link.length) {
      traceRoar('launchRoarTask:click-game-link', { taskId, linksVisible: $link.length });
      cy.wrap($link.first()).scrollIntoView().click({ force: true });
      return;
    }
    // Local vite GameTabs uses `.game-card--available` (href may be `/` when
    // variantURL is set); still try the card before cold-navigating.
    const $card = $b.find('a.game-card--available').filter(':visible');
    if ($card.length) {
      traceRoar('launchRoarTask:click-game-card', { taskId, cardsVisible: $card.length });
      cy.wrap($card.first()).scrollIntoView().click({ force: true });
      return;
    }
    traceRoar('launchRoarTask:fallback-direct-visit', { taskId });
    cy.visit(`${dashboardBase()}/game/${taskId}`, { onBeforeLoad: withQaLocale(() => {}) });
  });

  // If the card click left us on home (e.g. href="/"), cold-navigate.
  cy.location('pathname', { timeout: 30000 }).then((pathname) => {
    if (!String(pathname).includes(`/game/${taskId}`)) {
      traceRoar('launchRoarTask:retry-direct-visit', { taskId, pathname: String(pathname) });
      cy.visit(`${dashboardBase()}/game/${taskId}`, { onBeforeLoad: withQaLocale(() => {}) });
    }
  });

  cy.location('pathname', { timeout: 120000 }).should('include', `/game/${taskId}`);
  traceRoar('launchRoarTask:done', { taskId });
}

/**
 * Launch a task by the configured strategy.
 * ROAR tasks always use dashboard mode (no standalone demo URL).
 */
export function launchTask(opts: LaunchOptions): void {
  installCrowdinApprovedTranslationIntercept();
  installAudioAssetIntercept();

  if (isRoarTaskId(opts.taskId)) {
    Cypress.expose('TASK_ID', opts.taskId);
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
  cy.visit(opts.demoUrl, { onBeforeLoad: withQaLocale(opts.onBeforeLoad) });
}
