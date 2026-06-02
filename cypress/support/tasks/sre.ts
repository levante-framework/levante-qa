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

interface SreCorpusItem {
  direction?: string;
  correct_response?: string;
}

function parseStore2Scalar(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const stripped = raw.replace(/^"|"$/g, '').trim();
    try {
      return JSON.parse(stripped);
    } catch {
      return stripped;
    }
  }
}

function lrFromDirection(value: unknown): CorrectLr | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v === 'left' || v === 'right') return v;
  if (v === 'arrowleft') return 'left';
  if (v === 'arrowright') return 'right';
  return null;
}

/**
 * Flatten store2's persisted state into one lookup. roar-sre / roar-swr use
 * store2's session area (`store.session.set(key, val)`), but the actual
 * sessionStorage layout varies: individual keys, namespaced keys
 * (`<ns>.currentCorpus`), or a single namespace object whose value holds all
 * keys. Scan session + local storage and merge every layout into one map so
 * field lookups (`currentCorpus`, `practiceCorpus`, `nextStimulus`, ...) work
 * regardless of how store2 is configured on a given build.
 */
export function collectStore(win: Window): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (k: string, v: unknown): void => {
    if (!(k in out)) out[k] = v;
  };
  for (const storage of [win.sessionStorage, win.localStorage]) {
    try {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i) ?? '';
        const raw = storage.getItem(key);
        if (raw == null) continue;
        const val = parseStore2Scalar(raw);
        put(key, val);
        const short = key.split('.').pop() || key;
        put(short, val);
        // Namespace-as-object: a single key whose value holds the real keys.
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          for (const [k, v] of Object.entries(val as Record<string, unknown>)) put(k, v);
        }
      }
    } catch {
      // storage may be inaccessible; ignore
    }
  }
  return out;
}

function asArray(value: unknown): SreCorpusItem[] | null {
  return Array.isArray(value) ? (value as SreCorpusItem[]) : null;
}

function asIndex(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * Read the correct arrow for the current SRE trial (see @bdelab/roar-sre 1.15.x):
 *  - scored trials: `currentCorpus[indexTracking].direction` ("left"/"right")
 *  - practice trials: `practiceCorpus[indexTracking].correct_response`
 *    ("arrowleft"/"arrowright"); `currentCorpus` is empty during practice
 *  - fallback: store2 `correctLR` (set during practice feedback)
 */
export function readCorrectLrFromWindow(win: Window): CorrectLr | null {
  try {
    const store = collectStore(win);
    const index = asIndex(store.indexTracking);
    const current = asArray(store.currentCorpus);
    const practice = asArray(store.practiceCorpus);

    if (current && current[index]) {
      const lr = lrFromDirection(current[index].direction ?? current[index].correct_response);
      if (lr) return lr;
    }
    if (practice && practice[index]) {
      const lr = lrFromDirection(
        practice[index].correct_response ?? practice[index].direction,
      );
      if (lr) return lr;
    }
    return lrFromDirection(store.correctLR);
  } catch {
    return null;
  }
}

/** Diagnostic: storage key names + short value previews (for no-key logging). */
export function dumpStoreKeys(win: Window): Array<{ key: string; preview: string }> {
  const out: Array<{ key: string; preview: string }> = [];
  for (const [name, storage] of [
    ['session', win.sessionStorage],
    ['local', win.localStorage],
  ] as const) {
    try {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i) ?? '';
        const raw = storage.getItem(key) ?? '';
        out.push({ key: `${name}:${key}`, preview: raw.slice(0, 120) });
      }
    } catch {
      // ignore
    }
  }
  return out;
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

const FULLSCREEN_BTN = '#jspsych-fullscreen-btn, .jspsych-fullscreen-btn';

function bodyHasSreWelcome(text: string): boolean {
  const norm = text.replace(/\s+/g, ' ');
  return (
    text.includes(SRE_EN.welcome) ||
    text.includes('Sentence Reading Efficiency') ||
    text.includes('Satzleseeffizienz') ||
    text.includes('eficiencia de lectura') ||
    /Sentence Reading/i.test(norm)
  );
}

/** End-of-task thank-you screen (en / de / es). */
export function bodyHasSreCompletion(text: string): boolean {
  return (
    text.includes(SRE_EN.endThankYou) ||
    /thank you so much/i.test(text) ||
    /vielen dank/i.test(text) ||
    /muchas gracias/i.test(text)
  );
}

function progressStarted(doc: Document): boolean {
  const style = doc.querySelector(PROGRESS_INNER)?.getAttribute('style') ?? '';
  return /width:\s*([1-9]|[1-9]\d)/.test(style);
}

function sreStartupComplete(doc: Document, bodyText: string, win: Window): boolean {
  return (
    bodyHasSreWelcome(bodyText) ||
    hasActiveStimulus(doc) ||
    progressStarted(doc) ||
    !!readCorrectLrFromWindow(win)
  );
}

function dismissSreUntilWelcome(attempt = 0): void {
  const MAX = 90;
  if (attempt >= MAX) {
    cy.window({ log: false }).then((win) => {
      cy.get('body', { timeout: 30 * SRE_STEP_MS, log: false }).should(($b) => {
        const doc = $b[0].ownerDocument;
        expect(sreStartupComplete(doc, $b.text(), win), 'SRE welcome or active trials').to.equal(
          true,
        );
      });
    });
    return;
  }
  cy.window({ log: false }).then((win) => {
    cy.get('body', { log: false }).then(($b) => {
      const doc = $b[0].ownerDocument;
      if (sreStartupComplete(doc, $b.text(), win)) return;
      const $fs = $b.find(FULLSCREEN_BTN).filter(':visible');
      if ($fs.length) cy.wrap($fs.first()).click({ force: true });
      else {
        const $btn = $b.find(`${JSPSYCH_BTN}:visible`);
        if ($btn.length) cy.wrap($btn.first()).click({ force: true });
        else if (attempt % 5 === 0) {
          cy.get('body', { log: false }).type('{enter}', { log: false });
        }
      }
      cy.wait(1000, { log: false });
      dismissSreUntilWelcome(attempt + 1);
    });
  });
}

/**
 * Startup after dashboard launch: first jspsych button + fullscreen / audio chrome
 * (roar-dashboard `playSRE` enter + 1), then welcome text or first trial.
 */
export function advanceSreStartup(): void {
  waitForSreReady();
  cy.get(JSPSYCH_BTN).should('be.visible').click({ force: true });
  cy.wait(200, { log: false });
  cy.get('body', { log: false }).type('{enter}', { log: false });
  cy.wait(200, { log: false });
  cy.get('body', { log: false }).type('1', { log: false });
  cy.wait(200, { log: false });
  dismissSreUntilWelcome();
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
