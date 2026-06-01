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

export const EN_START_TEXT =
  'In this game we are going to look for words that BEGIN with the same sound';

/** Matches roar-dashboard `Cypress.env('timeout')` default (10s). */
export const PA_STEP_MS = 10_000;
export const PA_ASSET_WAIT_MS = PA_STEP_MS * 1.5;

/** English break / end markers from roar-dashboard `languageOptions.en`. */
export const PA_EN = {
  break1: 'Great job',
  breakRest: 'Take a break if needed',
  break2: 'Look at all those carrots',
  end2: 'I have been swimming so much',
  break3: 'You are doing great',
  end3: 'You have helped me and all my friends!',
  tutorials: ['map', 'rope', 'nut', 'wash', 'ball', 'rain'] as const,
} as const;

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

/** Standard PA intro: canvas → jspsych btn → continue → start text → continue. */
export function advancePaIntro(startText: string = EN_START_TEXT): void {
  waitForPaReady();
  cy.get(INTRO_CANVAS, { timeout: 60000 }).should('be.visible').click({ force: true });
  cy.get(JSPSYCH_BTN).should('be.visible').click({ force: true });
  cy.get(CONTINUE).should('be.visible').click({ force: true });
  cy.wait(500, { log: false });
  cy.contains(startText, { timeout: 120000 }).should('be.visible').click({ force: true });
  cy.get(CONTINUE).should('be.visible').click({ force: true });
}

/** Click through a fixed tutorial pair, then Continue (roar-dashboard playFirst/Second/ThirdTutorial). */
export function playPaTutorialPair(
  imgA: string,
  imgB: string,
  opts?: { continueFirst?: boolean },
): void {
  if (opts?.continueFirst) {
    cy.get(CONTINUE).click({ force: true });
    cy.wait(PA_STEP_MS * 2, { log: false });
  } else {
    cy.wait(PA_STEP_MS, { log: false });
  }
  cy.get(`img[src*="${imgA}.webp"]`, { timeout: 120000 }).click({ force: true });
  cy.wait(PA_STEP_MS * 2, { log: false });
  cy.get(`img[src*="${imgB}.webp"]`).click({ force: true });
  cy.wait(PA_STEP_MS, { log: false });
  cy.get(CONTINUE).click({ force: true });
}

export function clickPaContinue(): void {
  cy.get(CONTINUE).click({ force: true });
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
