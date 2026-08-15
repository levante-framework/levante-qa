/**
 * PA adaptive mode cannot be set via Firestore variantParams: writing
 * `isAdaptive` into gameParams makes roar-pa's updateTaskParams hit
 * FirebaseError permission-denied on hs-levante-admin-dev.
 *
 * Instead: leave assignment params stock (fixed), and at runtime move
 * `isAdaptive` onto userParams (initConfig merges it; updateTaskParams only
 * iterates gameParams keys so the write stays clean).
 *
 * Enable with QA_PA_IS_ADAPTIVE=true|1|yes.
 */

function adaptiveRequested(): boolean {
  const raw = String(Cypress.expose('QA_PA_IS_ADAPTIVE') ?? '')
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/** True when this Cypress run requested PA adaptive (CAT) via QA_PA_IS_ADAPTIVE. */
export function isPaAdaptiveRuntime(): boolean {
  return adaptiveRequested();
}

function numTestItemsRequested(): number | null {
  const raw = String(Cypress.expose('QA_PA_NUM_TEST_ITEMS') ?? '').trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** Pin flags TaskPA.vue / the asset patch read. Call from onBeforeLoad. */
export function installPaAdaptiveFlag(win: Window): void {
  const w = win as unknown as {
    __QA_PA_IS_ADAPTIVE?: boolean;
    __QA_PA_NUM_TEST_ITEMS?: number;
  };
  w.__QA_PA_IS_ADAPTIVE = adaptiveRequested();
  const n = numTestItemsRequested();
  if (n != null) w.__QA_PA_NUM_TEST_ITEMS = n;
}

/**
 * Register before launchTask. No-op unless QA_PA_IS_ADAPTIVE is set.
 * Rewrites the dashboard TaskPA chunk so isAdaptive is passed via userParams.
 */
export function installPaAdaptiveBridge(): void {
  if (!adaptiveRequested() && numTestItemsRequested() == null) return;

  // /game/pa is often a full document load; signin onBeforeLoad is not enough.
  Cypress.on('window:before:load', (win) => {
    installPaAdaptiveFlag(win);
  });

  cy.intercept('**/assets/TaskPA-*.js', (req) => {
    req.continue((res) => {
      const body = res.body;
      if (typeof body !== 'string' || !body.includes('variantParams')) return;

      let next = body;
      // Strip isAdaptive from gameParams (variantParams spread) before run().
      next = next.replace(
        /(\w+)=\{(\.\.\.\w+\._taskInfo\.variantParams)\}/g,
        '$1={$2};delete $1.isAdaptive',
      );
      // Inject isAdaptive onto userParams ({grade:...}).
      next = next.replace(/(\w+)=\{grade:([^}]+)\}/g, (full, varName: string, rest: string) => {
        if (/\bisAdaptive\b/.test(rest)) return full;
        return `${varName}={grade:${rest},isAdaptive:!!window.__QA_PA_IS_ADAPTIVE}`;
      });

      if (next !== body) {
        res.send({ statusCode: res.statusCode, headers: res.headers, body: next });
      }
    });
  });

  cy.log('PA adaptive bridge: isAdaptive via userParams (QA_PA_IS_ADAPTIVE)');
}
