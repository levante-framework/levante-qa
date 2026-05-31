import type { MentalRotationSummaryStats, MentalRotationTrialRecord } from './types';

/**
 * Mental Rotation task model: selectors, screen-state detection, the app's
 * answer-key reader, and post-hoc scoring. Verified against core-tasks
 * `src/tasks/mental-rotation/` + shared `afcStimulus` (2026-05-30).
 *
 * Mental Rotation (task id `mental-rotation`) is a **2-alternative forced-choice
 * image task**: a target shape is shown, and two choices below are a rotated
 * copy of it vs. its mirror image; the participant taps the one that is the same
 * shape as the target, just rotated. Items span 2D (rabbit/duck silhouettes) and
 * 3D block figures at various rotation angles (~81 scored items + 2 practice).
 *
 * Like Stories, the answer **cannot be recomputed from a rule**: solving a
 * rotation from the DOM is intractable (choice `alt`s are opaque asset keys like
 * `rp000Silh`, not angles), so the oracle clicks the app's `.correct` key (the
 * choice the app marks under Cypress) and asserts completion + that every item
 * is keyed. The VLM is the real benchmark — it sees the target + choices and
 * must judge rotation vs. mirror, scored against the same key.
 */

export const URL_BASE = 'https://levante-tasks-demo.web.app/';

// cat=false pins the fixed-order timeline; maxIncorrect is raised so a stray
// miss never triggers the early-abort and truncates the run.
export const DEFAULT_PARAMS = {
  task: 'mental-rotation',
  cat: 'false',
  maxIncorrect: 999,
} as const;

// Selectors verified against core-tasks mental-rotation + shared afcStimulus
// (2026-05-30). Defined only here, never inline in specs.
// TODO(selectors): Re-verify against the live demo DOM if markup changes.

export const JSPSYCH_CONTENT = '.jspsych-content';
// Instruction / transition / task-finished continue button ("OK"/"Exit").
export const CONTINUE_BUTTON = 'button.primary';
// The response group holding the two image choices.
export const RESPONSE_GROUP = '#jspsych-html-multi-response-btngroup';
// Image choice buttons, in DOM order (class `image-large`).
export const CHOICE_BUTTON = `${RESPONSE_GROUP} button.image-large`;
// The <img> inside each choice button; its `alt` is the (opaque) asset key.
export const CHOICE_IMG = `${CHOICE_BUTTON} img`;
// The target/reference shape shown above the choices.
export const TARGET_IMG = '.lev-stimulus-container .lev-stim-content img';
// On-screen prompt / narration text.
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

/** Result shape returned by the node-side `solveMentalRotation` cy.task. Kept
 * here (not imported from the plugin) so specs don't pull the sharp-using
 * solver into the browser bundle. */
export interface SolveResult {
  index: number;
  perChoice: { rot: number; mirror: number; score: number }[];
  margin: number;
  angleStepDeg: number;
  gridN: number;
  error?: string;
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
  const stim = doc.querySelector(STIMULUS_CONTAINER);
  if (stim && stim.querySelector('footer')) return true;
  return Array.from(doc.querySelectorAll('button')).some((b) =>
    /^\s*exit\s*$/i.test(b.textContent ?? ''),
  );
}

/** A response item is up when both image choices are present and interactable
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

/** The target/reference shape's asset key, or null. */
export function readTargetAlt(win: TaskWindow): string | null {
  const img = win.document.querySelector(TARGET_IMG);
  const alt = (img?.getAttribute('alt') ?? '').trim();
  return alt || null;
}

/** The target/reference shape's image URL, or null. Feeds the pixel solver. */
export function readTargetSrc(win: TaskWindow): string | null {
  const img = win.document.querySelector(TARGET_IMG) as HTMLImageElement | null;
  const src = (img?.getAttribute('src') ?? '').trim();
  return src || null;
}

/** The choices' image URLs, in DOM order (index === choice index). */
export function readChoiceSrcs(win: TaskWindow): string[] {
  return Array.from(win.document.querySelectorAll(CHOICE_IMG)).map((img) =>
    (img.getAttribute('src') ?? '').trim(),
  );
}

/** The on-screen prompt / narration text for the current screen, or '' if none. */
export function readPromptText(win: TaskWindow): string {
  const el = win.document.querySelector(PROMPT_TEXT);
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Index of the choice the task marks correct, or -1. core-tasks adds `.correct`
 * to the correct choice's <img> under Cypress. This is the only ground truth
 * (rotation can't be recomputed), so it drives the oracle and scores the VLM.
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
 * mean RT, timeout rate, and how many rows carried narration.
 */
export function scoreTrials(trials: MentalRotationTrialRecord[]): MentalRotationSummaryStats {
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
