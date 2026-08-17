import { EXIT_LABEL } from './labels';
import type { MemoryGameSummaryStats, MemoryGameTrialRecord } from './types';

/**
 * Memory Game (Corsi block-tapping) task model: selectors, the in-page flash
 * recorder, presentation/response phase detection, forward/backward direction
 * detection, the app's answer-key reader, and post-hoc scoring. Verified against
 * core-tasks `src/tasks/memory-game/` (2026-05-31).
 *
 * Memory Game (task id `memory-game`) is a **spatial memory-span** task built on
 * `@jspsych-contrib/plugin-corsi-blocks`. Each item is TWO jsPsych trials:
 *   1. a **display** trial that flashes a sequence of grid blocks one-at-a-time
 *      (each flash paints the block `#275BDD` for ~1s), and
 *   2. an **input** trial where the participant reproduces the sequence by
 *      clicking the blocks — in the SAME order (forward block) or the REVERSE
 *      order (backward block). The span grows by 1 after every 3 correct test
 *      trials; 16 forward + 21 backward test reps (plus practice).
 *
 * Unlike the AFC tasks there is **no `.correct` marker**. Instead of merely
 * reading the key, this oracle is a genuine **differential test** (the Mental
 * Rotation philosophy): it independently **observes the flashed sequence** from
 * the DOM during the display trial, cross-checks it against the app's internal
 * key (`window.cypressData.correctAnswer`, exposed only under Cypress, always in
 * forward order), then **reproduces the observed sequence** (reversed on backward
 * trials) and lets the app score it. So we verify both that the animation renders
 * the true sequence AND that reproducing it is accepted.
 *
 * VLM: there is no static stimulus — the sequence is a temporal animation a
 * single screenshot can't capture — so this task is **oracle-only**.
 */

export const URL_BASE = 'https://levante-tasks-demo.web.app/';

// age>4 ⇒ 3x3 / 9 blocks and the normal (non-"heavy") instruction path (which
// has no input-phase block animation, so #275BDD only ever marks a display
// flash). maxIncorrect is raised so a stray miss never early-aborts the run.
export const DEFAULT_PARAMS = {
  task: 'memory-game',
  age: 10,
  maxIncorrect: 999,
} as const;

// Selectors verified against core-tasks memory-game + the corsi-blocks plugin
// (2026-05-31). Defined only here, never inline in specs.
// TODO(selectors): Re-verify against the live demo DOM if markup changes.

export const JSPSYCH_CONTENT = '.jspsych-content';
// Instruction / feedback / ready / task-finished continue button ("OK"/"Exit").
export const CONTINUE_BUTTON = 'button.primary';
// The grid container (id is cleared from #jspsych-corsi-stimulus at load).
export const GRID = '.lev-corsi-override';
// The individual blocks; each carries a stable 0-based `data-id`.
export const BLOCK = '.jspsych-corsi-block';
// Prompt paragraph: visible on input/instruction screens, hidden on display.
export const PROMPT_TEXT = '.lev-row-container.instruction p';
export const REPLAY_BUTTON = '#replay-btn-revisited';
export const EXIT_BUTTON = '#exit-button';

// The display-flash highlight color is #275BDD = rgb(39, 91, 221). On display
// trials the plugin leaves CSS transitions enabled, so the computed color
// animates INTO that value and rarely equals it exactly on a given poll. We
// therefore detect a flash by polarity instead of exact match: a strongly
// dark-blue fill (low red/green, high blue). This also correctly ignores the
// lighter click-feedback blue #8CAEDF = rgb(140, 174, 223), whose red channel is
// well above the threshold, and the grey idle fills.
export const FLASH_RGB = 'rgb(39, 91, 221)';

/** True when a computed `rgb(...)`/`rgba(...)` string is the dark-blue display
 * highlight (tolerant of mid-transition frames; excludes the click-feedback
 * blue). */
export function isFlashColor(bg: string): boolean {
  const m = bg.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (!m) return false;
  const r = Number(m[1]);
  const g = Number(m[2]);
  const b = Number(m[3]);
  return b > 160 && r < 120 && g < 150;
}

export interface MemoryWindow extends Window {
  /** App's answer key: the forward sequence, set under Cypress on input trials. */
  cypressData?: { correctAnswer: number[] };
  /** jsPsych instance core-tasks exposes (for reading the app's own scoring). */
  initJsPsych?: { data: { get: () => { values: () => Record<string, unknown>[] } } };
  /** Flash events recorded by the in-page recorder (installed at onBeforeLoad). */
  __mgFlashes?: { id: number; t: number }[];
  /** Handle of the recorder interval, so it is installed at most once. */
  __mgRecorder?: number;
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

/**
 * Install (at cy.visit onBeforeLoad, before the app loads) a recorder that logs
 * every presentation flash. We use a MutationObserver on the `style` attribute
 * rather than polling computed styles: the corsi plugin sets the block's
 * **inline** `style.backgroundColor` to the exact highlight value the instant a
 * flash starts, so reading the inline value is immune to both the CSS transition
 * (which only animates the *rendered* color) and main-thread congestion (which
 * can starve a polling interval and was dropping early flashes on big sequences).
 * Runs for the whole task; the spec clears the buffer after each item, so it only
 * ever holds the current display's flashes. Self-contained so it executes safely
 * in the application realm.
 */
export function installFlashRecorder(win: Window): void {
  const w = win as MemoryWindow;
  w.__mgFlashes = [];
  if (w.__mgRecorder) return;
  const lit = new WeakMap<Element, boolean>();
  const recordIfFlash = (el: Element): void => {
    // Only count flashes on a presentation block; never the response trial,
    // where a click paints a lighter blue.
    if (!el.classList.contains('jspsych-corsi-block') || !el.classList.contains('display')) {
      lit.set(el, false);
      return;
    }
    const isLit = isFlashColor((el as HTMLElement).style.backgroundColor);
    const wasLit = lit.get(el) === true;
    if (isLit && !wasLit) {
      const id = Number((el as HTMLElement).getAttribute('data-id'));
      if (Number.isFinite(id)) (w.__mgFlashes as { id: number; t: number }[]).push({ id, t: Date.now() });
    }
    lit.set(el, isLit);
  };
  const MO = (win as unknown as { MutationObserver: typeof MutationObserver }).MutationObserver;
  const observer = new MO((mutations: MutationRecord[]) => {
    for (const m of mutations) recordIfFlash(m.target as Element);
  });
  observer.observe(win.document.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: ['style'],
  });
  // Marker so we install at most once (value is unused otherwise).
  w.__mgRecorder = 1;
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

/** True when the timeline has ended (content emptied, or an Exit screen shows). */
export function isComplete(win: MemoryWindow): boolean {
  const doc = win.document;
  const content = doc.querySelector(JSPSYCH_CONTENT);
  if (!content || content.children.length === 0) return true;
  if (doc.querySelector(EXIT_BUTTON)) return true;
  return Array.from(doc.querySelectorAll('button')).some((b) =>
    EXIT_LABEL.test(b.textContent ?? ''),
  );
}

/** True whenever the corsi grid is on screen (display OR input phase). */
export function isGridVisible(win: MemoryWindow): boolean {
  return win.document.querySelectorAll(BLOCK).length > 0;
}

/** The presentation phase: blocks carry the `.display` class. */
export function isDisplayPhase(win: MemoryWindow): boolean {
  const b = win.document.querySelector(BLOCK);
  return !!b && b.classList.contains('display');
}

/** The response phase: blocks carry the `.input` class (clickable). */
export function isInputPhase(win: MemoryWindow): boolean {
  const b = win.document.querySelector(BLOCK);
  return !!b && b.classList.contains('input');
}

/** True on an instruction / feedback / ready / finished screen: an enabled
 * `.primary` and no grid. */
export function isInstructionScreen(win: MemoryWindow): boolean {
  if (isGridVisible(win)) return false;
  const primary = win.document.querySelector(CONTINUE_BUTTON);
  return !!primary && isInteractable(primary);
}

/** Number of blocks in the grid (9 for the 3x3 default). */
export function blockCount(win: MemoryWindow): number {
  return win.document.querySelectorAll(BLOCK).length;
}

/** The on-screen prompt text (the input narration's caption), or ''. */
export function readPromptText(win: MemoryWindow): string {
  const el = win.document.querySelector(PROMPT_TEXT);
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** The app's answer key for the current item: the forward sequence, or null. */
export function appKeyedSequence(win: MemoryWindow): number[] | null {
  const seq = win.cypressData?.correctAnswer;
  return Array.isArray(seq) ? seq.slice() : null;
}

/**
 * The flashed sequence the recorder observed for the CURRENT display trial, read
 * from `window.__mgFlashes`. The caller clears the buffer after every input
 * trial, so the buffer only ever holds the current display's flashes — we simply
 * return them in order. Consecutive duplicate ids are collapsed defensively (the
 * generator never produces adjacent repeats, so a repeat would be a double rising
 * edge from one flash, not two flashes).
 */
export function observedSequence(win: MemoryWindow): number[] {
  const ids = (win.__mgFlashes ?? []).map((f) => f.id);
  return ids.filter((id, i) => i === 0 || id !== ids[i - 1]);
}

/** Clear the recorded flash buffer (call after reading an item's sequence). */
export function clearObservedFlashes(win: MemoryWindow): void {
  win.__mgFlashes = [];
}

/** Are two index sequences identical (same order)? */
export function sequencesEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * The app's own per-trial scoring, read from jsPsych data at the end of a run:
 * one entry per completed input trial. Used to assert the app accepted every
 * reproduction. Returns null if jsPsych data isn't readable.
 */
export function readAppInputScores(
  win: MemoryWindow,
): { correct: boolean; isPractice: boolean; corpusTrialType: string | null }[] | null {
  try {
    const values = win.initJsPsych?.data.get().values();
    if (!Array.isArray(values)) return null;
    return values
      .filter((d) => (d as { trialMode?: string }).trialMode === 'input')
      .map((d) => ({
        correct: (d as { correct?: boolean }).correct === true,
        isPractice: (d as { isPracticeTrial?: boolean }).isPracticeTrial === true,
        corpusTrialType: ((d as { corpusTrialType?: string }).corpusTrialType ?? null) as string | null,
      }));
  } catch {
    return null;
  }
}

// --- Scoring ---------------------------------------------------------------

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Aggregate one run: how many sequence trials, the observe/key agreement rate
 * (did the observed flash sequence match the app's internal key — the authentic
 * check), accuracy (whether each reproduction was accepted), forward/backward
 * counts, the max span reached, and narration coverage.
 */
export function scoreTrials(trials: MemoryGameTrialRecord[]): MemoryGameSummaryStats {
  const seqs = trials.filter((t) => t.itemType === 'sequence');
  const scored = seqs.filter((t) => typeof t.correct === 'boolean');
  const hits = scored.filter((t) => t.correct === true).length;
  const agreed = seqs.filter((t) => t.observedMatchesKey === true).length;
  const withKey = seqs.filter((t) => Array.isArray(t.keyedSequence) && t.keyedSequence.length > 0).length;
  const spans = seqs.map((t) => t.spanLength).filter((v): v is number => typeof v === 'number');
  const rts = seqs.map((t) => t.rtMs).filter((v): v is number => typeof v === 'number');
  const withAudio = trials.filter((t) => t.audioTranscript).length;

  return {
    nSequences: seqs.length,
    nForward: seqs.filter((t) => t.phase === 'forward').length,
    nBackward: seqs.filter((t) => t.phase === 'backward').length,
    accuracy: scored.length > 0 ? hits / scored.length : null,
    observeKeyAgreement: withKey > 0 ? agreed / withKey : null,
    maxSpan: spans.length > 0 ? Math.max(...spans) : null,
    rtMean: mean(rts),
    nWithAudio: withAudio,
  };
}
