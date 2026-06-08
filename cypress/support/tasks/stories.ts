import type { StoriesSummaryStats, StoriesTrialRecord } from './types';

/**
 * Stories (Theory of Mind) task model: selectors, screen-state detection, the
 * app's answer-key reader, story-context helpers, and post-hoc scoring.
 *
 * "Stories" (task id `theory-of-mind`) presents short narrated stories, then
 * asks comprehension / false-belief / emotion-reasoning questions with 2–4
 * IMAGE choices (locations, emotion faces, yes/no). Verified against core-tasks
 * `src/tasks/theory-of-mind/` + shared `afcStimulus`, 2026-05-30.
 *
 * Two things make this task different from vocab/egma:
 *   1. The answer CANNOT be derived by a deterministic rule — it requires
 *      following the story and reasoning about characters' beliefs. So the
 *      "oracle" here is NOT a differential test; it can only click the choice
 *      the app marks correct (the `.correct` marker, emitted under Cypress), the
 *      same ground truth core-tasks' own e2e test clicks. It validates that the
 *      task is completable, that every item ships an answer key, and that the
 *      audio/stagger/sequencing all work — not that we independently "know" the
 *      answer (there is nothing to recompute it against).
 *   2. Choices are STAGGERED: each renders disabled (`.lev-staggered-disabled`)
 *      and is revealed one at a time with its own audio; only after the last is
 *      revealed do all become active. We must wait for that before reading /
 *      acting, or we'd act on a partially-revealed set.
 *
 * The real benchmark is the VLM agent, which sees the scene + question + choice
 * images (plus the accumulated story narration as its "audio channel") and is
 * scored against the same `.correct` key.
 */

export const URL_BASE = 'https://levante-tasks-demo.web.app/';

// maxIncorrect is raised above the corpus size so a model error never triggers
// the task's early-abort (default 3) and truncates the run.
export const DEFAULT_PARAMS = {
  task: 'theory-of-mind',
  maxIncorrect: 999,
} as const;

function qaLanguage(): string | null {
  const cypressEnv = (globalThis as { Cypress?: { env?: (key: string) => unknown } }).Cypress?.env;
  const value = typeof cypressEnv === 'function' ? cypressEnv('QA_LANGUAGE') : null;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function qaNumberOfStories(): number | null {
  const cypressEnv = (globalThis as { Cypress?: { env?: (key: string) => unknown } }).Cypress?.env;
  const value = typeof cypressEnv === 'function' ? cypressEnv('QA_STORIES_NUMBER_OF_STORIES') : null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function qaCorpus(): string | null {
  const cypressEnv = (globalThis as { Cypress?: { env?: (key: string) => unknown } }).Cypress?.env;
  const value = typeof cypressEnv === 'function' ? cypressEnv('QA_STORIES_CORPUS') : null;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Selectors verified against core-tasks theory-of-mind + shared afcStimulus
// (2026-05-30). Selectors must only ever be defined here, never inline in specs.
// TODO(selectors): Re-verify against the live demo DOM if markup changes.

export const JSPSYCH_CONTENT = '.jspsych-content';
// Instruction / story-beat / task-finished continue button ("OK"/"Exit").
export const CONTINUE_BUTTON = 'button.primary';
// The response group holding the image choices on a question trial.
export const RESPONSE_GROUP = '#jspsych-html-multi-response-btngroup';
// Image choice buttons, in DOM order (class `image`, NOT vocab's `image-medium`).
export const CHOICE_BUTTON = `${RESPONSE_GROUP} button.image`;
// The <img> inside each choice button; its `alt` is the concept/answer key.
export const CHOICE_IMG = `${CHOICE_BUTTON} img`;
// Class present on a staggered choice button until ALL choices are revealed.
export const STAGGER_DISABLED = 'lev-staggered-disabled';
// Generic stimulus container (holds the narration/question text + scene image).
export const STIMULUS_CONTAINER = '.lev-stimulus-container';
// The narration/question text bubble (ToM promptClassList = instruction-small).
export const PROMPT_TEXT = '.lev-stimulus-container .instruction-small';
// Replay-audio button.
export const REPLAY_BUTTON = '#replay-btn-revisited';
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
  if (!url.searchParams.has('language')) {
    const language = qaLanguage();
    if (language) url.searchParams.set('language', language);
  }
  if (!url.searchParams.has('numberOfStories')) {
    const numberOfStories = qaNumberOfStories();
    if (numberOfStories) url.searchParams.set('numberOfStories', String(numberOfStories));
  }
  if (!url.searchParams.has('corpus')) {
    const corpus = qaCorpus();
    if (corpus) url.searchParams.set('corpus', corpus);
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

/** True once a question item's image choices are fully revealed: at least two
 * choice buttons exist and NONE is still staggered-disabled. Because the
 * multi-response plugin renders all N buttons up front (the stagger only toggles
 * classes), checking "no button is staggered-disabled" is a reliable
 * all-revealed signal that also yields the correct choice count. */
export function isItemReady(win: TaskWindow): boolean {
  const buttons = Array.from(win.document.querySelectorAll(CHOICE_BUTTON));
  if (buttons.length < 2) return false;
  return buttons.every((b) => !b.classList.contains(STAGGER_DISABLED) && isInteractable(b));
}

/** True when image choices are present but still revealing (stagger in
 * progress) — used to capture the question narration before acting. */
export function isItemStaggering(win: TaskWindow): boolean {
  const buttons = Array.from(win.document.querySelectorAll(CHOICE_BUTTON));
  return buttons.length >= 2 && buttons.some((b) => b.classList.contains(STAGGER_DISABLED));
}

/** True on a story-beat / instruction / finished screen: a visible enabled
 * `.primary` (OK/Exit) button and no image choices. The OK button is disabled
 * during narration, so this only fires once the clip has finished. */
export function isInstructionScreen(win: TaskWindow): boolean {
  const doc = win.document;
  if (doc.querySelectorAll(CHOICE_BUTTON).length >= 2) return false;
  const primary = doc.querySelector(CONTINUE_BUTTON);
  return !!primary && isInteractable(primary);
}

/** The concept/answer word for each image choice, in DOM order (index === choice
 * index). Read from each choice `<img alt>`. */
export function readChoices(win: TaskWindow): string[] {
  return Array.from(win.document.querySelectorAll(CHOICE_IMG)).map((img) =>
    (img.getAttribute('alt') ?? '').trim(),
  );
}

/** The on-screen narration / question text for the current screen (the prompt
 * bubble), whitespace-collapsed, or '' if none. This is the participant-facing
 * text and the VLM's story/question context. */
export function readPromptText(win: TaskWindow): string {
  const el = win.document.querySelector(PROMPT_TEXT);
  const text = (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (text) return text;
  // Fallback: whole stimulus container text minus nothing better available.
  const container = win.document.querySelector(STIMULUS_CONTAINER);
  return (container?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Index of the choice the task itself marks correct, or -1 if no marker is
 * present. core-tasks adds `.correct` to the correct choice's <img> under
 * Cypress. For Stories this is the ONLY reliable ground truth (the answer needs
 * story inference), so it both drives the oracle and scores the VLM.
 */
export function appKeyedCorrectIndex(win: TaskWindow): number {
  const buttons = Array.from(win.document.querySelectorAll(CHOICE_BUTTON));
  return buttons.findIndex(
    (b) => b.matches(CORRECT_MARKER) || !!b.querySelector(CORRECT_MARKER),
  );
}

/** Heuristic: does this narration mark a story boundary ("Nice work! Here is a
 * new story.")? Used by the VLM agent to reset its accumulated story context so
 * one story's beats don't bleed into the next story's questions. */
export function isStoryBoundary(text: string | null): boolean {
  return /new story|another story|next story|nice work|here'?s a (new|different)/i.test(text ?? '');
}

// --- Scoring ---------------------------------------------------------------

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Aggregate one run: accuracy over scored question items (story/instruction
 * rows excluded), mean RT, timeout rate, and how many items carried narration.
 */
export function scoreTrials(trials: StoriesTrialRecord[]): StoriesSummaryStats {
  const questions = trials.filter((t) => t.itemType === 'question');
  const scored = questions.filter((t) => typeof t.correct === 'boolean');
  const hits = scored.filter((t) => t.correct === true).length;
  const rts = questions.map((t) => t.rtMs).filter((v): v is number => typeof v === 'number');
  const timedOut = questions.filter((t) => t.timedOut === true).length;
  const withAudio = trials.filter((t) => t.audioTranscript).length;

  return {
    nQuestions: questions.length,
    accuracy: scored.length > 0 ? hits / scored.length : null,
    rtMean: mean(rts),
    timeoutRate: questions.length > 0 ? timedOut / questions.length : 0,
    nWithAudio: withAudio,
  };
}
