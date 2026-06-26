import type { TrogSummaryStats, TrogTrialRecord } from './types';

/**
 * TROG (Test for Reception of Grammar) task model: selectors, screen-state
 * detection, the app's answer-key reader, and post-hoc scoring. Verified against
 * core-tasks `src/tasks/trog/` + shared `afcStimulus` (2026-05-31).
 *
 * TROG (task id `trog`) is a **4-alternative forced-choice grammar-comprehension
 * task**: a sentence is spoken (e.g. "the boy is running"), and the participant
 * picks the one picture (of four, in a 2x2 grid) that matches the sentence's
 * meaning. There is **no on-screen sentence** on response trials — the sentence
 * is delivered ONLY by narration (like Vocab), so the audio channel is the key
 * input. ~99 scored items spanning grammatical constructions (nouns, verbs,
 * negatives, reversible passives, prepositions, relative clauses, etc.).
 *
 * Unlike Vocab (whose choice `alt`s ARE the target word, so the narration can be
 * matched to a choice), TROG choice `alt`s are opaque image asset keys
 * (`13-boy-running`) and the answer requires mapping a *sentence* to a *picture*
 * — impossible without vision. So the oracle is **key-driven** (like Stories /
 * Matrix Reasoning): it clicks the app's `.correct` key and asserts completion +
 * that every item is keyed. The VLM is the real benchmark — it receives the
 * sentence (audio transcript) + the picture choices and must pick the match.
 */

export const URL_BASE = 'https://levante-tasks-demo.web.app/';

// cat=false pins the fixed-order timeline; maxIncorrect is raised so a stray
// miss never triggers the early-abort (default 3) and truncates the run.
export const DEFAULT_PARAMS = {
  task: 'trog',
  cat: 'false',
  maxIncorrect: 999,
} as const;

function qaLanguage(): string | null {
  const expose = (globalThis as { Cypress?: { expose?: (key: string) => unknown } }).Cypress?.expose;
  const value = typeof expose === 'function' ? expose('QA_LANGUAGE') : null;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Selectors verified against core-tasks trog + shared afcStimulus (2026-05-31).
// TROG shares Vocab's response layout (`-inline` + 2x2 image-medium grid).
// Defined only here, never inline in specs.
// TODO(selectors): Re-verify against the live demo DOM if markup changes.

export const JSPSYCH_CONTENT = '.jspsych-content';
// Instruction / transition / task-finished continue button ("OK"/"Exit").
export const CONTINUE_BUTTON = 'button.primary';
// The row that holds the 4 image choices on a response trial (note the
// `-inline` suffix + grid-2x2 — the Vocab layout, not Matrix's `.multi-4`).
export const RESPONSE_ROW = '.lev-response-row-inline';
// Individual choice buttons, in DOM order (row-major: index 0 = top-left).
export const CHOICE_BUTTON =
  '.lev-response-row-inline .jspsych-html-multi-response-button button';
// The <img> inside each choice button; its `alt` is an opaque image asset key.
export const CHOICE_IMG = `${CHOICE_BUTTON} img`;
// On-screen prompt text — present on instruction screens only (response trials
// have prompt.enabled=false, so the sentence is audio-only).
export const PROMPT_TEXT = '.lev-stimulus-container .lev-row-container.instruction p';
export const STIMULUS_CONTAINER = '.lev-stimulus-container';
export const REPLAY_BUTTON = '#replay-btn-revisited';
export const EXIT_BUTTON = '#exit-button';
// core-tasks marks the correct choice's <img> with `.correct` under Cypress
// (the non-math afcStimulus path) — NOT on the button, NOT aria-label.
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

/** True when the timeline has ended (content emptied, or a finished/Exit screen
 * is showing). */
export function isComplete(win: TaskWindow): boolean {
  const doc = win.document;
  const content = doc.querySelector(JSPSYCH_CONTENT);
  if (!content || content.children.length === 0) return true;
  if (doc.querySelector(EXIT_BUTTON)) return true;
  const stim = doc.querySelector(STIMULUS_CONTAINER);
  if (stim && stim.querySelector('footer')) return true;
  return Array.from(doc.querySelectorAll('button')).some((b) =>
    /^\s*exit\s*$/i.test(b.textContent ?? ''),
  );
}

/** A response item is up when the image choices are present and interactable
 * (no staggered reveal for this task). */
export function isItemReady(win: TaskWindow): boolean {
  const buttons = Array.from(win.document.querySelectorAll(CHOICE_BUTTON));
  return buttons.length >= 2 && buttons.every((b) => isInteractable(b));
}

/** True on an instruction / transition / finished screen: an enabled `.primary`
 * and no image choices. */
export function isInstructionScreen(win: TaskWindow): boolean {
  const doc = win.document;
  if (doc.querySelectorAll(CHOICE_BUTTON).length >= 2) return false;
  const primary = doc.querySelector(CONTINUE_BUTTON);
  return !!primary && isInteractable(primary);
}

/** The image choices' asset keys, in DOM order (index === choice index). */
export function readChoices(win: TaskWindow): string[] {
  return Array.from(win.document.querySelectorAll(CHOICE_IMG)).map((img) =>
    (img.getAttribute('alt') ?? '').trim(),
  );
}

/** The on-screen prompt text, or '' if none (response trials carry no sentence
 * text — it is audio-only). Exposed mainly for instruction screens. */
export function readPromptText(win: TaskWindow): string {
  const el = win.document.querySelector(PROMPT_TEXT);
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Index of the choice the task marks correct, or -1. core-tasks adds `.correct`
 * to the correct choice's <img> under Cypress. This is the only ground truth
 * (sentence→picture can't be recomputed), so it drives the oracle and scores the
 * VLM.
 */
export function appKeyedCorrectIndex(win: TaskWindow): number {
  const buttons = Array.from(win.document.querySelectorAll(CHOICE_BUTTON));
  return buttons.findIndex(
    (b) => b.matches(CORRECT_MARKER) || !!b.querySelector(CORRECT_MARKER),
  );
}

// --- Scoring ---------------------------------------------------------------

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Aggregate one run: accuracy over scored items (instruction rows excluded),
 * mean RT, timeout rate, and how many rows carried narration (the sentence).
 */
export function scoreTrials(trials: TrogTrialRecord[]): TrogSummaryStats {
  const items = trials.filter((t) => t.itemType === 'item');
  const scored = items.filter((t) => typeof t.correct === 'boolean');
  const hits = scored.filter((t) => t.correct === true).length;
  const rts = items.map((t) => t.rtMs).filter((v): v is number => typeof v === 'number');
  const timedOut = items.filter((t) => t.timedOut === true).length;
  const withAudio = trials.filter((t) => t.audioTranscript).length;

  return {
    nItems: items.length,
    accuracy: scored.length > 0 ? hits / scored.length : null,
    rtMean: mean(rts),
    timeoutRate: items.length > 0 ? timedOut / items.length : 0,
    nWithAudio: withAudio,
  };
}
