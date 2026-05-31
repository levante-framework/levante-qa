import {
  CONTINUE_BUTTON,
  LEFT_BUTTON,
  RIGHT_BUTTON,
} from './tasks/heartsAndFlowers';
import {
  CHOICE_BUTTON as EGMA_CHOICE_BUTTON,
  CONTINUE_BUTTON as EGMA_CONTINUE_BUTTON,
  SLIDER as EGMA_SLIDER,
} from './tasks/egmaMath';
import {
  CHOICE_BUTTON as VOCAB_CHOICE_BUTTON,
  CONTINUE_BUTTON as VOCAB_CONTINUE_BUTTON,
} from './tasks/vocab';
import {
  CHOICE_BUTTON as STORIES_CHOICE_BUTTON,
  CONTINUE_BUTTON as STORIES_CONTINUE_BUTTON,
} from './tasks/stories';
import {
  SINGLE_CHOICE as SDS_SINGLE_CHOICE,
  MULTI_CHOICE as SDS_MULTI_CHOICE,
  CONTINUE_BUTTON as SDS_CONTINUE_BUTTON,
} from './tasks/sameDifferent';
import {
  CHOICE_BUTTON as MR_CHOICE_BUTTON,
  CONTINUE_BUTTON as MR_CONTINUE_BUTTON,
} from './tasks/mentalRotation';
import {
  CHOICE_BUTTON as MATRIX_CHOICE_BUTTON,
  CONTINUE_BUTTON as MATRIX_CONTINUE_BUTTON,
} from './tasks/matrixReasoning';
import {
  CHOICE_BUTTON as TROG_CHOICE_BUTTON,
  CONTINUE_BUTTON as TROG_CONTINUE_BUTTON,
} from './tasks/trog';
import {
  BLOCK as MEMORY_BLOCK,
  CONTINUE_BUTTON as MEMORY_CONTINUE_BUTTON,
} from './tasks/memoryGame';
import type { Action } from './tasks/types';

/**
 * Map an agent Action onto the corresponding selector and click it. Selectors
 * are imported from the per-task support file and never inlined here.
 */
function selectorForAction(action: Action): string {
  switch (action) {
    case 'LEFT':
      return LEFT_BUTTON;
    case 'RIGHT':
      return RIGHT_BUTTON;
    case 'CONTINUE':
      return CONTINUE_BUTTON;
    default:
      return CONTINUE_BUTTON;
  }
}

Cypress.Commands.add('actOnTrial', (action: Action) => {
  const selector = selectorForAction(action);
  // force:true tolerates transient overlays/animations between trials. If the
  // element is genuinely absent (e.g. CONTINUE on a trial screen) we no-op.
  cy.get('body').then(($body) => {
    if ($body.find(selector).length > 0) {
      cy.get(selector).first().click({ force: true });
    }
  });
});

/**
 * Click the EGMA choice button at `index` (matching its `data-choice`/DOM
 * order). Used by the multiple-choice tasks where the answer is "tap option k".
 */
Cypress.Commands.add('chooseOption', (index: number) => {
  cy.get(EGMA_CHOICE_BUTTON).eq(index).click({ force: true });
});

/** Advance past an EGMA instruction / section screen via its OK button. */
Cypress.Commands.add('continueEgma', () => {
  cy.get('body').then(($body) => {
    if ($body.find(EGMA_CONTINUE_BUTTON).length > 0) {
      cy.get(EGMA_CONTINUE_BUTTON).first().click({ force: true });
    }
  });
});

/**
 * Set the EGMA number-line slider to `value` and fire the events the jsPsych
 * slider plugin listens for (input/change), which also enables its continue
 * button. Submission is done separately via continueEgma.
 */
Cypress.Commands.add('placeSlider', (value: number) => {
  cy.get(EGMA_SLIDER)
    .invoke('val', value)
    .trigger('input', { force: true })
    .trigger('change', { force: true });
});

/**
 * Click the Vocab image choice at `index` (DOM/reading order: 0 = top-left).
 * Vocab uses a different response-row class than EGMA, so it needs its own
 * selector.
 */
Cypress.Commands.add('chooseVocabOption', (index: number) => {
  cy.get(VOCAB_CHOICE_BUTTON).eq(index).click({ force: true });
});

/** Advance past a Vocab instruction / section screen via its OK button. */
Cypress.Commands.add('continueVocab', () => {
  cy.get('body').then(($body) => {
    if ($body.find(VOCAB_CONTINUE_BUTTON).length > 0) {
      cy.get(VOCAB_CONTINUE_BUTTON).first().click({ force: true });
    }
  });
});

/** Click the Stories image choice at `index` (DOM/reading order: 0 = leftmost). */
Cypress.Commands.add('chooseStoriesOption', (index: number) => {
  cy.get(STORIES_CHOICE_BUTTON).eq(index).click({ force: true });
});

/** Advance past a Stories story-beat / instruction screen via its OK button. */
Cypress.Commands.add('continueStories', () => {
  cy.get('body').then(($body) => {
    if ($body.find(STORIES_CONTINUE_BUTTON).length > 0) {
      cy.get(STORIES_CONTINUE_BUTTON).first().click({ force: true });
    }
  });
});

/** Click the SDS single-select card at `index` (0 = leftmost). */
Cypress.Commands.add('chooseSdsSingle', (index: number) => {
  cy.get(SDS_SINGLE_CHOICE).eq(index).click({ force: true });
});

/** Click the SDS multi-select (match) card at `index` (0 = leftmost). */
Cypress.Commands.add('chooseSdsMatch', (index: number) => {
  cy.get(SDS_MULTI_CHOICE).eq(index).click({ force: true });
});

/** Advance past an SDS instruction / display screen via its OK button. */
Cypress.Commands.add('continueSds', () => {
  cy.get('body').then(($body) => {
    if ($body.find(SDS_CONTINUE_BUTTON).length > 0) {
      cy.get(SDS_CONTINUE_BUTTON).first().click({ force: true });
    }
  });
});

/** Click the Mental Rotation image choice at `index` (0 = leftmost). */
Cypress.Commands.add('chooseMrOption', (index: number) => {
  cy.get(MR_CHOICE_BUTTON).eq(index).click({ force: true });
});

/** Advance past a Mental Rotation instruction/transition screen via its OK button. */
Cypress.Commands.add('continueMr', () => {
  cy.get('body').then(($body) => {
    if ($body.find(MR_CONTINUE_BUTTON).length > 0) {
      cy.get(MR_CONTINUE_BUTTON).first().click({ force: true });
    }
  });
});

/** Click the Matrix Reasoning image choice at `index` (0 = leftmost). */
Cypress.Commands.add('chooseMatrixOption', (index: number) => {
  cy.get(MATRIX_CHOICE_BUTTON).eq(index).click({ force: true });
});

/** Advance past a Matrix Reasoning instruction/transition screen via its OK button. */
Cypress.Commands.add('continueMatrix', () => {
  cy.get('body').then(($body) => {
    if ($body.find(MATRIX_CONTINUE_BUTTON).length > 0) {
      cy.get(MATRIX_CONTINUE_BUTTON).first().click({ force: true });
    }
  });
});

/** Click the TROG image choice at `index` (0 = top-left, row-major). */
Cypress.Commands.add('chooseTrogOption', (index: number) => {
  cy.get(TROG_CHOICE_BUTTON).eq(index).click({ force: true });
});

/** Advance past a TROG instruction/transition screen via its OK button. */
Cypress.Commands.add('continueTrog', () => {
  cy.get('body').then(($body) => {
    if ($body.find(TROG_CONTINUE_BUTTON).length > 0) {
      cy.get(TROG_CONTINUE_BUTTON).first().click({ force: true });
    }
  });
});

/** Click the Memory Game block whose `data-id` equals `blockId`. */
Cypress.Commands.add('chooseMemoryBlock', (blockId: number) => {
  cy.get(`${MEMORY_BLOCK}[data-id="${blockId}"]`).click({ force: true });
});

/** Advance past a Memory Game instruction/feedback/ready screen via its OK button. */
Cypress.Commands.add('continueMemory', () => {
  cy.get('body').then(($body) => {
    if ($body.find(MEMORY_CONTINUE_BUTTON).length > 0) {
      cy.get(MEMORY_CONTINUE_BUTTON).first().click({ force: true });
    }
  });
});

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cypress {
    interface Chainable {
      /**
       * Click the response/continue button corresponding to an agent Action.
       */
      actOnTrial(action: Action): Chainable<void>;
      /** Click the EGMA choice button at the given index. */
      chooseOption(index: number): Chainable<void>;
      /** Click the EGMA instruction/section continue (OK) button if present. */
      continueEgma(): Chainable<void>;
      /** Set the EGMA number-line slider to a value and fire input/change. */
      placeSlider(value: number): Chainable<void>;
      /** Click the Vocab image choice at the given index (0 = top-left). */
      chooseVocabOption(index: number): Chainable<void>;
      /** Click the Vocab instruction/section continue (OK) button if present. */
      continueVocab(): Chainable<void>;
      /** Click the Stories image choice at the given index (0 = leftmost). */
      chooseStoriesOption(index: number): Chainable<void>;
      /** Click the Stories story-beat/instruction continue (OK) button if present. */
      continueStories(): Chainable<void>;
      /** Click the SDS single-select card at the given index (0 = leftmost). */
      chooseSdsSingle(index: number): Chainable<void>;
      /** Click the SDS multi-select (match) card at the given index (0 = leftmost). */
      chooseSdsMatch(index: number): Chainable<void>;
      /** Click the SDS instruction/display continue (OK) button if present. */
      continueSds(): Chainable<void>;
      /** Click the Mental Rotation image choice at the given index (0 = leftmost). */
      chooseMrOption(index: number): Chainable<void>;
      /** Click the Mental Rotation instruction/transition continue (OK) button if present. */
      continueMr(): Chainable<void>;
      /** Click the Matrix Reasoning image choice at the given index (0 = leftmost). */
      chooseMatrixOption(index: number): Chainable<void>;
      /** Click the Matrix Reasoning instruction/transition continue (OK) button if present. */
      continueMatrix(): Chainable<void>;
      /** Click the TROG image choice at the given index (0 = top-left, row-major). */
      chooseTrogOption(index: number): Chainable<void>;
      /** Click the TROG instruction/transition continue (OK) button if present. */
      continueTrog(): Chainable<void>;
      /** Click the Memory Game block whose data-id equals blockId. */
      chooseMemoryBlock(blockId: number): Chainable<void>;
      /** Click the Memory Game instruction/feedback continue (OK) button if present. */
      continueMemory(): Chainable<void>;
    }
  }
}

export {};
