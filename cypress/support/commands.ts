import {
  CONTINUE_BUTTON,
  LEFT_BUTTON,
  RIGHT_BUTTON,
} from './tasks/heartsAndFlowers';
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

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cypress {
    interface Chainable {
      /**
       * Click the response/continue button corresponding to an agent Action.
       */
      actOnTrial(action: Action): Chainable<void>;
    }
  }
}

export {};
