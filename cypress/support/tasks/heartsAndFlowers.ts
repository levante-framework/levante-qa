import type {
  BlockType,
  Congruency,
  ResponseAction,
  Shape,
  Side,
  SummaryStats,
  TrialRecord,
} from './types';

/**
 * Hearts & Flowers task model: selectors, stimulus parsing, the response rule,
 * congruency classification, and post-hoc scoring.
 *
 * Hearts & Flowers (a.k.a. the "hearts and flowers" / dots task from
 * Davidson et al. 2006; Diamond 2013) has three block types:
 *   - hearts  block: press the button on the SAME side as the stimulus.
 *   - flowers block: press the button on the OPPOSITE side from the stimulus.
 *   - mixed   block: the rule depends on the shape (heart -> same, flower -> opposite).
 */

export const URL_BASE = 'https://levante-tasks-demo.web.app/';

export const DEFAULT_PARAMS = {
  task: 'hearts-and-flowers',
  maxTime: 8,
  maxIncorrect: 6,
} as const;

// Selectors verified against the live demo
// (https://levante-tasks-demo.web.app/?task=hearts-and-flowers, 2026-05-29).
// The core-tasks build uses the @jspsych html-multi-response plugin: the two
// response choices are stable plugin IDs (button-0 = left, button-1 = right),
// each wrapping the actual clickable <button>. Instruction/feedback screens use
// a single `button.primary` ("OK") with no response button group.
// TODO(selectors): Re-verify if the core-tasks plugin/markup changes. Selectors
// must only ever be defined here, never inline in specs.
export const LEFT_BUTTON = '#jspsych-html-multi-response-button-0 button';
export const RIGHT_BUTTON = '#jspsych-html-multi-response-button-1 button';
export const CONTINUE_BUTTON = 'button.primary';

// The response button group; its presence (with interactable buttons) marks a
// response trial as opposed to an instructions/feedback screen.
export const RESPONSE_GROUP = '#jspsych-html-multi-response-btngroup';

// The visible stimulus image. Shape is read from its `src` (heart.webp /
// flower.webp); side is read from its wrapper class (.stimulus-left /
// .stimulus-right), falling back to the bounding box vs viewport center.
export const STIMULUS_IMG = '.haf-stimulus-container img';
export const STIMULUS_LEFT_WRAP = '.stimulus-left';
export const STIMULUS_RIGHT_WRAP = '.stimulus-right';

// Instruction / feedback text shown above the stimulus, used to track which
// block we are in (no jsPsych data is available in v7 — see readStimulus).
export const INSTRUCTION_TEXT = '.lev-row-container.instruction p';

/**
 * Build the full task URL from the base and parameters.
 */
export function buildUrl(base: string = URL_BASE, params: Record<string, string | number> = DEFAULT_PARAMS): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

// --- jsPsych typings (minimal, best-effort) -------------------------------

interface JsPsychTrialData {
  [key: string]: unknown;
}

interface JsPsychDataCollection {
  values(): JsPsychTrialData[];
}

interface JsPsychData {
  get(): { last(n: number): JsPsychDataCollection };
}

interface JsPsychInstance {
  data?: JsPsychData;
}

export interface TaskWindow extends Window {
  jsPsych?: JsPsychInstance;
}

export interface StimulusState {
  shape: Shape;
  side: Side;
  blockType: BlockType;
}

// NOTE: The current core-tasks build runs jsPsych v7, which intentionally
// removes the global `window.jsPsych` (accessing it throws). So readFromJsPsych
// returns null on the live demo and the DOM path below is authoritative. These
// probes are kept for forward-compatibility in case a future build re-exposes
// trial metadata on the window.
// TODO(selectors): If a build exposes jsPsych data, confirm these field names.
const SHAPE_KEYS = ['shape', 'stimulus_type', 'stimulusType', 'targetShape'];
const SIDE_KEYS = ['side', 'position', 'location', 'targetSide', 'stimulusSide'];
const BLOCK_KEYS = ['block', 'blockType', 'block_type', 'condition', 'trial_type', 'trialType'];

function coerceShape(value: unknown): Shape {
  if (typeof value !== 'string') return null;
  const v = value.toLowerCase();
  if (v.includes('heart')) return 'heart';
  if (v.includes('flower')) return 'flower';
  return null;
}

function coerceSide(value: unknown): Side {
  if (typeof value !== 'string') return null;
  const v = value.toLowerCase();
  if (v.includes('left')) return 'left';
  if (v.includes('right')) return 'right';
  return null;
}

function coerceBlock(value: unknown): BlockType | null {
  if (typeof value !== 'string') return null;
  const v = value.toLowerCase();
  if (v.includes('mixed')) return 'mixed';
  if (v.includes('heart')) return 'hearts';
  if (v.includes('flower')) return 'flowers';
  if (v.includes('instruction')) return 'instructions';
  return null;
}

function firstMatch<T>(data: JsPsychTrialData, keys: string[], coerce: (v: unknown) => T | null): T | null {
  for (const key of keys) {
    if (key in data) {
      const result = coerce(data[key]);
      if (result !== null) return result;
    }
  }
  return null;
}

function readFromJsPsych(win: TaskWindow): Partial<StimulusState> | null {
  try {
    const collection = win.jsPsych?.data?.get().last(1);
    const values = collection?.values();
    if (!values || values.length === 0) return null;
    const trial = values[0];
    return {
      shape: firstMatch(trial, SHAPE_KEYS, coerceShape),
      side: firstMatch(trial, SIDE_KEYS, coerceSide),
      blockType: firstMatch(trial, BLOCK_KEYS, coerceBlock) ?? undefined,
    };
  } catch {
    return null;
  }
}

function isInteractable(el: Element | null): boolean {
  if (!el) return false;
  const htmlEl = el as HTMLElement;
  if ((htmlEl as HTMLButtonElement).disabled) return false;
  const style = el.ownerDocument?.defaultView?.getComputedStyle(htmlEl);
  if (style && (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none')) {
    return false;
  }
  const rect = htmlEl.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * Block tracking. The live build exposes no per-trial block label in the DOM,
 * and jsPsych data is unavailable (v7). We therefore infer the active block
 * statefully from the block-introduction instruction text and carry it through
 * the subsequent timed trials. Reset between runs via resetBlockTracker().
 * TODO(block): Ideally core-tasks would expose the block on a data attribute or
 * via accessible trial data; until then this text heuristic is our best signal.
 */
let currentBlock: Exclude<BlockType, 'instructions'> = 'hearts';

export function resetBlockTracker(): void {
  currentBlock = 'hearts';
}

function updateBlockFromText(text: string | null): void {
  if (!text) return;
  const t = text.toLowerCase();
  // Block-introduction phrasing ("the heart game", "the flower game", a mixed
  // intro mentioning both / "sometimes"). Per-trial practice hints also mention
  // a single shape, but they never contradict the block they appear in.
  if (/both|mixed|sometimes|hearts?\s+and\s+flowers?/.test(t)) {
    currentBlock = 'mixed';
  } else if (/flower\s+game|flower\b/.test(t) && !/heart/.test(t)) {
    currentBlock = 'flowers';
  } else if (/heart\s+game|heart\b/.test(t) && !/flower/.test(t)) {
    currentBlock = 'hearts';
  }
}

function shapeFromImg(img: HTMLImageElement): Shape {
  // The alt text is generic ("heart or flower"); the filename in src is the
  // reliable signal (.../hearts-and-flowers/heart.webp | flower.webp).
  return coerceShape(img.getAttribute('src') ?? '');
}

function sideFromImg(img: HTMLImageElement, win: TaskWindow): Side {
  // Preferred: the wrapper element class (.stimulus-left / .stimulus-right).
  if (img.closest(STIMULUS_LEFT_WRAP)) return 'left';
  if (img.closest(STIMULUS_RIGHT_WRAP)) return 'right';
  // Fallback: bounding box center vs viewport center.
  const rect = img.getBoundingClientRect();
  if (rect.width === 0) return null;
  const center = rect.left + rect.width / 2;
  const viewportCenter = (win.innerWidth || win.document.documentElement.clientWidth) / 2;
  return center < viewportCenter ? 'left' : 'right';
}

function readFromDom(win: TaskWindow): StimulusState {
  const doc = win.document;

  updateBlockFromText(doc.querySelector(INSTRUCTION_TEXT)?.textContent ?? null);

  // A response trial requires the response button group with at least one
  // interactable choice; otherwise we are on an instructions / feedback /
  // fixation screen.
  const hasGroup = !!doc.querySelector(RESPONSE_GROUP);
  const leftBtn = doc.querySelector(LEFT_BUTTON);
  const rightBtn = doc.querySelector(RIGHT_BUTTON);
  const responsesActive = hasGroup && (isInteractable(leftBtn) || isInteractable(rightBtn));

  if (!responsesActive) {
    return { shape: null, side: null, blockType: 'instructions' };
  }

  const img = doc.querySelector(STIMULUS_IMG) as HTMLImageElement | null;
  return {
    shape: img ? shapeFromImg(img) : null,
    side: img ? sideFromImg(img, win) : null,
    blockType: currentBlock,
  };
}

/**
 * Read the current stimulus state, preferring jsPsych metadata and falling back
 * to DOM heuristics. Returns blockType 'instructions' when no response button is
 * currently interactable (instructions / feedback / fixation screens).
 *
 * On the current (jsPsych v7) build the DOM path is authoritative; readFromJsPsych
 * returns null because the global jsPsych handle is intentionally removed.
 */
export function readStimulus(win: TaskWindow): StimulusState {
  const dom = readFromDom(win);
  const fromJs = readFromJsPsych(win);

  if (!fromJs) {
    return dom;
  }

  // jsPsych takes precedence for fields it can supply; DOM fills the gaps. If
  // the DOM says responses are inactive, that overrides any stale block label.
  const blockType: BlockType = dom.blockType === 'instructions'
    ? 'instructions'
    : fromJs.blockType ?? dom.blockType;

  return {
    shape: fromJs.shape ?? dom.shape,
    side: fromJs.side ?? dom.side,
    blockType,
  };
}

function sameSide(side: Side): ResponseAction | null {
  if (side === 'left') return 'LEFT';
  if (side === 'right') return 'RIGHT';
  return null;
}

function oppositeSide(side: Side): ResponseAction | null {
  if (side === 'left') return 'RIGHT';
  if (side === 'right') return 'LEFT';
  return null;
}

/**
 * The correct response for a given stimulus.
 *   - hearts  -> same side as the stimulus.
 *   - flowers -> opposite side from the stimulus.
 *   - mixed   -> rule selected by shape (heart = same, flower = opposite).
 *
 * Falls back to 'LEFT' only when side is unknown; callers should avoid invoking
 * this on instructions screens (see oracleAgent).
 */
export function correctAction(shape: Shape, side: Side, blockType: BlockType): ResponseAction {
  let action: ResponseAction | null;
  switch (blockType) {
    case 'hearts':
      action = sameSide(side);
      break;
    case 'flowers':
      action = oppositeSide(side);
      break;
    case 'mixed':
      action = shape === 'flower' ? oppositeSide(side) : sameSide(side);
      break;
    default:
      action = sameSide(side);
      break;
  }
  return action ?? 'LEFT';
}

/**
 * Congruency for mixed-block analysis, per the standard Hearts & Flowers
 * definition (Davidson et al. 2006; Diamond 2013): a trial is "congruent" when
 * the correct response is on the SAME side as the stimulus, and "incongruent"
 * when it is on the OPPOSITE side. In this task the shape fully determines that:
 *   - heart  -> press same side    -> congruent
 *   - flower -> press opposite side -> incongruent
 *
 * The `side` parameter is accepted for symmetry and future-proofing; it does not
 * change the classification under the standard definition.
 */
export function congruency(shape: Shape, _side: Side): Congruency {
  return shape === 'flower' ? 'incongruent' : 'congruent';
}

// --- Scoring ---------------------------------------------------------------

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function accuracyOf(trials: TrialRecord[]): number | null {
  const scored = trials.filter((t) => typeof t.correct === 'boolean');
  if (scored.length === 0) return null;
  const hits = scored.filter((t) => t.correct === true).length;
  return hits / scored.length;
}

/**
 * Compute per-block accuracy, mixed-block congruent vs incongruent accuracy and
 * mean RT, timeout rate, and a single composite EF score.
 */
export function scoreTrials(trials: TrialRecord[]): SummaryStats {
  // Only response trials (LEFT/RIGHT) count toward accuracy; CONTINUE presses on
  // instructions/feedback screens are excluded.
  const responseTrials = trials.filter((t) => t.action === 'LEFT' || t.action === 'RIGHT');

  const heartsTrials = responseTrials.filter((t) => t.block === 'hearts');
  const flowersTrials = responseTrials.filter((t) => t.block === 'flowers');
  const mixedTrials = responseTrials.filter((t) => t.block === 'mixed');

  const congruentTrials = mixedTrials.filter((t) => t.congruency === 'congruent');
  const incongruentTrials = mixedTrials.filter((t) => t.congruency === 'incongruent');

  const accHearts = accuracyOf(heartsTrials);
  const accFlowers = accuracyOf(flowersTrials);
  const accMixed = accuracyOf(mixedTrials);
  const accCongruent = accuracyOf(congruentTrials);
  const accIncongruent = accuracyOf(incongruentTrials);

  const rtMeanMixed = mean(
    mixedTrials.map((t) => t.rtMs).filter((v): v is number => typeof v === 'number'),
  );

  const timedOutCount = responseTrials.filter((t) => t.timedOut === true).length;
  const timeoutRate = responseTrials.length > 0 ? timedOutCount / responseTrials.length : 0;

  const blocksObserved = Array.from(new Set(trials.map((t) => t.block))) as BlockType[];

  // Composite EF score: the mixed (switching) block is the most demanding, so it
  // is double-weighted relative to the single-rule blocks. When the mixed block
  // was not observed we fall back to the mean of the available block accuracies.
  const efComposite = computeEfComposite(accHearts, accFlowers, accMixed);

  return {
    nTrials: responseTrials.length,
    accHearts,
    accFlowers,
    accMixed,
    accCongruent,
    accIncongruent,
    rtMeanMixed,
    timeoutRate,
    blocksObserved,
    efComposite,
  };
}

function computeEfComposite(
  accHearts: number | null,
  accFlowers: number | null,
  accMixed: number | null,
): number | null {
  if (accMixed !== null && accHearts !== null && accFlowers !== null) {
    return (accHearts + accFlowers + 2 * accMixed) / 4;
  }
  const available = [accHearts, accFlowers, accMixed].filter((v): v is number => v !== null);
  return available.length > 0 ? mean(available) : null;
}
