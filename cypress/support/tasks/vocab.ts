import type { VocabSummaryStats, VocabTrialRecord } from './types';

/**
 * Vocab task model: selectors, screen-state detection, the audio-driven solver,
 * the app's answer-key reader, and post-hoc scoring.
 *
 * Vocab (LEVANTE picture-vocabulary) is a 4-alternative forced-choice picture
 * task rendered through the shared `afcStimulus` trial (verified against
 * core-tasks `src/tasks/vocab/`, 2026-05-30):
 *   - The target word is delivered ONLY by narration (no on-screen prompt text
 *     and no stimulus image), so the audio channel is a hard prerequisite —
 *     just like EGMA's number-identification items.
 *   - Four image choices render in a 2x2 grid as
 *     `.lev-response-row-inline .jspsych-html-multi-response-button button.image-medium`,
 *     each wrapping an `<img alt="<word>">`. The button text is empty; the
 *     concept is the image's `alt`.
 *
 * Answer key: under Cypress, core-tasks marks the correct choice by adding a
 * `.correct` class to the correct button's `<img>` (non-math path in
 * afcStimulus.ts — NOT `aria-label="correct"`, which is math-only). We read it
 * via appKeyedCorrectIndex to cross-check the audio-driven solver (oracle) and
 * to score the VLM against the task's own key.
 */

export const URL_BASE = 'https://levante-tasks-demo.web.app/';

// maxIncorrect is raised well above the corpus size so a solver/model error
// never triggers the task's early-abort (default 3) and truncates the run —
// we want every item attempted so the differential cross-check sees them all.
export const DEFAULT_PARAMS = {
  task: 'vocab',
  maxIncorrect: 999,
} as const;

function qaLanguage(): string | null {
  const expose = (globalThis as { Cypress?: { expose?: (key: string) => unknown } }).Cypress?.expose;
  const value = typeof expose === 'function' ? expose('QA_LANGUAGE') : null;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Selectors verified against core-tasks vocab source + shared afcStimulus
// (2026-05-30). Selectors must only ever be defined here, never inline in specs.
// TODO(selectors): Re-verify against the live demo DOM if markup changes.

// jsPsych content root; the task is finished when this is empty/absent.
export const JSPSYCH_CONTENT = '.jspsych-content';
// Instruction / section / task-finished continue button ("OK"/"Exit").
export const CONTINUE_BUTTON = '.primary';
// The row that holds the 4 image choices on a response trial (note the
// `-inline` suffix + grid-2x2 — DIFFERENT from EGMA's `.lev-response-row`).
export const RESPONSE_ROW = '.lev-response-row-inline';
// Individual choice buttons, in DOM order (row-major: index 0 = top-left).
export const CHOICE_BUTTON =
  '.lev-response-row-inline .jspsych-html-multi-response-button button';
// The <img> inside each choice button; its `alt` is the concept word.
export const CHOICE_IMG = `${CHOICE_BUTTON} img`;
// Generic stimulus container (present on every screen, holds the replay button).
export const STIMULUS_CONTAINER = '.lev-stimulus-container';
// Replay-audio button on a response trial.
export const REPLAY_BUTTON = '.replay';
// Task-finished marker (see core-tasks finishExperiment).
export const EXIT_BUTTON = '#exit-button';
// The marker core-tasks adds (under Cypress) to the correct choice's <img>.
const CORRECT_MARKER = '.correct, [aria-label="correct"]';

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
  if (!url.searchParams.has('lng') && !url.searchParams.has('language')) {
    const language = qaLanguage();
    if (language) url.searchParams.set('lng', language);
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

/** True when the jsPsych timeline has ended (content root emptied, or a
 * task-finished Exit button is present). */
export function isComplete(win: TaskWindow): boolean {
  const doc = win.document;
  const content = doc.querySelector(JSPSYCH_CONTENT);
  if (!content || content.children.length === 0) return true;
  if (doc.querySelector(EXIT_BUTTON)) return true;
  return Array.from(doc.querySelectorAll('button')).some((b) =>
    /^\s*exit\s*$/i.test(b.textContent ?? ''),
  );
}

/** True once a response item's image choices have rendered (>= 2 interactable
 * buttons). Vocab is 4-AFC; we check >= 2 for robustness against staggered
 * render. */
export function isItemReady(win: TaskWindow): boolean {
  const buttons = Array.from(win.document.querySelectorAll(CHOICE_BUTTON));
  return buttons.filter((b) => isInteractable(b)).length >= 2;
}

/** True on an instruction / section / finished screen: a visible `.primary`
 * (OK/Exit) button is shown. Specs check isItemReady first, so this never fires
 * on a response trial. */
export function isInstructionScreen(win: TaskWindow): boolean {
  const primary = win.document.querySelector(CONTINUE_BUTTON);
  return !!primary && isInteractable(primary);
}

/** The concept word for each image choice, in DOM order (index === choice
 * index). Read from each choice `<img alt>`; the button text is empty. */
export function readChoices(win: TaskWindow): string[] {
  return Array.from(win.document.querySelectorAll(CHOICE_IMG)).map((img) =>
    (img.getAttribute('alt') ?? '').trim(),
  );
}

/**
 * Index of the choice the task itself marks correct, or -1 if no marker is
 * present. core-tasks adds `.correct` to the correct choice's <img> under
 * Cypress (vocab/non-math path). This is the app's own answer key, used to
 * cross-check (not drive) the audio-driven solver and to score the VLM.
 */
export function appKeyedCorrectIndex(win: TaskWindow): number {
  const buttons = Array.from(win.document.querySelectorAll(CHOICE_BUTTON));
  return buttons.findIndex(
    (b) => b.matches(CORRECT_MARKER) || !!b.querySelector(CORRECT_MARKER),
  );
}

/**
 * Normalize a word/phrase for matching: lowercase, drop a leading article
 * ("the"/"a"/"an"), strip punctuation, and collapse whitespace. The narration
 * is typically "the acorn" while the image alt is "acorn", so article-stripping
 * and containment matching bridge the two.
 */
export function normalizeWord(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The target concept word parsed from the narration transcript (article
 * stripped), or null. Exposed for logging. */
export function targetWordFromTranscript(transcript: string | null): string | null {
  const t = normalizeWord(transcript);
  return t.length > 0 ? t : null;
}

/**
 * Independently solve the item from the narration: match the spoken word to the
 * image choice whose `alt` names it. Returns the choice index, or -1 if no
 * confident match (the caller logs it and falls back to the app key only to
 * advance). This deliberately does NOT read the `.correct` marker, so the
 * oracle's answer is genuinely independent of the task's key.
 */
export function solveFromTranscript(transcript: string | null, choices: string[]): number {
  const target = normalizeWord(transcript);
  if (!target) return -1;
  const norm = choices.map(normalizeWord);

  // 1. Exact normalized match.
  const exact = norm.findIndex((c) => c.length > 0 && c === target);
  if (exact >= 0) return exact;

  // 2. Containment either way (handles "the rubber band" alt rendered as
  //    "rubber", or a transcript that embeds the word in a short phrase). Pick
  //    the longest matching choice to avoid a short choice matching loosely.
  let best = -1;
  let bestLen = 0;
  norm.forEach((c, i) => {
    if (c.length === 0) return;
    if ((target.includes(c) || c.includes(target)) && c.length > bestLen) {
      best = i;
      bestLen = c.length;
    }
  });
  if (best >= 0) return best;

  // 3. Token overlap: any shared word.
  const targetTokens = new Set(target.split(' '));
  return norm.findIndex((c) => c.split(' ').some((tok) => tok.length > 1 && targetTokens.has(tok)));
}

// --- Scoring ---------------------------------------------------------------

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Aggregate one run: accuracy over scored word items (CONTINUE/instruction
 * rows excluded), mean RT, timeout rate, and how many items carried narration.
 */
export function scoreTrials(trials: VocabTrialRecord[]): VocabSummaryStats {
  const items = trials.filter((t) => t.itemType === 'word');
  const scored = items.filter((t) => typeof t.correct === 'boolean');
  const hits = scored.filter((t) => t.correct === true).length;
  const rts = items.map((t) => t.rtMs).filter((v): v is number => typeof v === 'number');
  const timedOut = items.filter((t) => t.timedOut === true).length;
  const withAudio = items.filter((t) => t.audioTranscript).length;

  return {
    nTrials: items.length,
    accuracy: scored.length > 0 ? hits / scored.length : null,
    rtMean: mean(rts),
    timeoutRate: items.length > 0 ? timedOut / items.length : 0,
    nWithAudio: withAudio,
  };
}
