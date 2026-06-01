import {
  correctAction,
  readStimulus,
  type StimulusState,
  type TaskWindow,
} from '../tasks/heartsAndFlowers';
import type { Action } from '../tasks/types';
import { invertResponseAction } from '../agentMode';

/** Always picks the incorrect LEFT/RIGHT; still advances on CONTINUE screens. */
export const wrongHeartsAgent = {
  decide(win: TaskWindow): Action {
    const state: StimulusState = readStimulus(win);
    if (state.blockType === 'instructions') {
      return 'CONTINUE';
    }
    const right = correctAction(state.shape, state.side, state.blockType);
    if (right === 'LEFT' || right === 'RIGHT') {
      return invertResponseAction(right);
    }
    return right;
  },
};

export default wrongHeartsAgent;
