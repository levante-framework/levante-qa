import type { SdsSummaryStats, SdsTrialRecord } from './types';

/**
 * Same-Different Selection (SDS) task model: selectors, screen-state detection,
 * the single-select answer-key reader, the multi-select match heuristic, and
 * post-hoc scoring. Verified against the live demo DOM (2026-05-30 mapping run)
 * and core-tasks `src/tasks/same-different-selection/`.
 *
 * SDS does NOT use the shared `afcStimulus` trial; it has custom trials, and the
 * run is two very different kinds of item:
 *
 *   1. SINGLE-SELECT (31 items): one card is correct — "Choose the card with a
 *      circle", "Which of these is similar to this one?". Rendered in
 *      `#jspsych-html-multi-response-btngroup` as `button.image-medium`. Under
 *      Cypress core-tasks adds a `.correct` class to the correct BUTTON (note:
 *      the button, not the inner <img>, unlike vocab/ToM). Auto-advances on
 *      click — no OK. This is cleanly scoreable against the key (oracle + VLM).
 *
 *   2. MULTI-SELECT match (90 items): "Choose two cards that are the same in
 *      some way", repeated with 3/4/5 cards. Rendered in
 *      `#jspsych-audio-multi-response-btngroup`. There is **no answer key** in
 *      the DOM — many pairs are valid, and the task scores a pair *relationally*
 *      (it must share a dimension not already matched in this card set). So
 *      there is nothing to recompute the answer against; instead we port
 *      core-tasks' own proven e2e solver (a dimension-overlap heuristic with
 *      per-set state) to drive the rounds, and treat reaching the completion
 *      screen as the regression signal (the app accepted every pair at runtime).
 *
 * Card `alt` encodes the dimensions: `{size}-{color}-{shape}[-{number}][-{bg}]`,
 * e.g. `med-blue-circle`, `med-blue-circle-4-gray`.
 */

export const URL_BASE = 'https://levante-tasks-demo.web.app/';

// cat=false pins the fixed-order timeline; maxIncorrect is raised so a stray
// miss never triggers the early-abort and truncates the run.
export const DEFAULT_PARAMS = {
  task: 'same-different-selection',
  cat: 'false',
  maxIncorrect: 999,
} as const;

// Selectors verified against the live demo (2026-05-30). Defined only here.
// TODO(selectors): Re-verify against the live demo DOM if markup changes.

export const JSPSYCH_CONTENT = '.jspsych-content';
// Instruction / display / task-finished continue button ("OK"/"Exit").
export const CONTINUE_BUTTON = 'button.primary';
// Single-select response group + its cards (one card is keyed `.correct`).
export const SINGLE_GROUP = '#jspsych-html-multi-response-btngroup';
export const SINGLE_CHOICE = `${SINGLE_GROUP} button.image-medium`;
export const SINGLE_CHOICE_IMG = `${SINGLE_CHOICE} img`;
// Multi-select (match) response group + its cards (NO answer key).
export const MULTI_GROUP = '#jspsych-audio-multi-response-btngroup';
export const MULTI_CHOICE = `${MULTI_GROUP} button.image-medium`;
export const MULTI_CHOICE_IMG = `${MULTI_CHOICE} img`;
// Class toggled on a card while it is part of the current selection.
export const SELECTED_CLASS = 'info-shadow';
// On-screen prompt / question text (single trials and match-round prompt).
export const PROMPT_TEXT =
  '#afc-match-prompt, .lev-stimulus-container .lev-row-container.instruction p, .lev-stimulus-container .instruction p';
export const STIMULUS_CONTAINER = '.lev-stimulus-container';
export const REPLAY_BUTTON = '#replay-btn-revisited';
export const EXIT_BUTTON = '#exit-button';
// The marker core-tasks adds (under Cypress) to the correct single-select BUTTON.
const CORRECT_MARKER = '.correct';

export interface TaskWindow extends Window {
  jsPsych?: unknown;
}

/** Build the full task URL from the base and parameters. */
export function buildUrl(
  base: string = URL_BASE,
  params: Record<string, string | number> = DEFAULT_PARAMS,
): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function isInteractable(el: Element | null): boolean {
  if (!el) return false;
  const htmlEl = el as HTMLElement;
  if ((htmlEl as HTMLButtonElement).disabled) return false;
  const style = el.ownerDocument?.defaultView?.getComputedStyle(htmlEl);
  if (
    style &&
    (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none')
  ) {
    return false;
  }
  const rect = htmlEl.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/** True when the timeline has ended (content emptied, or a finished/Exit screen
 * is showing). */
export function isComplete(win: TaskWindow): boolean {
  const doc = win.document;
  const content = doc.querySelector(JSPSYCH_CONTENT);
  if (!content || content.children.length === 0) return true;
  if (doc.querySelector(EXIT_BUTTON)) return true;
  // taskFinished renders a footer + an Exit primary button.
  const stim = doc.querySelector(STIMULUS_CONTAINER);
  if (stim && stim.querySelector('footer')) return true;
  return Array.from(doc.querySelectorAll('button')).some((b) =>
    /^\s*exit\s*$/i.test(b.textContent ?? ''),
  );
}

/** A single-select trial is up when the app has keyed a correct card. */
export function isSingleSelectReady(win: TaskWindow): boolean {
  return win.document.querySelectorAll(`${SINGLE_CHOICE}.correct, ${SINGLE_CHOICE} img.correct`).length > 0
    || (win.document.querySelectorAll(SINGLE_CHOICE).length >= 2 &&
        win.document.querySelectorAll(CORRECT_MARKER).length > 0);
}

/** A multi-select match round is up when ≥3 match cards are present and no
 * single-select key is showing. */
export function isMultiSelectReady(win: TaskWindow): boolean {
  if (win.document.querySelectorAll(CORRECT_MARKER).length > 0) return false;
  return win.document.querySelectorAll(MULTI_CHOICE).length >= 3;
}

/** True on a display / instruction / finished screen: an enabled `.primary`
 * (OK/Exit) and no selectable cards. */
export function isInstructionScreen(win: TaskWindow): boolean {
  const doc = win.document;
  if (doc.querySelectorAll(SINGLE_CHOICE).length >= 2) return false;
  if (doc.querySelectorAll(MULTI_CHOICE).length >= 3) return false;
  const primary = doc.querySelector(CONTINUE_BUTTON);
  return !!primary && isInteractable(primary);
}

/** The single-select cards' `alt`, in DOM order (index === choice index). */
export function readSingleChoices(win: TaskWindow): string[] {
  return Array.from(win.document.querySelectorAll(SINGLE_CHOICE_IMG)).map((img) =>
    (img.getAttribute('alt') ?? '').trim(),
  );
}

/** The multi-select match cards' `alt`, in DOM order. */
export function readMatchChoices(win: TaskWindow): string[] {
  return Array.from(win.document.querySelectorAll(MULTI_CHOICE_IMG)).map((img) =>
    (img.getAttribute('alt') ?? '').trim(),
  );
}

/** The on-screen prompt / question text for the current screen, or '' if none. */
export function readPromptText(win: TaskWindow): string {
  const el = win.document.querySelector(PROMPT_TEXT);
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Index of the single-select choice the task marks correct, or -1. core-tasks
 * adds `.correct` to the correct BUTTON (occasionally a child carries it), so we
 * match either. This is the only DOM answer key SDS exposes (single-select
 * only); it drives the oracle and scores the VLM on those items.
 */
export function appKeyedCorrectIndex(win: TaskWindow): number {
  const buttons = Array.from(win.document.querySelectorAll(SINGLE_CHOICE));
  return buttons.findIndex((b) => b.matches(CORRECT_MARKER) || !!b.querySelector(CORRECT_MARKER));
}

// --- Multi-select match heuristic ------------------------------------------
// Ported verbatim (with explicit state) from core-tasks' own passing e2e
// (cypress/e2e/same_different.cy.js). The match trials expose no answer key, so
// this reproduces the app's relational rule well enough to always pick a valid
// pair: two cards sharing a dimension not yet matched in the current card set.

/** Dimensions shared by both lists. */
export function checkOverlap(a: string[], b: string[]): string[] {
  return a.filter((x) => b.includes(x));
}

/**
 * Normalize a card's hyphen-split `alt` into the dimension tokens the matcher
 * compares, mirroring core-tasks `cleanDimensions`: for 4/5-card phases the
 * size token is ignored, a default number (`1`) is implied when none is shown,
 * and a default white background is implied when none of gray/black/striped is.
 */
export function cleanDimensions(dims: string[], phaseCount: number): string[] {
  const d = [...dims];
  if (phaseCount > 3) d.shift(); // ignore size dimension
  if (d.every((e) => isNaN(Number(e))) && phaseCount > 3) d.push('1');
  const nonWhiteBackgrounds = ['gray', 'black', 'striped'];
  if (checkOverlap(d, nonWhiteBackgrounds).length === 0 && phaseCount > 3) d.push('white');
  return d;
}

/** Mutable per-card-set state for the match heuristic. */
export interface MatchState {
  matchedDimensions: string[];
  numSelections: number;
  phaseCount: number;
}

export function newMatchState(): MatchState {
  return { matchedDimensions: [], numSelections: 0, phaseCount: 3 };
}

/** A chosen pair of card indices and the dimension they were matched on. */
export interface MatchPair {
  a: number;
  b: number;
  dim: string;
}

/**
 * Pick the next valid pair for a match round given the card `alts` and the
 * running per-set state, resetting the state when a new card set begins (the
 * same reset rule core-tasks uses). Returns the pair plus the (possibly reset)
 * state, or pair=null if no unused-dimension pair is found (caller falls back to
 * the first two cards just to advance).
 */
export function nextMatchPair(
  alts: string[],
  state: MatchState,
): { pair: MatchPair | null; state: MatchState } {
  const nCards = alts.length;
  let { matchedDimensions, numSelections, phaseCount } = state;
  if (numSelections >= nCards - 1 || phaseCount < nCards) {
    matchedDimensions = [];
    numSelections = 0;
    phaseCount = nCards;
  }

  let pair: MatchPair | null = null;
  for (let a = 0; a < nCards && !pair; a++) {
    const fa = cleanDimensions(alts[a].split('-'), phaseCount);
    for (let b = 0; b < nCards; b++) {
      if (b === a) continue;
      const fb = cleanDimensions(alts[b].split('-'), phaseCount);
      const valid = checkOverlap(fb, fa).filter((dim) => !matchedDimensions.includes(dim));
      if (valid.length > 0) {
        pair = { a, b, dim: valid[0] };
        break;
      }
    }
  }

  if (pair) {
    matchedDimensions = [...matchedDimensions, pair.dim];
    numSelections += 1;
  }
  return { pair, state: { matchedDimensions, numSelections, phaseCount } };
}

// --- Scoring ---------------------------------------------------------------

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Aggregate one run: single-select accuracy (the only scoreable items), counts
 * of single vs match items, mean RT over single items, timeout rate, and how
 * many rows carried narration.
 */
export function scoreTrials(trials: SdsTrialRecord[]): SdsSummaryStats {
  const single = trials.filter((t) => t.itemType === 'single');
  const match = trials.filter((t) => t.itemType === 'match');
  const scored = single.filter((t) => typeof t.correct === 'boolean');
  const hits = scored.filter((t) => t.correct === true).length;
  const rts = single.map((t) => t.rtMs).filter((v): v is number => typeof v === 'number');
  const timedOut = single.filter((t) => t.timedOut === true).length;
  const withAudio = trials.filter((t) => t.audioTranscript).length;

  return {
    nSingle: single.length,
    nMatch: match.length,
    accuracySingle: scored.length > 0 ? hits / scored.length : null,
    rtMean: mean(rts),
    timeoutRate: single.length > 0 ? timedOut / single.length : 0,
    nWithAudio: withAudio,
  };
}
