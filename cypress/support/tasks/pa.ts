/**
 * PA (ROAR Phonological Awareness / @bdelab/roar-pa) — dashboard-only task.
 *
 * Answer key: roar-pa stores `currentStimulus` in sessionStorage; `.goal` is the
 * correct image stem (e.g. `rope` → click `img[src*="rope.webp"]`). Verified in
 * roar-dashboard `cypress/support/helper-functions/roar-pa/paHelpers.js`.
 */

import type { PaSummaryStats, PaTrialRecord } from './types';

export const PA_ROUTE = '/game/pa';

export const INTRO_CANVAS = '.instructionCanvasNS';
export const JSPSYCH_BTN = '.jspsych-btn';
export const CONTINUE = '.continue';
export const AUDIO_CHOICE = '.jspsych-audio-button-response-button';
export const PROGRESS_INNER = '#jspsych-progressbar-inner';
export const FULLSCREEN_BTN = '#jspsych-fullscreen-btn, .jspsych-fullscreen-btn';
// Answer-choice images on an AFC trial (also rendered on tutorial demo screens).
export const CHOICE_IMG = 'img[src*=".webp"]';
// Any button that advances a non-trial screen (intro / tutorial / break / end).
export const ADVANCE_BTN = `${CONTINUE}, ${JSPSYCH_BTN}`;

/** Matches roar-dashboard `Cypress.env('timeout')` default (10s). */
export const PA_STEP_MS = 10_000;
export const PA_ASSET_WAIT_MS = PA_STEP_MS * 1.5;

export interface PaStimulus {
  goal?: string;
  [key: string]: unknown;
}

/** Parse roar-pa's sessionStorage answer key (returns null if missing/invalid). */
export function readGoalFromWindow(win: Window): string | null {
  try {
    const raw = win.sessionStorage.getItem('currentStimulus');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PaStimulus;
    const goal = parsed?.goal;
    return typeof goal === 'string' && goal.length > 0 ? goal : null;
  } catch {
    return null;
  }
}

/** CSS selector for the correct image choice on an AFC trial. */
export function correctImageSelector(goal: string): string {
  return `img[src*="${goal}.webp"]`;
}

/**
 * Raw `currentStimulus` string — a stable identity for the on-screen trial.
 * The structural loop uses it to tell "I already answered this trial, the screen
 * just hasn't advanced yet" (same signature) from "a new trial loaded" (changed
 * signature), so it never double-clicks during the inter-trial render window.
 */
export function readStimulusSignature(win: Window): string | null {
  try {
    return win.sessionStorage.getItem('currentStimulus');
  } catch {
    return null;
  }
}

/** Click any response image that is not the sessionStorage goal. */
export function clickWrongPaImage(goal: string): void {
  cy.get('img[src*=".webp"]', { log: false }).then(($imgs) => {
    const wrong = [...$imgs].find((el) => !(el.getAttribute('src') ?? '').includes(`${goal}.webp`));
    expect(wrong, `wrong PA choice for goal=${goal}`).to.exist;
    cy.wrap(wrong).click({ force: true });
  });
}

export function isProgressComplete(doc: Document): boolean {
  const style = doc.querySelector(PROGRESS_INNER)?.getAttribute('style') ?? '';
  return style.includes('width: 100%');
}

export function isDashboardReroute(bodyText: string): boolean {
  return bodyText.includes('Sign Out');
}

/** Wait until jsPsych intro chrome is present (mirrors dashboard waitForAssessmentReadyState). */
export function waitForPaReady(): void {
  cy.get(`${JSPSYCH_BTN}, ${INTRO_CANVAS}`, { timeout: 120000 }).should('exist');
}

/**
 * Click the Continue button once it becomes visible. Polls up to `maxMs` (the
 * intro/break screens render the button a beat after the prior click), but
 * no-ops if it never appears so a finished game can't hard-fail here.
 *
 * The deadline is set inside a `.then()` so it starts at EXECUTION time — not
 * when the command queue is built — otherwise slow startup (waitForPaReady can
 * take up to 120s) burns the whole budget before this even runs, and it would
 * poll zero times and silently skip the click.
 */
function clickVisibleContinue(maxMs = 30_000): void {
  cy.wrap(null, { log: false }).then(() => {
    const deadline = Date.now() + maxMs;
    const attempt = (): void => {
      cy.get('body', { log: false }).then(($b) => {
        const $continue = $b.find(CONTINUE).filter(':visible');
        if ($continue.length) {
          cy.wrap($continue.first()).click({ force: true });
          return;
        }
        if (Date.now() >= deadline) return;
        cy.wait(500, { log: false });
        attempt();
      });
    };
    attempt();
  });
}

/**
 * True once roar-pa has finished: the jsPsych progress bar is full or the app
 * has rerouted back to the dashboard. Used to bail out of scripted tutorial
 * steps that may not exist on every build (some admins have no 3rd tutorial).
 */
export function isPaFinished(win: Window): boolean {
  return isProgressComplete(win.document) || isDashboardReroute(win.document.body.innerText ?? '');
}

/** Answer-choice images present (real AFC trial *or* a tutorial demo screen). */
export function hasPaChoices(doc: Document): boolean {
  return doc.querySelectorAll(CHOICE_IMG).length > 0;
}

/**
 * Advance one non-trial screen (intro / instructions / break / end / feedback)
 * without depending on any localized text. Clicks the first affordance present,
 * in the order roar-pa renders them: fullscreen prompt → instruction canvas →
 * Continue / jsPsych button. No-ops when nothing is clickable (loading frames),
 * so the caller's poll just tries again on the next pass.
 */
export function advancePaScreen(): void {
  cy.get('body', { log: false }).then(($b) => {
    const $fs = $b.find(FULLSCREEN_BTN).filter(':visible');
    if ($fs.length) {
      cy.wrap($fs.first()).click({ force: true });
      return;
    }
    const $canvas = $b.find(INTRO_CANVAS).filter(':visible');
    if ($canvas.length) {
      cy.wrap($canvas.first()).click({ force: true });
      return;
    }
    const $btn = $b.find(ADVANCE_BTN).filter(':visible');
    if ($btn.length) cy.wrap($btn.first()).click({ force: true });
  });
}

/**
 * Tutorial / guided-demo escape: click every visible answer image, then the
 * Continue button. roar-pa's tutorials highlight the demonstrated image(s) and
 * gate on a click; clicking all of them (the correct one included) advances the
 * demo regardless of language, mirroring the old scripted two-image tutorial
 * without needing the hardcoded English image stems.
 */
export function clickAllPaChoices(): void {
  cy.get('body', { log: false }).then(($b) => {
    const $imgs = $b.find(CHOICE_IMG).filter(':visible');
    $imgs.each((_i, el) => {
      cy.wrap(el).click({ force: true });
    });
  });
}

export function clickPaContinue(): void {
  clickVisibleContinue();
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Aggregate one run: accuracy over scored `item` rows. */
export function scoreTrials(trials: PaTrialRecord[]): PaSummaryStats {
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
