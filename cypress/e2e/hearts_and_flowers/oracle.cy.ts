import oracleAgent from '../../support/agents/oracleAgent';
import {
  buildUrl,
  congruency,
  correctAction,
  readStimulus,
  resetBlockTracker,
  type TaskWindow,
} from '../../support/tasks/heartsAndFlowers';
import { parseTrialRecord, type BlockType, type TrialRecord } from '../../support/tasks/types';

const MAX_STEPS = 400;
const COMPLETE_TEXT = /You've completed the game/i;
const TASK = 'hearts-and-flowers';

describe('Hearts & Flowers — oracle (deterministic)', () => {
  const records: TrialRecord[] = [];
  let gameComplete = false;

  function finalize(): void {
    const ts = Date.now();
    cy.task('writeJsonl', {
      path: `cypress/logs/oracle_hf_${ts}.jsonl`,
      records,
    });

    const responses = records.filter((r) => r.action === 'LEFT' || r.action === 'RIGHT');
    const blocksObserved = new Set<BlockType>(records.map((r) => r.block));

    cy.wrap(null).then(() => {
      expect(gameComplete, 'game reached completion screen').to.equal(true);

      const correctCount = responses.filter((r) => r.correct === true).length;
      const accuracy = responses.length > 0 ? correctCount / responses.length : 0;
      expect(accuracy, 'oracle accuracy').to.equal(1.0);

      const timeouts = responses.filter((r) => r.timedOut === true).length;
      expect(timeouts, 'oracle timeouts').to.equal(0);

      expect(blocksObserved.has('hearts'), 'hearts block observed').to.equal(true);
      expect(blocksObserved.has('flowers'), 'flowers block observed').to.equal(true);
      expect(blocksObserved.has('mixed'), 'mixed block observed').to.equal(true);
    });
  }

  function step(i: number): void {
    if (i >= MAX_STEPS) {
      finalize();
      return;
    }

    cy.get('body').then(($body) => {
      if (COMPLETE_TEXT.test($body.text())) {
        gameComplete = true;
        finalize();
        return;
      }

      cy.window().then((w) => {
        const win = w as unknown as TaskWindow;
        const state = readStimulus(win);
        const action = oracleAgent.decide(win);

        const isResponse = action === 'LEFT' || action === 'RIGHT';
        const expected = isResponse
          ? correctAction(state.shape, state.side, state.blockType)
          : null;

        records.push(
          parseTrialRecord({
            timestamp: new Date().toISOString(),
            task: TASK,
            step: i,
            block: state.blockType,
            shape: state.shape,
            side: state.side,
            congruency: state.blockType === 'mixed' ? congruency(state.shape, state.side) : null,
            action,
            correct: isResponse ? action === expected : null,
            rtMs: null,
            oracle: true,
          }),
        );

        cy.actOnTrial(action);
        cy.wait(150);
        step(i + 1);
      });
    });
  }

  it('completes all blocks at 100% accuracy', () => {
    resetBlockTracker();
    cy.visit(buildUrl());
    step(0);
  });
});
