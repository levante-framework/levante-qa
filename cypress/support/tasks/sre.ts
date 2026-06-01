/**
 * SRE (ROAR Sentence Reading Efficiency / @bdelab/roar-sre) — dashboard-only task.
 *
 * Answer key: roar-sre sets `correctLR` to `"left"` or `"right"` in store2's session
 * area (sessionStorage keys containing `correctLR`). The participant responds with
 * arrow keys. Verified against @bdelab/roar-sre@3.0.0 bundle and roar-dashboard
 * `cypress/support/helper-functions/roar-sre/sreHelpers.js`.
 */

import type { SreSummaryStats, SreTrialRecord } from './types';

export const SRE_ROUTE = '/game/sre';

export const JSPSYCH_BTN = '.jspsych-btn';
export const STIMULUS = '.stimulus';
export const PROGRESS_INNER = '#jspsych-progressbar-inner';

/** Matches roar-dashboard `Cypress.env('timeout')` default (10s). */
export const SRE_STEP_MS = 10_000;
export const SRE_ASSET_WAIT_MS = SRE_STEP_MS * 1.5;

export const SRE_EN = {
  welcome: 'Welcome to the Sentence Reading Efficiency',
  endThankYou: 'Thank you so much for completing our activity',
} as const;

export type CorrectLr = 'left' | 'right';

/** Read store2 session `correctLR` from sessionStorage (key suffix varies). */
export function readCorrectLrFromWindow(win: Window): CorrectLr | null {
  try {
    const storage = win.sessionStorage;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i) ?? '';
      if (!key.includes('correctLR')) continue;
      const raw = storage.getItem(key);
      if (!raw) continue;
      const v = raw.replace(/^"|"$/g, '').trim().toLowerCase();
      if (v === 'left' || v === 'right') return v;
    }
  } catch {
    // ignore
  }
  return null;
}

export function isProgressComplete(doc: Document): boolean {
  const style = doc.querySelector(PROGRESS_INNER)?.getAttribute('style') ?? '';
  return style.includes('width: 100%');
}

export function isDashboardReroute(bodyText: string): boolean {
  return bodyText.includes('Sign Out');
}

export function hasActiveStimulus(doc: Document): boolean {
  return doc.querySelectorAll(STIMULUS).length > 0;
}

export function arrowKeyForLr(lr: CorrectLr, wrong = false): string {
  const side = wrong ? (lr === 'left' ? 'right' : 'left') : lr;
  return side === 'left' ? '{leftarrow}' : '{rightarrow}';
}

/** Wait until jsPsych intro chrome is present (mirrors dashboard waitForAssessmentReadyState). */
export function waitForSreReady(): void {
  cy.get(JSPSYCH_BTN, { timeout: 120000 }).should('exist');
}

/**
 * Startup after dashboard launch: first jspsych button + fullscreen permission
 * workarounds from roar-dashboard `playSRE`.
 */
export function advanceSreStartup(): void {
  waitForSreReady();
  cy.get(JSPSYCH_BTN).should('be.visible').click({ force: true });
  cy.wait(200, { log: false });
  cy.get('body', { log: false }).type('{enter}', { log: false });
  cy.wait(200, { log: false });
  cy.get('body', { log: false }).type('1', { log: false });
  cy.contains(SRE_EN.welcome, { timeout: 120000 }).should('be.visible');
}

/** Click a visible jsPsych button when present (block transitions / continue). */
export function clickSreContinueIfPresent(): void {
  cy.get('body', { log: false }).then(($b) => {
    const $btn = $b.find(`${JSPSYCH_BTN}:visible`);
    if ($btn.length > 0) cy.wrap($btn.first()).click({ force: true });
  });
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function scoreTrials(trials: SreTrialRecord[]): SreSummaryStats {
  const items = trials.filter((t) => t.itemType === 'item');
  const scored = items.filter((t) => typeof t.correct === 'boolean');
  const hits = scored.filter((t) => t.correct === true).length;
  const rts = items.map((t) => t.rtMs).filter((v): v is number => typeof v === 'number');
  const timedOut = items.filter((t) => t.timedOut === true).length;

  return {
    nItems: items.length,
    accuracy: scored.length > 0 ? hits / scored.length : null,
    rtMean: mean(rts),
    timeoutRate: items.length > 0 ? timedOut / items.length : 0,
  };
}
