import { correctAction } from '../../support/tasks/heartsAndFlowers';
import type { BlockType, ResponseAction, Shape, Side } from '../../support/tasks/types';

/**
 * Hearts & Flowers correctness cross-check (source-equivalence).
 *
 * Unlike the math AFC trials, core-tasks H&F emits NO answer-key marker in the
 * DOM (no `aria-label="correct"`), and `window.jsPsych` is unreadable on the v7
 * build — so the oracle/VLM specs cannot read the app's key at runtime the way
 * the EGMA oracle does. Instead, H&F correctness rests entirely on our
 * `correctAction()` faithfully reimplementing the task's own rule,
 * `getCorrectInputSide()`:
 *
 *   levante-framework/core-tasks task-launcher:
 *   src/tasks/hearts-and-flowers/helpers/utils.js → getCorrectInputSide()
 *     heart + left  -> 0 (LEFT)      heart  -> press the SAME side
 *     heart + right -> 1 (RIGHT)
 *     flower + left  -> 1 (RIGHT)    flower -> press the OPPOSITE side
 *     flower + right -> 0 (LEFT)
 *   (button index 0 = LEFT, 1 = RIGHT — see RESPONSE buttons in heartsAndFlowers.ts)
 *
 * This pure-logic spec pins that equivalence: it asserts `correctAction` returns
 * the canonical answer for every shape×side combination that can occur in each
 * block. If core-tasks ever changes the response rule, this fails immediately —
 * the practical analog of the EGMA app-key cross-check, without needing a run.
 */

// Canonical correct response, transcribed from core-tasks getCorrectInputSide:
// shape-based only — heart => same side, flower => opposite side.
function canonicalCorrect(shape: Exclude<Shape, null>, side: Exclude<Side, null>): ResponseAction {
  if (shape === 'heart') return side === 'left' ? 'LEFT' : 'RIGHT';
  return side === 'left' ? 'RIGHT' : 'LEFT'; // flower
}

// The (block, shape) pairs that actually occur: single-rule blocks only ever
// show their own shape; the mixed block shows both.
const BLOCK_SHAPES: ReadonlyArray<[Exclude<BlockType, 'instructions'>, Exclude<Shape, null>]> = [
  ['hearts', 'heart'],
  ['flowers', 'flower'],
  ['mixed', 'heart'],
  ['mixed', 'flower'],
];
const SIDES: ReadonlyArray<Exclude<Side, null>> = ['left', 'right'];

describe('Hearts & Flowers — response rule equivalence (vs core-tasks)', () => {
  it('correctAction matches getCorrectInputSide for every shape × side × block', () => {
    for (const [block, shape] of BLOCK_SHAPES) {
      for (const side of SIDES) {
        const expected = canonicalCorrect(shape, side);
        const actual = correctAction(shape, side, block);
        expect(actual, `correctAction(${shape}, ${side}, ${block})`).to.equal(expected);
      }
    }
  });
});
