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
  stimulus?: string;
  id?: string | number;
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

/** Dedicated store2 session key, so a nested blob cannot hide a later `null`. */
function readSessionKey(win: Window, name: string): unknown {
  try {
    const ss = win.sessionStorage;
    const parse = (raw: string): unknown => {
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    };
    const direct = ss.getItem(name);
    if (direct != null) return parse(direct);
    for (let i = 0; i < ss.length; i++) {
      const key = ss.key(i) ?? '';
      if (key.endsWith(`.${name}`)) {
        const raw = ss.getItem(key);
        if (raw != null) return parse(raw);
      }
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function stimulusWord(row: Record<string, unknown> | SwrStimulus | null | undefined): string {
  if (!row || typeof row !== 'object') return '';
  if (typeof (row as { stimulus?: unknown }).stimulus === 'string') {
    return (row as { stimulus: string }).stimulus;
  }
  if (typeof (row as { word?: unknown }).word === 'string') {
    return (row as { word: string }).word;
  }
  return '';
}

/** Walk store2 corpora for a row whose word matches the on-screen stimulus. */
function lrFromCorpora(store: Record<string, unknown>, word: string): CorrectLr | null {
  const want = word.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!want) return null;
  const rows: SwrStimulus[] = [];
  const walk = (value: unknown, depth = 0): void => {
    if (value == null || depth > 6) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (typeof value !== 'object') return;
    const o = value as Record<string, unknown>;
    const stim = stimulusWord(o);
    if (stim && typeof o.correct_response === 'string') rows.push(o as SwrStimulus);
    for (const child of Object.values(o)) {
      if (child && typeof child === 'object') walk(child, depth + 1);
    }
  };
  for (const key of [
    'nextStimulus',
    'corpusPractice',
    'corpusAll',
    'corpusNew',
    'corpusNewEasy',
    'corpusExperiment',
  ]) {
    walk(store[key]);
  }
  const hit = rows.find((row) => stimulusWord(row).replace(/\s+/g, ' ').trim().toLowerCase() === want);
  return hit ? lrFromArrow(hit.correct_response) : null;
}

/**
 * Read the correct arrow for the current SWR (Lexicality) trial (@bdelab/roar-swr 1.x):
 *  - scored trials: store2 session `nextStimulus.correct_response` ("ArrowLeft"/"ArrowRight")
 *  - else look up the visible `.stimulus` word in the loaded corpora (ATM often
 *    leaves `nextStimulus` null in sessionStorage while the letter-string is on screen)
 *  - practice trials: `corpusPractice[practiceIndex].correct_response`
 * Do not fall back to a bare `correctLR` — that key sticks on the last practice
 * item (often ArrowLeft) and will fail every real-word trial, blocking ATM stage 2.
 */
export function readCorrectLrFromWindow(win: Window): CorrectLr | null {
  try {
    const store = collectStore(win);
    const next = store.nextStimulus as SwrStimulus | null | undefined;
    if (next && typeof next === 'object') {
      const lr = lrFromArrow(next.correct_response);
      if (lr) return lr;
    }
    const fromDom = lrFromCorpora(store, readStimulusText(win.document));
    if (fromDom) return fromDom;
    if (isSwrPracticePhase(win)) {
      const practice = asArray(store.corpusPractice);
      if (practice) {
        const idx = asIndex(store.practiceIndex);
        if (practice[idx]) {
          const lr = lrFromArrow(practice[idx].correct_response);
          if (lr) return lr;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

export type SwrRuntimeMeta = {
  userMode: string | null;
  blockIndex: number | null;
  presentationTime: number | string | null;
  firstStageComplete: boolean | null;
  /** True while roar-swr is still in the practice corpus (IP), not scored items. */
  isPractice: boolean;
};

/** True when the current arrow trial is practice (IP), not a scored test item. */
export function isSwrPracticePhase(win: Window): boolean {
  try {
    const store = collectStore(win);
    const next = store.nextStimulus;
    // Scored trials always carry nextStimulus while the item is active.
    if (next && typeof next === 'object') return false;
    const practice = asArray(store.corpusPractice);
    if (!practice || practice.length === 0) return false;
    const idx = asIndex(store.practiceIndex);
    const config =
      store.config && typeof store.config === 'object'
        ? (store.config as Record<string, unknown>)
        : null;
    const totalPractice = Number(config?.totalTrialsPractice ?? practice.length);
    if (!Number.isFinite(totalPractice) || totalPractice <= 0) return false;
    return idx >= 0 && idx < totalPractice;
  } catch {
    return false;
  }
}

/** Read adaptiveTiming / userMode markers from roar-swr store2. */
export function readSwrRuntimeMeta(win: Window): SwrRuntimeMeta {
  try {
    const store = collectStore(win);
    const config =
      store.config && typeof store.config === 'object'
        ? (store.config as Record<string, unknown>)
        : null;
    const userMode =
      (typeof config?.userMode === 'string' && config.userMode) ||
      (typeof store.userMode === 'string' && store.userMode) ||
      null;
    const blockRaw = store.currentBlockIndex;
    const blockIndex =
      typeof blockRaw === 'number'
        ? blockRaw
        : typeof blockRaw === 'string' && Number.isFinite(Number(blockRaw))
          ? Number(blockRaw)
          : null;
    const ptDirect = readSessionKey(win, 'presentationTime');
    const pt = ptDirect !== undefined ? ptDirect : store.presentationTime;
    const presentationTime =
      typeof pt === 'number' || typeof pt === 'string' ? pt : pt === null ? 'infinite' : null;
    const fscDirect = readSessionKey(win, 'adaptiveTimingFirstStageComplete');
    const fsc = fscDirect !== undefined ? fscDirect : store.adaptiveTimingFirstStageComplete;
    const firstStageComplete = typeof fsc === 'boolean' ? fsc : null;
    return {
      userMode,
      blockIndex,
      presentationTime,
      firstStageComplete,
      isPractice: isSwrPracticePhase(win),
    };
  } catch {
    return {
      userMode: null,
      blockIndex: null,
      presentationTime: null,
      firstStageComplete: null,
      isPractice: false,
    };
  }
}

/** Stable id for the current item (dedupe answers on timed post-flash polls). */
export function readSwrTrialKey(win: Window): string | null {
  try {
    const store = collectStore(win);
    const trialNum = store.trialNumTotal ?? store.trialNumBlock ?? '';
    // Prefer live DOM text — sessionStorage nextStimulus/practiceIndex often lags.
    const dom = readStimulusText(win.document);
    if (dom) return `t${trialNum}|${dom}`;

    const next = store.nextStimulus as SwrStimulus | null | undefined;
    if (next && typeof next === 'object') {
      const stim = stimulusWord(next as Record<string, unknown>);
      const cr =
        typeof next.correct_response === 'string' ? next.correct_response : '';
      const id =
        typeof (next as { id?: unknown }).id === 'string' ||
        typeof (next as { id?: unknown }).id === 'number'
          ? String((next as { id: string | number }).id)
          : '';
      if (stim || cr || id) return `t${trialNum}|${id}|${stim}|${cr}`;
    }
    const practice = asArray(store.corpusPractice);
    if (practice) {
      const idx = asIndex(store.practiceIndex);
      const row = practice[idx] as Record<string, unknown> | undefined;
      if (row && typeof row === 'object') {
        const stim = stimulusWord(row);
        const cr = typeof row.correct_response === 'string' ? row.correct_response : '';
        if (stim || cr) return `p${idx}|${stim}|${cr}`;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Timed trials (350ms): only answer in the post-flash response window after we
 * observed `.stimulus`. Answering during the flash re-fires on stale store keys
 * and stalls the game. Untimed / infinite: answer while stimulus is visible.
 * Unknown presentationTime: also wait for post-flash (age-8 shortRandom is timed).
 */
export function isSwrAnswerableTrial(
  doc: Document,
  win: Window,
  bodyText: string,
  opts?: {
    seenTrialKey?: string | null;
    lastAnsweredKey?: string | null;
    presentationTime?: number | string | null;
  },
): boolean {
  const key = readSwrTrialKey(win);
  const seen = opts?.seenTrialKey ?? null;
  const answered = opts?.lastAnsweredKey ?? null;

  if (hasActiveStimulus(doc)) {
    const activeKey = key || seen;
    if (!activeKey || activeKey === answered) return false;
    if (!isSwrLexicalStimulus(readStimulusText(doc))) return false;
    return true;
  }
  // Post-flash: flash observed but not yet answered (oracle stashes LR while visible).
  if (seen && seen !== answered) return true;
  if (isSwrBreakScreen(doc, bodyText, win, opts)) return false;
  return false;
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
  /** Real mid/end-of-block copy only — not the timed-trial response prompt. */
  blockEndMarkers: [
    'You are halfway through the valley',
    'You are halfway through the first block',
    'You have completed the first block',
    'You are halfway through the second block',
    'You have completed the second block',
    'You are halfway through the third block',
    'Feel free to take a short break',
    'You have completed a new block',
    'Just one more valley',
    'With the guardian',
    'Du hast schon die Hälfte',
    'Du hast die Hälfte des Tals',
    'Du hast den ersten Block',
    'Du hast den zweiten Block',
    'Du hast diesen Block',
    'Gut gemacht',
    'Glückwunsch',
    'Mit der Hilfe des Wächters',
    'Estás en la mitad del valle',
    'Você está no meio do vale',
    'Você está na metade do vale',
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

/** Visible letter-string stimulus on an active SWR trial (normalized). */
export function readStimulusText(doc: Document): string {
  const el = doc.querySelector(STIMULUS);
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** True for a real/pseudo word, not the 3-2-1 / "+" countdown chrome. */
export function isSwrLexicalStimulus(text: string): boolean {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  // Countdown / fixation.
  if (t === '+' || /^[123]$/.test(t)) return false;
  if (/^\d+$/.test(t)) return false;
  return /[a-zà-ÿäöüß]/i.test(t);
}

/** `.stimulus` with a letter-string (not countdown). */
export function hasActiveLexicalStimulus(doc: Document): boolean {
  return isSwrLexicalStimulus(readStimulusText(doc));
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

/** True when SWR is on a block/transition break (arrows + Continue), not a trial. */
export function isSwrBreakScreen(
  doc: Document,
  bodyText: string,
  win?: Window,
  opts?: { seenTrialKey?: string | null; lastAnsweredKey?: string | null },
): boolean {
  if (hasActiveStimulus(doc)) return false;
  // Post-flash response window for an observed trial — not a break.
  // Only use `seen` (not a lagging store key) so intro/break screens are not blocked.
  if (opts) {
    const seen = opts.seenTrialKey ?? null;
    const answered = opts.lastAnsweredKey ?? null;
    if (seen && answered !== seen) return false;
  }
  // Prefer the live jsPsych content — full bodyText retains stale break banners.
  const text =
    (doc.querySelector('.jspsych-content, #jspsych-content, .jspsych-content-wrapper')
      ?.textContent ??
      bodyText) ||
    '';
  const hasBlockBanner =
    SWR_EN.blockEndMarkers.some((m) => text.includes(m)) ||
    /Vorgang abgeschlossen|halfway through|completed the (first|second|third) block/i.test(text);
  const view = win ?? doc.defaultView;
  const hasContinue = Array.from(doc.querySelectorAll('.jspsych-btn, button')).some((el) => {
    if (!/continue|weiter|continuar/i.test(el.textContent || '')) return false;
    const style = view?.getComputedStyle(el);
    if (!style) return (el as HTMLElement).offsetParent !== null;
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
  });
  const hasArrowContinue =
    /right arrow to continue|press the right arrow|linke Pfeiltaste|rechte Pfeiltaste/i.test(text);
  const hasAnyKey =
    /Press ANY KEY|beliebige Taste|EINE BELIEBIGE|presiona cualquier tecla|damit es weitergeht/i.test(
      text,
    );
  const hasValleyBreak =
    /halfway through the valley|Hälfte des Tals|mitad del valle|meio do vale|meta.*valle|Gut gemacht!|Good work!|Glückwunsch!|Congratulations!|camp near|zelten|Abenteurer|another adventurer|Wächters|guardian|durch das Tal|through the valley|dem Tor näher|closer to the gate/i.test(
      text,
    );
  // Timed post-flash may show a brief any-key prompt; real breaks have valley/block copy.
  return hasBlockBanner || hasContinue || hasArrowContinue || hasValleyBreak || (hasAnyKey && hasValleyBreak);
}

function bodyLooksLikeSwrBlockBreak(text: string): boolean {
  return (
    /Vorgang abgeschlossen|Press ANY KEY|beliebige Taste|presiona cualquier tecla|right arrow to continue|press the right arrow/i.test(
      text,
    ) || SWR_EN.blockEndMarkers.some((m) => text.includes(m))
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
    // Only skip when a real letter-string trial is already on screen — arrow chrome
    // / stale correctLR alone must not skip the Continue that starts practice.
    if (hasActiveStimulus(win.document)) return;
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
  // Scored accuracy is test items only — practice (IP) is timed separately.
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
