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

/** Matches roar-dashboard `Cypress.expose('timeout')` default (10s). */
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

/** CSS selector for the correct image choice on an AFC trial. The ` i` flag
 * makes the substring match case-insensitive: de-DE assets capitalize the noun
 * (`Kind.webp`) while the sessionStorage goal is lowercase (`kind`), so a
 * case-sensitive match would silently never fire. Used with native
 * `querySelector` (which supports the flag); for clicking go through
 * clickCorrectPaImage, which matches in JS to avoid any selector-engine gaps. */
export function correctImageSelector(goal: string): string {
  return `img[src*="${goal}.webp" i]`;
}

/**
 * Normalize an image src for matching against a goal stem. de-DE assets encode
 * accented nouns in URL-escaped Unicode *NFD* (`Ku%CC%88hlschrank.webp` = u +
 * combining diaeresis) while the sessionStorage goal is *NFC* (`kühlschrank`,
 * single `ü`). Decode the percent-escapes and normalize to NFC so the two forms
 * compare equal; also lowercased for the capitalized-noun case (`Kind` vs `kind`).
 */
function normalizePaSrc(value: string): string {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Malformed escape sequence — fall back to the raw value.
  }
  return decoded.normalize('NFC').toLowerCase();
}

function paGoalNeedle(goal: string): string {
  return `${goal}.webp`.normalize('NFC').toLowerCase();
}

/** True when the goal's image is among the on-screen choices (locale-robust:
 * case-, encoding-, and Unicode-normalization-insensitive). */
export function goalImagePresent(doc: Document, goal: string): boolean {
  const needle = paGoalNeedle(goal);
  return [...doc.querySelectorAll(CHOICE_IMG)].some((el) =>
    normalizePaSrc(el.getAttribute('src') ?? '').includes(needle),
  );
}

/** Click the choice image matching the goal (locale-robust src match). */
export function clickCorrectPaImage(goal: string): void {
  const needle = paGoalNeedle(goal);
  cy.get(CHOICE_IMG, { log: false }).then(($imgs) => {
    const target = [...$imgs].find((el) =>
      normalizePaSrc(el.getAttribute('src') ?? '').includes(needle),
    );
    expect(target, `PA goal image for goal=${goal}`).to.exist;
    cy.wrap(target).click({ force: true });
  });
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

/** Click any response image that is not the sessionStorage goal (locale-robust). */
export function clickWrongPaImage(goal: string): void {
  const needle = paGoalNeedle(goal);
  cy.get('img[src*=".webp"]', { log: false }).then(($imgs) => {
    const wrong = [...$imgs].find(
      (el) => !normalizePaSrc(el.getAttribute('src') ?? '').includes(needle),
    );
    expect(wrong, `wrong PA choice for goal=${goal}`).to.exist;
    cy.wrap(wrong).click({ force: true });
  });
}

export function isProgressComplete(doc: Document): boolean {
  const style = doc.querySelector(PROGRESS_INNER)?.getAttribute('style') ?? '';
  return style.includes('width: 100%');
}

// See sre.ts: the participant username (`…@levante.test`) is the
// language-agnostic dashboard-reroute signal; the localized sign-out label is a
// secondary cue. Either means the task finished and the app left the player.
const SIGN_OUT_RE = /Sign Out|Abmelden|Cerrar sesi[oó]n|D[ée]connexion|تسجيل الخروج|התנתק/i;
export function isDashboardReroute(bodyText: string): boolean {
  return /@levante\.test/i.test(bodyText) || SIGN_OUT_RE.test(bodyText);
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
    const visible = (sel: string): boolean => $b.find(sel).filter(':visible').length > 0;
    // Prefer an explicit advance control (fullscreen prompt → Continue / jsPsych
    // button) over the instruction canvas: instruction screens render a clickable
    // Continue *and* a decorative, animating canvas, and only the bare "click the
    // screen" intro has a canvas with no button. Clicking the animating canvas
    // when a button exists both mis-targets and detaches mid-render.
    let target: string | null = null;
    if (visible(FULLSCREEN_BTN)) target = FULLSCREEN_BTN;
    else if (visible(ADVANCE_BTN)) target = ADVANCE_BTN;
    else if (visible(INTRO_CANVAS)) target = INTRO_CANVAS;
    if (!target) return;

    // Click via a FRESH `cy.get` (never a captured node): these screens animate /
    // auto-advance, so a node captured in this `.then` can detach before the click
    // ("element has detached from the DOM"). Re-querying re-resolves the current
    // node. Re-check existence first so a screen that advanced on its own no-ops
    // instead of hard-failing the 4s default `cy.get` retry.
    const sel = target;
    cy.get('body', { log: false }).then(($b2) => {
      if ($b2.find(sel).filter(':visible').length === 0) return;
      cy.get(sel, { log: false }).filter(':visible').first().click({ force: true });
    });
  });
}

/**
 * Tutorial / guided-demo escape: click each visible answer image in turn, then
 * Continue. roar-pa's tutorials highlight the demonstrated image(s) and gate on a
 * click; clicking all of them (the correct one included) advances the demo
 * regardless of language, mirroring the old scripted two-image tutorial without
 * needing the hardcoded English image stems.
 *
 * Each click is preceded by a FRESH query (never a captured element) because the
 * first click re-renders the demo and detaches the other image nodes — clicking a
 * stale reference throws "element has detached from the DOM". The loop stops once
 * the images are gone (screen advanced) and is bounded so it can't spin forever.
 */
export function clickAllPaChoices(maxClicks = 6): void {
  const clickNext = (i: number): void => {
    if (i >= maxClicks) return;
    cy.get('body', { log: false }).then(($b) => {
      const count = $b.find(CHOICE_IMG).filter(':visible').length;
      // Stop once images are gone (screen advanced) or every distinct image on
      // the current screen has been clicked once.
      if (count === 0 || i >= count) return;
      // Fresh `cy.get` (not a captured node): the first click re-renders the demo
      // and detaches the other image nodes.
      cy.get(CHOICE_IMG, { log: false }).filter(':visible').eq(i).click({ force: true });
      cy.wait(400, { log: false });
      clickNext(i + 1);
    });
  };
  clickNext(0);
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
