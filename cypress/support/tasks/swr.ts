/**
 * SWR (ROAR Single Word Recognition / @bdelab/roar-swr) — dashboard-only task.
 *
 * Answer key: store2 session `correctLR` (`"left"` / `"right"`), same pattern as SRE.
 * Trials show `.stimulus`; block boundaries have no stimulus (press left + Continue).
 * Flow ported from roar-dashboard `swrHelpers.js` + `@bdelab/roar-swr` bundle.
 */

import type { SwrSummaryStats, SwrTrialRecord } from './types';
import {
  arrowKeyForLr,
  hasActiveStimulus,
  isDashboardReroute,
  isProgressComplete,
  readCorrectLrFromWindow,
  type CorrectLr,
} from './sre';

export const SWR_ROUTE = '/game/swr';

export const JSPSYCH_BTN = '.jspsych-btn';
export const STIMULUS = '.stimulus';
export const PROGRESS_INNER = '#jspsych-progressbar-inner';

export const SWR_STEP_MS = 10_000;
export const SWR_ASSET_WAIT_MS = SWR_STEP_MS * 1.5;

/** English strings from roar-dashboard `roar-swr/languageOptions.js`. */
export const SWR_EN = {
  introText: 'Welcome to the world of Lexicality!',
  continue: 'Continue',
  blockEndMarkers: [
    'You are halfway through the first block',
    'You have completed the first block',
    'You are halfway through the second block',
    'You have completed the second block',
    'You are halfway through the third block',
    'Press ANY KEY',
  ] as const,
} as const;

export {
  arrowKeyForLr,
  hasActiveStimulus,
  isDashboardReroute,
  isProgressComplete,
  readCorrectLrFromWindow,
};
export type { CorrectLr };

export function waitForSwrReady(): void {
  cy.get(JSPSYCH_BTN, { timeout: 120000 }).should('exist');
}

/** Body text markers for the Lexicality gate (en + es variants on dev). */
export function bodyHasSwrLexicalityIntro(text: string): boolean {
  return (
    text.includes(SWR_EN.introText) ||
    text.includes('Lexicalidad') ||
    text.includes('Lexicality')
  );
}

const FULLSCREEN_BTN = '#jspsych-fullscreen-btn, .jspsych-fullscreen-btn';

/**
 * After the first jsPsych button, roar-swr may show fullscreen consent and/or
 * audio checks before the Lexicality tutorial. Mirrors SRE `playSRE` (enter + 1)
 * plus clicking through `#jspsych-fullscreen-btn` when present.
 */
function dismissSwrUntilLexicality(attempt = 0): void {
  const MAX = 120;
  if (attempt >= MAX) {
    cy.contains(SWR_EN.introText, { timeout: 30 * SWR_STEP_MS }).should('be.visible');
    return;
  }

  cy.get('body', { log: false }).then(($b) => {
    if (bodyHasSwrLexicalityIntro($b.text())) return;

    const $fs = $b.find(FULLSCREEN_BTN).filter(':visible');
    if ($fs.length) {
      cy.wrap($fs.first()).click({ force: true });
    } else {
      const $btn = $b.find(`${JSPSYCH_BTN}:visible`);
      if ($btn.length) {
        cy.wrap($btn.first()).click({ force: true });
      } else if (attempt % 5 === 0) {
        cy.get('body', { log: false }).type('{enter}', { log: false });
      }
    }
    cy.wait(1000, { log: false });
    dismissSwrUntilLexicality(attempt + 1);
  });
}

/** First jspsych button + pre-Lexicality chrome (fullscreen / continue chain). */
export function advanceSwrStartup(): void {
  waitForSwrReady();
  cy.get(JSPSYCH_BTN, { timeout: 18 * SWR_STEP_MS }).should('be.visible').click({ force: true });
  cy.wait(SWR_STEP_MS * 0.1, { log: false });
  cy.get('body', { log: false }).type('{enter}', { log: false });
  cy.wait(200, { log: false });
  cy.get('body', { log: false }).type('1', { log: false });
  cy.wait(200, { log: false });
  dismissSwrUntilLexicality();
}

/** Lexicality tutorial: intro text, three left presses, then Continue. */
export function advanceSwrLexicalityTutorial(): void {
  cy.get('body', { log: false }).then(($b) => {
    if (!bodyHasSwrLexicalityIntro($b.text())) dismissSwrUntilLexicality();
  });
  cy.get('body', { timeout: 30 * SWR_STEP_MS, log: false }).should(($b) => {
    expect(bodyHasSwrLexicalityIntro($b.text()), 'Lexicality tutorial intro').to.equal(true);
  });
  for (let i = 0; i < 3; i++) {
    cy.get('body', { log: false }).type('{leftarrow}', { log: false });
  }
  cy.get(JSPSYCH_BTN, { timeout: 10 * SWR_STEP_MS }).should('be.visible').click({ force: true });
}

/** Practice intro: alternate arrows then click Continue (mirrors `playIntro`). */
export function advanceSwrPracticeIntro(): void {
  for (let i = 0; i <= 5; i++) {
    cy.wait(SWR_STEP_MS * 0.2, { log: false });
    cy.get('body', { log: false }).type('{leftarrow}{rightarrow}', { log: false });
    cy.wait(SWR_STEP_MS * 0.2, { log: false });
    cy.get('body', { log: false }).type('{leftarrow}{rightarrow}', { log: false });
    cy.wait(SWR_STEP_MS * 0.2, { log: false });
  }
  cy.get(JSPSYCH_BTN, { timeout: 5 * SWR_STEP_MS })
    .contains(SWR_EN.continue)
    .click({ force: true });
}

/** Click Continue when the visible jspsych button label matches. */
export function clickSwrContinue(): void {
  cy.get(JSPSYCH_BTN, { timeout: 5 * SWR_STEP_MS })
    .contains(SWR_EN.continue)
    .click({ force: true });
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function scoreTrials(trials: SwrTrialRecord[]): SwrSummaryStats {
  const items = trials.filter((t) => t.itemType === 'item');
  const scored = items.filter((t) => typeof t.correct === 'boolean');
  const hits = scored.filter((t) => t.correct === true).length;
  const rts = items.map((t) => t.rtMs).filter((v): v is number => typeof v === 'number');
  const timedOut = items.filter((t) => t.timedOut === true).length;
  const breaks = trials.filter((t) => t.itemType === 'break').length;

  return {
    nItems: items.length,
    accuracy: scored.length > 0 ? hits / scored.length : null,
    rtMean: mean(rts),
    timeoutRate: items.length > 0 ? timedOut / items.length : 0,
    nBreaks: breaks,
  };
}
