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
    }
  }
}

export {};
