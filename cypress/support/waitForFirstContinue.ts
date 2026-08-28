/**
 * First-screen Continue / OK (`button.primary`).
 *
 * A missing button is usually not a selector bug. The task never mounted:
 * dashboard start alert (auto-dismissed by Cypress), LEVANTE splash hang, or
 * a preload that never finishes. Fail with that reason instead of Cypress's
 * generic "never found button.primary".
 */

const START_FAIL = /error occurred while starting the task|failed to start task|something went wrong/i;

type CypressWithAlert = typeof Cypress & { __qaStartAlert?: string };

export function recordStartAlert(text: string): void {
  (Cypress as CypressWithAlert).__qaStartAlert = String(text ?? '');
}

export function clearStartAlert(): void {
  (Cypress as CypressWithAlert).__qaStartAlert = undefined;
}

export function lastStartAlert(): string {
  return String((Cypress as CypressWithAlert).__qaStartAlert ?? '');
}

export function waitForFirstContinue(options?: {
  timeoutMs?: number;
  click?: boolean;
}): void {
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const shouldClick = options?.click !== false;
  const t0 = Date.now();

  const poll = (): void => {
    cy.window({ log: false }).then((win) => {
      const alert = lastStartAlert();
      const body = (win.document.body?.innerText ?? win.document.body?.textContent ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      if (alert && START_FAIL.test(alert)) {
        throw new Error(`Task failed to start (dashboard alert): ${alert.slice(0, 400)}`);
      }
      if (START_FAIL.test(body)) {
        throw new Error(`Task failed to start (page text): ${body.slice(0, 400)}`);
      }

      const btn = win.document.querySelector('button.primary') as HTMLButtonElement | null;
      if (btn && !btn.disabled && btn.getClientRects().length > 0) {
        const found = cy.get('button.primary', { timeout: 5_000 }).should('be.visible');
        if (shouldClick) found.should('not.be.disabled').click({ force: true });
        return;
      }

      if (Date.now() - t0 >= timeoutMs) {
        const href = win.location?.href ?? '';
        const splash = Boolean(win.document.getElementById('levante-logo-loading'));
        if (splash) {
          throw new Error(
            `Timed out on the LEVANTE splash at ${href} — the task never mounted (not a missing Continue button).`,
          );
        }
        throw new Error(
          `Timed out waiting for Continue (button.primary) at ${href}.`,
        );
      }
      cy.wait(250, { log: false }).then(poll);
    });
  };

  poll();
}
