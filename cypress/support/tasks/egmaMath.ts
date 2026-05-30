import type { EgmaItemType, EgmaSummaryStats, EgmaTrialRecord } from './types';

/**
 * EGMA-math task model: selectors, screen-state detection, item classification,
 * the deterministic solver, and post-hoc scoring.
 *
 * EGMA (Early Grade Math Assessment) as configured in the hosted LEVANTE demo
 * exercises two item families, BOTH of which present the question only by
 * narration — there is no on-screen prompt text — so the audio channel is a hard
 * prerequisite (verified against the live demo, 2026-05-29):
 *   - number-identification: narration "Choose the N"; the target N exists ONLY
 *     in the audio. Four numeric choices; tap the one equal to N.
 *   - number-comparison: narration "Which is larger/smaller?"; the operands are
 *     the two on-screen numeric choices; tap the larger/smaller per the audio.
 *
 * Responses use the jsPsych html-multi-response plugin: choices render as
 * `.lev-response-row .jspsych-html-multi-response-button button` in DOM order
 * (parent carries `data-choice=<index>`); the answer is the button whose text
 * equals the solved value.
 */

export const URL_BASE = 'https://levante-tasks-demo.web.app/';

export const DEFAULT_PARAMS = {
  task: 'egma-math',
} as const;

// Selectors verified against the live demo
// (https://levante-tasks-demo.web.app/?task=egma-math, 2026-05-29). Selectors
// must only ever be defined here, never inline in specs.
// TODO(selectors): Re-verify if the core-tasks plugin/markup changes.

// jsPsych content root; the task is finished when this is empty/absent.
export const JSPSYCH_CONTENT = '.jspsych-content';
// Instruction / section / task-finished continue button ("OK"/"Exit"). Also
// used to submit a number-line slider placement.
export const CONTINUE_BUTTON = '.primary';
// The row that holds the answer choices on a response trial.
export const RESPONSE_ROW = '.lev-response-row';
// Individual choice buttons, in DOM order (index === data-choice on the parent).
export const CHOICE_BUTTON = '.lev-response-row .jspsych-html-multi-response-button button';
// Generic stimulus container (present on every screen).
export const STIMULUS_CONTAINER = '.lev-stimulus-container';
// Number-line slider input (jsPsych slider-response plugin).
export const SLIDER = 'input[type=range]';
// Task-finished marker (see core-tasks finishExperiment).
export const EXIT_BUTTON = '#exit-button';

export interface TaskWindow extends Window {
  // v7 exposes only a throwing stub; kept for typing of cy.window().
  jsPsych?: unknown;
}

/**
 * Build the full task URL from the base and parameters.
 */
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

/** True on an instruction / section / finished screen: a visible `.primary`
 * (OK/Exit) continue button is shown. Item screens are detected separately via
 * isItemReady; the spec checks items first so this never fires on a trial. */
export function isInstructionScreen(win: TaskWindow): boolean {
  const primary = win.document.querySelector(CONTINUE_BUTTON);
  return !!primary && isInteractable(primary);
}

/** Visible choice button texts, in DOM order (index === data-choice). */
export function readChoices(win: TaskWindow): string[] {
  return Array.from(win.document.querySelectorAll(CHOICE_BUTTON)).map((b) =>
    (b.textContent ?? '').trim(),
  );
}

/** The on-screen stimulus text (e.g. "2+3", "5, 10, 15, _"), whitespace-collapsed.
 * EGMA's visual item types put the whole question here; audio-only types (number
 * identification, comparison) leave it effectively empty. */
export function readStimulusText(win: TaskWindow): string {
  const stim = win.document.querySelector(STIMULUS_CONTAINER);
  return (stim?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** True when the current screen is a number-line slider trial. Presence-based:
 * the slider can briefly report zero size during render, and the screen also
 * carries a .primary submit button, so we must detect it before instructions. */
export function isSliderScreen(win: TaskWindow): boolean {
  return !!win.document.querySelector(SLIDER);
}

/** True once a response item's choices have rendered (>= 2 interactable buttons). */
export function isItemReady(win: TaskWindow): boolean {
  const buttons = Array.from(win.document.querySelectorAll(CHOICE_BUTTON));
  const visible = buttons.filter((b) => isInteractable(b));
  return visible.length >= 2;
}

/** Phrases the narration uses for feedback rather than to pose a new item. */
const FEEDBACK_RE = /try again|good job|nice job|well done|correct|let'?s try|that'?s right/i;

export function isFeedbackTranscript(transcript: string | null): boolean {
  return transcript !== null && FEEDBACK_RE.test(transcript);
}

// --- Classification + solving ----------------------------------------------

/** Parse the first signed integer in a string, or null. */
function firstInt(text: string): number | null {
  const m = text.match(/-?\d+/);
  return m ? Number(m[0]) : null;
}

function choiceNumbers(choices: string[]): (number | null)[] {
  return choices.map(firstInt);
}

// Arithmetic stimulus like "2+3", "12-4", "1x5", "8÷2" (EGMA renders × as a
// lowercase "x" and ÷ as "/"). Captures operands and operator.
const ARITHMETIC_RE = /(-?\d+)\s*([+\-x×*/÷])\s*(-?\d+)/;
// A sequence stimulus is a comma-separated list with exactly one blank ("_"),
// e.g. "5, 10, 15, _" or "1, 2, _, 4".
const SEQUENCE_RE = /(?:[\d_]+\s*,\s*){1,}[\d_]+/;

/**
 * Classify the current item. EGMA delivers visual item types (arithmetic,
 * sequences, number line) on screen and audio-only types (number identification,
 * comparison) by narration, so we look at the stimulus first, then the
 * narration. Returns 'instructions' for feedback/section narration, 'unknown'
 * when nothing is recognized.
 */
export function classifyItem(
  transcript: string | null,
  stimText = '',
  choices: string[] = [],
): EgmaItemType {
  const stim = stimText.trim();

  // Number line: "Move the slider to mark the number. N".
  if (/move the slider|number line/i.test(stim) || /move the slider|number line/i.test(transcript ?? '')) {
    return 'number-line';
  }
  // Arithmetic: "a op b" with no sequence commas.
  if (ARITHMETIC_RE.test(stim) && !stim.includes(',')) {
    return 'arithmetic';
  }
  // Missing-number / sequence: a comma list containing a blank.
  if (stim.includes('_') && SEQUENCE_RE.test(stim)) {
    return 'missing-number';
  }
  // Audio-driven number identification.
  if (
    transcript &&
    /(?:choose|find|select|tap|touch|point to)\s+the\s+(?:number\s+)?-?\d+/i.test(transcript)
  ) {
    return 'number-identification';
  }
  // Audio-driven comparison, or its silent variant: a two-numeric-choice item
  // with no stimulus is always a number-comparison ("which is larger?") in this
  // corpus, even when the per-item narration was missed.
  if (transcript && /\b(larg|bigg|great|more|most|high|small|less|few|fewer|least|low)/i.test(transcript)) {
    return 'number-comparison';
  }
  const numeric = choiceNumbers(choices).filter((n) => n !== null);
  if (!stim && numeric.length === 2 && choices.length === 2) {
    return 'number-comparison';
  }
  if (transcript && isFeedbackTranscript(transcript)) return 'instructions';
  return 'unknown';
}

export interface Solution {
  index: number;
  value: string;
}

function applyOp(a: number, op: string, b: number): number | null {
  switch (op) {
    case '+':
      return a + b;
    case '-':
      return a - b;
    case 'x':
    case '×':
    case '*':
      return a * b;
    case '/':
    case '÷':
      return b === 0 ? null : a / b;
    default:
      return null;
  }
}

/** Infer the missing value in a single-blank arithmetic sequence. Uses the
 * common step from the known numeric neighbours; returns null if the list is not
 * a consistent arithmetic progression. */
export function solveSequence(stimText: string): number | null {
  const tokens = stimText.split(',').map((t) => t.trim());
  const blankIndex = tokens.findIndex((t) => t === '_' || t === '');
  if (blankIndex < 0) return null;
  const values = tokens.map((t) => (t === '_' || t === '' ? null : Number(t)));
  if (values.some((v) => v !== null && Number.isNaN(v))) return null;

  // Determine the common step from consecutive known pairs.
  const steps: number[] = [];
  for (let i = 1; i < values.length; i += 1) {
    const a = values[i - 1];
    const b = values[i];
    if (a !== null && b !== null) steps.push((b - a) / 1);
  }
  // Steps across the blank span two positions, so normalize those too.
  if (steps.length === 0) return null;
  const step = steps[0];
  if (!steps.every((s) => s === step)) {
    // Allow the blank to create one double-width gap; derive step from the rest.
    const consistent = steps.filter((s) => s === step);
    if (consistent.length < steps.length - 1) return null;
  }

  // Walk from the nearest known anchor to the blank.
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] !== null) {
      return (values[i] as number) + step * (blankIndex - i);
    }
  }
  return null;
}

/**
 * The correct choice for a multiple-choice item, derived from the stimulus
 * and/or narration. Returns null when it cannot be solved deterministically, so
 * callers can surface it rather than guess. (Number-line is handled separately
 * via solveNumberLine since it is a slider, not a choice.)
 */
export function solveItem(
  itemType: EgmaItemType,
  transcript: string | null,
  choices: string[],
  stimText = '',
): Solution | null {
  const nums = choiceNumbers(choices);
  const matchValue = (target: number): Solution | null => {
    const index = nums.findIndex((n) => n === target);
    return index >= 0 ? { index, value: choices[index] } : null;
  };

  if (itemType === 'arithmetic') {
    const m = stimText.match(ARITHMETIC_RE);
    if (!m) return null;
    const result = applyOp(Number(m[1]), m[2], Number(m[3]));
    return result === null ? null : matchValue(result);
  }

  if (itemType === 'missing-number') {
    const value = solveSequence(stimText);
    return value === null ? null : matchValue(value);
  }

  if (itemType === 'number-identification' && transcript) {
    const m = transcript
      .toLowerCase()
      .match(/(?:choose|find|select|tap|touch|point to)\s+the\s+(?:number\s+)?(-?\d+)/);
    if (!m) return null;
    return matchValue(Number(m[1]));
  }

  if (itemType === 'number-comparison') {
    const p = (transcript ?? '').toLowerCase();
    // Default to "larger": EGMA number discrimination always asks for the larger
    // value, and later items in the section play no narration.
    const wantSmallest = /\b(small|less|few|fewer|least|low)/.test(p);
    let bestIdx = -1;
    let best = wantSmallest ? Infinity : -Infinity;
    nums.forEach((n, i) => {
      if (n === null) return;
      if (wantSmallest ? n < best : n > best) {
        best = n;
        bestIdx = i;
      }
    });
    return bestIdx >= 0 ? { index: bestIdx, value: choices[bestIdx] } : null;
  }

  return null;
}

export interface SliderPlan {
  target: number;
  min: number;
  max: number;
  /** The value to set on the input (== target, clamped to [min, max]). */
  value: number;
}

/**
 * Plan a number-line placement: read the target from the stimulus ("...mark the
 * number. N") and the line's range from the slider input's min/max attributes.
 * Returns null when either is unavailable.
 */
export function solveNumberLine(win: TaskWindow, stimText: string): SliderPlan | null {
  const slider = win.document.querySelector(SLIDER) as HTMLInputElement | null;
  if (!slider) return null;
  const targetMatch = stimText.match(/(-?\d+(?:\.\d+)?)\s*$/) ?? stimText.match(/(-?\d+(?:\.\d+)?)/);
  if (!targetMatch) return null;
  const target = Number(targetMatch[1]);
  const min = Number(slider.min === '' ? 0 : slider.min);
  const max = Number(slider.max === '' ? 100 : slider.max);
  if (Number.isNaN(target) || Number.isNaN(min) || Number.isNaN(max) || max === min) return null;
  const value = Math.min(max, Math.max(min, target));
  return { target, min, max, value };
}

/** Find the choice index whose numeric value equals `value` (e.g. a VLM's
 * answer), or -1. Compares numerically so "07" matches "7". */
export function choiceIndexForValue(choices: string[], value: number | null): number {
  if (value === null) return -1;
  return choiceNumbers(choices).findIndex((n) => n === value);
}

// --- Fractions (MathML) ----------------------------------------------------
//
// EGMA's fraction section renders operands and choices as MathML <mfrac>, e.g.
// `1/5 + 1/5 = ?`. Their textContent collapses to "15"/"25", which is ambiguous,
// so we read the <mfrac> structure directly and compare exact rational values.

const FRACTION_EPS = 1e-9;

/** Numeric value of a MathML value element: a fraction (first/second <mn> of its
 * <mfrac>) or a plain integer (<mn>/text). Returns null if unparseable. */
function mathmlValue(el: Element | null): number | null {
  if (!el) return null;
  // The element may itself be the <mfrac> (a stimulus operand) or contain one
  // (a choice button wrapping <math><mfrac>…).
  const mfrac = el.tagName.toLowerCase() === 'mfrac' ? el : el.querySelector('mfrac');
  if (mfrac) {
    const mns = mfrac.querySelectorAll('mn');
    if (mns.length < 2) return null;
    const n = Number(mns[0].textContent);
    const d = Number(mns[1].textContent);
    if (Number.isNaN(n) || Number.isNaN(d) || d === 0) return null;
    return n / d;
  }
  const t = (el.textContent ?? '').trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isNaN(n) ? null : n;
}

/** True when the current item is a MathML fraction problem (operands shown as
 * <mfrac> in the stimulus). */
export function isFractionItem(win: TaskWindow): boolean {
  const stim = win.document.querySelector(STIMULUS_CONTAINER);
  return !!stim?.querySelector('.lev-stim-content-x-3 mfrac, p mfrac, math mfrac');
}

/** Solve a MathML fraction item: parse the two operand fractions and operator
 * from the stimulus, compute the exact value, and match it to a choice. */
export function solveFractionItem(win: TaskWindow): Solution | null {
  const stim = win.document.querySelector(STIMULUS_CONTAINER);
  const math = stim?.querySelector('math');
  if (!math) return null;
  const scope = math.querySelector('mrow') ?? math;
  const kids = Array.from(scope.children);
  const fracs = kids.filter((k) => k.tagName.toLowerCase() === 'mfrac');
  if (fracs.length < 2) return null;
  const left = mathmlValue(fracs[0]);
  const right = mathmlValue(fracs[1]);
  if (left === null || right === null) return null;

  const opRaw = kids
    .filter((k) => k.tagName.toLowerCase() === 'mo')
    .map((o) => (o.textContent ?? '').trim())
    .find((o) => /[+\-x×*/÷−]/.test(o));
  const op = (opRaw ?? '+').replace('−', '-');
  const result = applyOp(left, op, right);
  if (result === null) return null;

  const choiceEls = Array.from(win.document.querySelectorAll(CHOICE_BUTTON));
  const index = choiceEls.findIndex((el) => {
    const v = mathmlValue(el);
    return v !== null && Math.abs(v - result) < FRACTION_EPS;
  });
  if (index < 0) return null;
  return { index, value: (choiceEls[index].textContent ?? '').trim() };
}

/** Find the choice index whose MathML fraction value equals `value` (e.g. a
 * VLM's fractional answer "2/5" parsed to 0.4), or -1. Used to map a VLM reply
 * to a fraction choice button, since their textContent ("25") is ambiguous. */
export function fractionChoiceIndexForValue(win: TaskWindow, value: number | null): number {
  if (value === null) return -1;
  const choiceEls = Array.from(win.document.querySelectorAll(CHOICE_BUTTON));
  return choiceEls.findIndex((el) => {
    const v = mathmlValue(el);
    return v !== null && Math.abs(v - value) < FRACTION_EPS;
  });
}

// --- Scoring ---------------------------------------------------------------

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function accuracyOf(trials: EgmaTrialRecord[]): number | null {
  const scored = trials.filter((t) => typeof t.correct === 'boolean');
  if (scored.length === 0) return null;
  return scored.filter((t) => t.correct === true).length / scored.length;
}

const CHOICE_TYPES: ReadonlyArray<EgmaItemType> = [
  'number-identification',
  'number-comparison',
  'missing-number',
  'arithmetic',
  'fraction',
];

/** True for an exact-scored multiple-choice response item. */
export function isChoiceItem(record: EgmaTrialRecord): boolean {
  return CHOICE_TYPES.includes(record.itemType);
}

/** True for any response item (choice items + the proximity-scored number line). */
export function isResponseItem(record: EgmaTrialRecord): boolean {
  return isChoiceItem(record) || record.itemType === 'number-line';
}

export function scoreTrials(trials: EgmaTrialRecord[]): EgmaSummaryStats {
  const choiceItems = trials.filter(isChoiceItem);
  const numberLine = trials.filter((t) => t.itemType === 'number-line');
  const responses = trials.filter(isResponseItem);

  const accByType: Record<string, number | null> = {};
  for (const type of CHOICE_TYPES) {
    const ofType = choiceItems.filter((t) => t.itemType === type);
    if (ofType.length > 0) accByType[type] = accuracyOf(ofType);
  }

  const nlErrors = numberLine
    .map((t) => t.numberLineError)
    .filter((v): v is number => typeof v === 'number');

  const timeouts = responses.filter((t) => t.timedOut === true).length;

  return {
    nTrials: responses.length,
    accChoice: accuracyOf(choiceItems),
    accByType,
    numberLineMeanError: mean(nlErrors),
    rtMean: mean(responses.map((t) => t.rtMs).filter((v): v is number => typeof v === 'number')),
    timeoutRate: responses.length > 0 ? timeouts / responses.length : 0,
    itemTypesObserved: Array.from(new Set(trials.map((t) => t.itemType))),
  };
}
