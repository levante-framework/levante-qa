import {
  correctAction,
  readStimulus,
  type StimulusState,
  type TaskWindow,
} from '../tasks/heartsAndFlowers';
import type { Action } from '../tasks/types';

/**
 * Deterministic, rule-driven agent. It never calls a model: it reads the
 * stimulus state directly and applies the Hearts & Flowers response rule. On
 * instructions / feedback screens (no interactable response button) it returns
 * 'CONTINUE'.
 */
export const oracleAgent = {
  decide(win: TaskWindow): Action {
    const state: StimulusState = readStimulus(win);
    if (state.blockType === 'instructions') {
      return 'CONTINUE';
    }
    return correctAction(state.shape, state.side, state.blockType);
  },
};

export default oracleAgent;
