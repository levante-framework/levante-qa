import { applyQaTaskParams, resolveDemoBase } from '../demoUrl';
import { EXIT_LABEL, START_CONTINUE_LABEL } from './labels';
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
 *   1. SINGLE-SELECT (~49 items in the version-2 `-spark` bank): one card is
 *      correct — "Choose the card with a
 *      circle", "Which of these is similar to this one?". Rendered in
 *      `#jspsych-html-multi-response-btngroup` as `button.image-medium`. Under
 *      Cypress core-tasks adds a `.correct` class to the correct BUTTON (note:
 *      the button, not the inner <img>, unlike vocab/ToM). Auto-advances on
 *      click — no OK. This is cleanly scoreable against the key (oracle + VLM).
 *
 *   2. MULTI-SELECT match (~94 items): "Choose two cards that are the same in
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
//
// version + corpus must match the live variants. Omitting them makes core-tasks
// fall back to version 1 and the `same-different-selection-item-bank` corpus,
// whose prompt keys are discontinued outside es-CO/de-DE and so are absent from
// the published translation JSON — the task then renders prompts as the literal
// string "undefined" (core-tasks#506). The version-2 `-spark` bank is what
// participants actually run.
export const DEFAULT_PARAMS = {
  task: 'same-different-selection',
  version: 2,
  corpus: 'same-different-selection-item-bank-spark',
  cat: 'false',
  maxIncorrect: 999,
} as const;

// Selectors verified against the live demo (2026-05-30). Defined only here.
// TODO(selectors): Re-verify against the live demo DOM if markup changes.

export const JSPSYCH_CONTENT = '.jspsych-content';
// Instruction / display / task-finished continue button ("OK"/"Exit").
export const CONTINUE_BUTTON = 'button.primary';
/** OK on instruction / something-same screens — not the match-round confirm below the card row. */
export const INSTRUCTION_OK_BUTTON = [
  '#jspsych-html-multi-response-btngroup button.primary',
  '#jspsych-audio-multi-response-btngroup button.primary',
  '#ok-button-container button.primary',
  '.lev-stimulus-container-wide button.primary',
  '.lev-stimulus-container button.primary',
].join(', ');
// Single-select response group + its cards (one card is keyed `.correct`).
export const SINGLE_GROUP = '#jspsych-html-multi-response-btngroup';
export const SINGLE_CHOICE = `${SINGLE_GROUP} button.image-medium`;
export const SINGLE_CHOICE_IMG = `${SINGLE_CHOICE} img`;
// Multi-select (match) response group + its cards (NO answer key).
export const MULTI_GROUP = '#jspsych-audio-multi-response-btngroup';
export const MULTI_CHOICE = `${MULTI_GROUP} button.image-medium`;
export const MULTI_CHOICE_IMG = `${MULTI_CHOICE} img`;
// taskVersion 2: after selecting required cards, participant must confirm via OK
// (inserted after the multi-response button group in afcMatch.ts on_load).
export const MATCH_CONFIRM_BUTTON = `${MULTI_GROUP} ~ button.primary`;
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
  const url = new URL(resolveDemoBase(base));
  for (const [key, value] of Object.entries(applyQaTaskParams(params))) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function isInteractable(el: Element | null): boolean {
  if (!el) return false;
  const htmlEl = el as HTMLElement;
  if ((htmlEl as unknown as HTMLButtonElement).disabled) return false;
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
    EXIT_LABEL.test(b.textContent ?? ''),
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

/** True when the match-round OK confirm button is present and clickable (taskVersion 2). */
export function isMatchConfirmReady(win: TaskWindow): boolean {
  if (!isMultiSelectReady(win)) return false;
  const btn = win.document.querySelector(MATCH_CONFIRM_BUTTON) as HTMLButtonElement | null;
  return !!btn && isInteractable(btn) && !btn.disabled;
}

function findEnabledStartButton(doc: Document): HTMLElement | null {
  const fullscreen = doc.querySelector(
    '#jspsych-fullscreen-btn, .jspsych-fullscreen-btn',
  ) as HTMLElement | null;
  if (fullscreen && isInteractable(fullscreen) && !(fullscreen as unknown as HTMLButtonElement).disabled) {
    return fullscreen;
  }
  for (const el of doc.querySelectorAll('button.primary, button.jspsych-btn')) {
    const btn = el as HTMLButtonElement;
    const label = (btn.textContent ?? '').trim();
    if (!START_CONTINUE_LABEL.test(label)) continue;
    if (isInteractable(btn) && !btn.disabled) return btn;
  }
  return null;
}

/**
 * Instruction / demo chrome (OK may be disabled until narration ends).
 * Includes heavy-instruction screens (`lev-stimulus-container`) and something-same.
 */
export function hasSdsInstructionChrome(win: TaskWindow): boolean {
  const doc = win.document;
  if (isSingleSelectReady(win) || isMultiSelectReady(win)) return false;
  if (isSomethingSameScreen(win)) return true;
  if (doc.querySelectorAll(MULTI_CHOICE).length >= 3) return false;
  if (doc.querySelectorAll(SINGLE_CHOICE).length >= 2) return false;
  return (
    doc.querySelectorAll(INSTRUCTION_OK_BUTTON).length > 0 ||
    !!doc.querySelector(
      '.lev-stimulus-container .instruction, .lev-stimulus-container-wide .instruction',
    )
  );
}

/** True once the task is past preload/fullscreen and showing a real SDS screen. */
export function isSdsTaskReady(win: TaskWindow): boolean {
  if (isComplete(win)) return false;
  return isSingleSelectReady(win) || isMultiSelectReady(win) || hasSdsInstructionChrome(win);
}

function clickSdsStartupChrome(win: TaskWindow): void {
  const btn = findEnabledStartButton(win.document);
  if (btn) {
    cy.wrap(btn).click({ force: true });
    return;
  }
  const doc = win.document;
  const okButtons = doc.querySelectorAll(INSTRUCTION_OK_BUTTON);
  if (okButtons.length) {
    cy.wrap(okButtons[okButtons.length - 1]).click({ force: true });
    return;
  }
  cy.get('body', { log: false }).type('{enter}', { log: false });
}

/**
 * Advance through asset preload, fullscreen, and intro screens. SDS on the
 * dashboard can sit on loading or use Continue/Next before the first trial.
 */
export function dismissSdsStartup(attempt = 0): void {
  const MAX = 200;
  if (attempt >= MAX) return;

  if (attempt === 0) {
    cy.get('.jspsych-content-wrapper, .jspsych-content', { timeout: 300000 }).should('exist');
  }

  cy.window({ log: false }).then((w) => {
    const win = w as unknown as TaskWindow;
    if (isSdsTaskReady(win)) return;

    clickSdsStartupChrome(win);
    cy.wait(1200, { log: false });
    dismissSdsStartup(attempt + 1);
  });
}

/**
 * Dismiss a re-displayed fullscreen / start prompt. The enter-fullscreen trial
 * ("Switch to fullscreen mode" + OK) can reappear mid- or end-run when the
 * browser drops out of fullscreen (common under headless Electron); it is not an
 * SDS trial, so the main loop would otherwise poll it until the step cap.
 * Returns true (and queues a click) when such a button is present.
 */
export function dismissFullscreenReprompt(win: TaskWindow): boolean {
  const btn = findEnabledStartButton(win.document);
  if (!btn) return false;
  cy.wrap(btn, { log: false }).click({ force: true });
  return true;
}

/** something-same trials (wide layout): demo narration and/or card pick + OK. */
export function isSomethingSameScreen(win: TaskWindow): boolean {
  return !!win.document.querySelector('.lev-stimulus-container-wide');
}

/** something-same-2: participant must select a card before OK enables. */
export function isSomethingSameCardSelect(win: TaskWindow): boolean {
  const doc = win.document;
  return (
    doc.querySelectorAll('#img-button-container button.image-medium:not(.no-pointer-events)')
      .length >= 2
  );
}

/** Instruction / demo screen (OK may still be disabled until audio finishes). */
export function isInstructionScreen(win: TaskWindow): boolean {
  return hasSdsInstructionChrome(win);
}

/** Click an instruction OK (scoped away from the disabled match confirm button). */
export function clickSdsInstructionOk(): void {
  cy.get('body', { log: false }).then(($body) => {
    const $buttons = $body.find(INSTRUCTION_OK_BUTTON).filter(':visible');
    const $enabled = $buttons.filter((_, el) => !(el as unknown as HTMLButtonElement).disabled);
    const $target = ($enabled.length ? $enabled : $buttons).last();
    if (!$target.length) {
      cy.contains('button', /^OK$/i, { timeout: 120000, log: false })
        .filter(':visible')
        .first()
        .click({ force: true });
      return;
    }
    if (($target[0] as unknown as HTMLButtonElement).disabled) {
      // Timeout must be on wrap — Cypress 15 ignores should(..., { timeout })
      // after wrap of a jQuery snapshot (falls back to defaultCommandTimeout 10s).
      cy.wrap($target, { timeout: 120000 }).should('not.be.disabled');
    }
    cy.wrap($target).click({ force: true });
  });
}

/** Click the keyed card on something-same-2, then wait for OK and press it.
 *
 * The correct card is identified by, in priority order:
 *   1. the `.correct` marker core-tasks adds under Cypress (when present), or
 *   2. the `pulse` animation core-tasks puts on the correct card after the
 *      participant gets it wrong twice (see stimulus.ts: `numberOfErrors >= 2`).
 * Falling back to the first card lets those two wrong tries happen, which arms
 * the pulse hint — so a practice round always converges instead of looping on
 * the same wrong card (which previously ran until the command stack overflowed).
 */
export function advanceSomethingSameScreen(): void {
  cy.get('body', { log: false }).then(($body) => {
    const $selectable = $body.find(
      '#img-button-container button.image-medium:not(.no-pointer-events)',
    );
    if ($selectable.length) {
      const $marked = $selectable.filter('.correct');
      const $pulsing = $selectable.filter((_, el) =>
        /pulse/i.test((el as HTMLElement).style?.animation ?? ''),
      );
      const $target = $marked.length
        ? $marked.first()
        : $pulsing.length
          ? $pulsing.first()
          : $selectable.first();
      cy.wrap($target).click({ force: true });
      cy.wait(300, { log: false });
    }
    clickSdsInstructionOk();
  });
}

/** The single-select cards' `alt`, in DOM order (index === choice index). */
export function readSingleChoices(win: TaskWindow): string[] {
  return Array.from(win.document.querySelectorAll(SINGLE_CHOICE_IMG)).map((img) =>
    (img.getAttribute('alt') ?? '').trim(),
  );
}

/**
 * The reference card's `alt` on a legacy "something same" test item — the
 * disabled `image-medium` card shown ABOVE the choice row (core-tasks
 * `legacyStimulus`, `stim.image`). Returns null when there is no such reference
 * (e.g. a plain test-dimensions screen, which has only a text prompt). Scoped
 * away from the response button group so a choice card is never mistaken for it.
 */
export function readReferenceAlt(win: TaskWindow): string | null {
  const ref = Array.from(win.document.querySelectorAll('button.image-medium')).find(
    (b) => (b as unknown as HTMLButtonElement).disabled && !b.closest(SINGLE_GROUP),
  );
  const alt = ref?.querySelector('img')?.getAttribute('alt');
  return alt ? alt.trim() : null;
}

/**
 * A legacy "something same" test item: a reference card + choice cards (in the
 * response button group) with NO `.correct` answer marker. core-tasks keys the
 * answer via the in-memory `correctResponseIdx` (not exposed to the DOM/storage),
 * so the oracle resolves it structurally instead — see solveSomethingSame.
 */
export function isSomethingSameItem(win: TaskWindow): boolean {
  if (isSingleSelectReady(win) || isMultiSelectReady(win)) return false;
  if (win.document.querySelectorAll(SINGLE_CHOICE).length < 2) return false;
  return readReferenceAlt(win) !== null;
}

/**
 * Four-card test-dimensions screen whose `.correct` key has not painted yet
 * (audio-gated, or the first item after boot). Distinct from a legacy
 * something-same item, which has a reference card and no key by design.
 */
export function isUnkeyedSingleSelect(win: TaskWindow): boolean {
  if (isSingleSelectReady(win) || isMultiSelectReady(win)) return false;
  if (isSomethingSameItem(win)) return false;
  return win.document.querySelectorAll(SINGLE_CHOICE).length >= 2;
}

const SIZE_TOKENS = new Set(['sm', 'med', 'lg', 'small', 'medium', 'large']);

/**
 * Pick the choice that is "the same in some way" as the reference card: the one
 * sharing the most dimension tokens (color / shape / number / background) with
 * it. Size is ignored — it is rarely the tested concept and can tie distractors.
 * Language-agnostic (card `alt`s are English asset identifiers in every locale).
 * Returns -1 when there is no reference or no overlap.
 */
export function solveSomethingSame(reference: string | null, choices: string[]): number {
  if (!reference) return -1;
  const tokens = (s: string): string[] => s.split('-').filter((t) => !SIZE_TOKENS.has(t.toLowerCase()));
  const refTokens = tokens(reference);
  let best = -1;
  let bestOverlap = 0;
  choices.forEach((choice, i) => {
    const overlap = checkOverlap(tokens(choice), refTokens).length;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = i;
    }
  });
  return bestOverlap > 0 ? best : -1;
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
  /** Card index pairs already submitted on this layout (mirrors afcMatch `previousSelections`). */
  previousIndexPairs: Array<[number, number]>;
}

export function newMatchState(): MatchState {
  return { matchedDimensions: [], previousIndexPairs: [] };
}

/** Stable key for a match layout (prompt text excluded — it changes for "new way" rounds). */
export function matchLayoutKey(alts: string[]): string {
  return alts.join(',');
}

function normalizeIndexPair(a: number, b: number): [number, number] {
  return a < b ? [a, b] : [b, a];
}

function isIndexPairUsed(a: number, b: number, previous: Array<[number, number]>): boolean {
  const [x, y] = normalizeIndexPair(a, b);
  return previous.some(([p, q]) => p === x && q === y);
}

/** Record a submitted pair (app pushes to `previousSelections` even on incorrect tries). */
export function commitMatchPair(state: MatchState, pair: MatchPair): MatchState {
  const pq = normalizeIndexPair(pair.a, pair.b);
  return {
    ...state,
    matchedDimensions: [...state.matchedDimensions, pair.dim],
    previousIndexPairs: [...state.previousIndexPairs, pq],
  };
}

/** A chosen pair of card indices and the dimension they were matched on. */
export interface MatchPair {
  a: number;
  b: number;
  dim: string;
}

/**
 * Pick the next valid pair for a match round given the card `alts` and the
 * running per-layout state. Skips index pairs already submitted on this layout
 * (afcMatch `hasNewSelection`). Does not mutate state — call `commitMatchPair`
 * after each confirm click.
 */
export function nextMatchPair(alts: string[], state: MatchState): MatchPair | null {
  const nCards = alts.length;
  const { matchedDimensions, previousIndexPairs } = state;
  // Per-layout reset is handled by the caller (newMatchState on a new card set),
  // so the phase is simply the current card count: >3 cards ignore the size
  // dimension (mirrors core-tasks cleanDimensions / getIgnoreDims).
  const phaseCount = nCards;

  let pair: MatchPair | null = null;

  // Duplicate alts in one set (same image twice): match those indices first, using
  // an unused dimension on that alt — mirrors core-tasks clicking identical images
  // before relying on padded tokens like "1"/"white" across different shapes.
  for (let a = 0; a < nCards && !pair; a++) {
    const altA = alts[a];
    if (!altA) continue;
    for (let b = a + 1; b < nCards; b++) {
      if (altA !== alts[b]) continue;
      if (isIndexPairUsed(a, b, previousIndexPairs)) continue;
      const dims = cleanDimensions(altA.split('-'), phaseCount);
      const dim = dims.find((d) => !matchedDimensions.includes(d));
      if (dim) {
        pair = { a, b, dim };
        break;
      }
    }
  }

  for (let a = 0; a < nCards && !pair; a++) {
    const fa = cleanDimensions(alts[a].split('-'), phaseCount);
    for (let b = 0; b < nCards; b++) {
      if (b === a) continue;
      if (isIndexPairUsed(a, b, previousIndexPairs)) continue;
      const fb = cleanDimensions(alts[b].split('-'), phaseCount);
      const valid = checkOverlap(fb, fa).filter((dim) => !matchedDimensions.includes(dim));
      if (valid.length > 0) {
        pair = { a, b, dim: valid[0] };
        break;
      }
    }
  }

  return pair;
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
