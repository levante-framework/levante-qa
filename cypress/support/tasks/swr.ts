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
  collectStore,
  dumpStoreKeys,
  hasActiveStimulus,
  isDashboardReroute,
  isProgressComplete,
  type CorrectLr,
} from './sre';

interface SwrStimulus {
  correct_response?: string;
}

function lrFromArrow(value: unknown): CorrectLr | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v === 'left' || v === 'arrowleft') return 'left';
  if (v === 'right' || v === 'arrowright') return 'right';
  return null;
}

function asArray(value: unknown): SwrStimulus[] | null {
  return Array.isArray(value) ? (value as SwrStimulus[]) : null;
}

function asIndex(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * Read the correct arrow for the current SWR (Lexicality) trial (@bdelab/roar-swr 1.x):
 *  - scored trials: store2 session `nextStimulus.correct_response` ("ArrowLeft"/"ArrowRight")
 *  - practice trials: `corpusPractice[practiceIndex].correct_response` (`nextStimulus`
 *    is null during practice)
 *  - fallback: a bare `correct_response` / `correctLR` key
 */
export function readCorrectLrFromWindow(win: Window): CorrectLr | null {
  try {
    const store = collectStore(win);
    const next = store.nextStimulus as SwrStimulus | null | undefined;
    if (next && typeof next === 'object') {
      const lr = lrFromArrow(next.correct_response);
      if (lr) return lr;
    }
    const practice = asArray(store.corpusPractice);
    if (practice) {
      const idx = asIndex(store.practiceIndex);
      if (practice[idx]) {
        const lr = lrFromArrow(practice[idx].correct_response);
        if (lr) return lr;
      }
    }
    return lrFromArrow(store.correct_response) ?? lrFromArrow(store.correctLR);
  } catch {
    return null;
  }
}

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

export { arrowKeyForLr, dumpStoreKeys, hasActiveStimulus, isDashboardReroute, isProgressComplete };
export type { CorrectLr };

export function waitForSwrReady(): void {
  cy.get(JSPSYCH_BTN, { timeout: 120000 }).should('exist');
}

/** Body text markers for the Lexicality gate (en / de / es variants on dev). */
export function bodyHasSwrLexicalityIntro(text: string): boolean {
  const norm = text.replace(/\s+/g, ' ');
  return (
    text.includes(SWR_EN.introText) ||
    text.includes('Lexicalidad') ||
    text.includes('Lexicality') ||
    text.includes('Lexikalität') ||
    /Willkommen.{0,40}Welt der/i.test(norm)
  );
}

/** True when real SWR trials (or arrow-choice items) are on screen — past intro gates. */
export function isSwrPlayableScreen(doc: Document): boolean {
  if (doc.querySelectorAll(STIMULUS).length > 0) return true;
  return !!doc.querySelector(
    '.lexicality-trial-arrows, .btn-arrows, #countdown-arrows-wrapper',
  );
}

function progressStarted(doc: Document): boolean {
  const style = doc.querySelector(PROGRESS_INNER)?.getAttribute('style') ?? '';
  return /width:\s*([1-9]|[1-9]\d)/.test(style);
}

/** Startup finished: Lexicality intro, trials, or assessment progress has begun. */
export function swrStartupComplete(doc: Document, bodyText: string, win: Window): boolean {
  if (bodyHasSwrLexicalityIntro(bodyText)) return true;
  if (isSwrPlayableScreen(doc)) return true;
  if (hasActiveStimulus(doc)) return true;
  if (progressStarted(doc)) return true;
  if (readCorrectLrFromWindow(win)) return true;
  return false;
}

function bodyLooksLikeSwrBlockBreak(text: string): boolean {
  return (
    /Vorgang abgeschlossen|Press ANY KEY|beliebige Taste|presiona cualquier tecla/i.test(text) ||
    SWR_EN.blockEndMarkers.some((m) => text.includes(m))
  );
}

const FULLSCREEN_BTN = '#jspsych-fullscreen-btn, .jspsych-fullscreen-btn';

/**
 * After the first jsPsych button, roar-swr may show fullscreen consent and/or
 * audio checks before the Lexicality tutorial. Exits once intro or trials are
 * visible (locale-agnostic; dev often serves de-DE even for en-US provision).
 */
function dismissSwrUntilLexicality(attempt = 0): void {
  const MAX = 120;
  if (attempt >= MAX) {
    cy.window({ log: false }).then((win) => {
      cy.get('body', { timeout: 30 * SWR_STEP_MS, log: false }).should(($b) => {
        const doc = $b[0].ownerDocument;
        expect(swrStartupComplete(doc, $b.text(), win), 'SWR intro or trials started').to.equal(
          true,
        );
      });
    });
    return;
  }

  cy.window({ log: false }).then((win) => {
    cy.get('body', { log: false }).then(($b) => {
      const doc = $b[0].ownerDocument;
      const text = $b.text();
      if (swrStartupComplete(doc, text, win)) return;

      if (bodyLooksLikeSwrBlockBreak(text) && !hasActiveStimulus(doc)) {
        cy.get('body', { log: false }).type('{leftarrow}', { log: false });
        clickSwrContinue();
      } else {
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
      }
      cy.wait(1000, { log: false });
      dismissSwrUntilLexicality(attempt + 1);
    });
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
  cy.window({ log: false }).then((win) => {
    cy.get('body', { log: false }).then(($b) => {
      const doc = $b[0].ownerDocument;
      if (isSwrPlayableScreen(doc) || hasActiveStimulus(doc) || readCorrectLrFromWindow(win)) {
        return;
      }
      if (!bodyHasSwrLexicalityIntro($b.text()) && !isSwrPlayableScreen(doc)) {
        dismissSwrUntilLexicality();
      }
      cy.window({ log: false }).then((w2) => {
        const d2 = w2.document;
        if (isSwrPlayableScreen(d2) || hasActiveStimulus(d2) || readCorrectLrFromWindow(w2)) {
          return;
        }
        for (let i = 0; i < 3; i++) {
          cy.get('body', { log: false }).type('{leftarrow}', { log: false });
        }
        cy.get(JSPSYCH_BTN, { timeout: 10 * SWR_STEP_MS }).should('be.visible').click({ force: true });
      });
    });
  });
}

/** Practice intro: alternate arrows then click Continue (mirrors `playIntro`). */
export function advanceSwrPracticeIntro(): void {
  cy.window({ log: false }).then((win) => {
    if (isSwrPlayableScreen(win.document) || hasActiveStimulus(win.document) || readCorrectLrFromWindow(win)) {
      return;
    }
    for (let i = 0; i <= 5; i++) {
      cy.wait(SWR_STEP_MS * 0.2, { log: false });
      cy.get('body', { log: false }).type('{leftarrow}{rightarrow}', { log: false });
      cy.wait(SWR_STEP_MS * 0.2, { log: false });
      cy.get('body', { log: false }).type('{leftarrow}{rightarrow}', { log: false });
      cy.wait(SWR_STEP_MS * 0.2, { log: false });
    }
    clickSwrContinue();
  });
}

/** Click Continue when the visible jspsych button label matches. */
export function clickSwrContinue(): void {
  cy.get('body', { log: false }).then(($b) => {
    const $btn = $b.find(`${JSPSYCH_BTN}:visible`);
    const $match = $btn.filter((_, el) => {
      const t = (el.textContent ?? '').trim();
      return (
        new RegExp(SWR_EN.continue, 'i').test(t) ||
        /^continue$|^continuar$|^weiter$/i.test(t)
      );
    });
    if ($match.length) cy.wrap($match.first()).click({ force: true });
    else if ($btn.length) cy.wrap($btn.first()).click({ force: true });
  });
}

/** Block transition with no `.stimulus`: left arrow + Continue (any locale). */
export function advanceSwrBreakScreen(): void {
  cy.get('body', { log: false }).type('{leftarrow}', { log: false });
  clickSwrContinue();
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
