/**
 * SWR adaptiveTimingMultiStage (and other userMode) QA override.
 *
 * roar-swr merges userParams into config then writes updateTaskParams from
 * gameParams keys using merged values — so ATM on userParams alone still hits
 * Firestore rejection unless the local vite roar-swr prebundle is disk-patched
 * so j2 keeps stock gameParams (scripts/e2e-init/patch-roar-swr-usermode.mjs /
 * cy.task patchRoarSwrUserMode). Restart vite without --force after patching.
 *
 * Local TaskSWR.vue forwards window.__QA_SWR_USER_MODE onto userParams when set.
 * This bridge sets that flag and ensures the stock-j2 disk patch.
 *
 * Enable: QA_SWR_USER_MODE=adaptiveTimingMultiStage
 * Prefer: DASHBOARD_URL=http://127.0.0.1:5173 (hosted admin-dev may lack ATM).
 */

function requestedUserMode(): string {
  const fromExpose = String(Cypress.expose('QA_SWR_USER_MODE') ?? '').trim();
  if (fromExpose) return fromExpose;
  return String(Cypress.env('QA_SWR_USER_MODE') ?? '').trim();
}

export function swrUserModeRuntime(): string | null {
  const mode = requestedUserMode();
  return mode || null;
}

export function installSwrUserModeFlag(win: Window): void {
  const mode = requestedUserMode();
  (win as unknown as { __QA_SWR_USER_MODE?: string }).__QA_SWR_USER_MODE = mode || undefined;
}

export function installSwrUserModeBridge(): void {
  const mode = requestedUserMode();
  if (!mode) return;

  cy.task('patchRoarSwrUserMode', mode, { log: true }).then((result) => {
    const r = result as { ok?: boolean; reason?: string; stockJ2?: boolean };
    expect(r?.ok, `patchRoarSwrUserMode: ${r?.reason ?? JSON.stringify(result)}`).to.eq(true);
    cy.log(`SWR userMode stock-j2 patch ok (stockJ2=${Boolean(r?.stockJ2)})`);
  });

  Cypress.on('window:before:load', (win) => {
    installSwrUserModeFlag(win);
    try {
      win.sessionStorage.removeItem('initialized');
      win.localStorage.removeItem('initialized');
    } catch {
      /* ignore */
    }
  });

  cy.log(`SWR userMode bridge: ${mode} (flag + stock-j2 disk patch)`);
}
