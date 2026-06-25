import {
  CONTINUE_BUTTON,
  LEFT_BUTTON,
  RIGHT_BUTTON,
  RESPONSE_BUTTON as HF_RESPONSE_BUTTON,
  STIMULUS_CONTAINER as HF_STIMULUS_CONTAINER,
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
  MATCH_CONFIRM_BUTTON as SDS_MATCH_CONFIRM_BUTTON,
  clickSdsInstructionOk,
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
    if (action === 'LEFT' || action === 'RIGHT') {
      // hfV2 picks its input mode from the device: a touch device taps the
      // response buttons (clicked above), a non-touch device (navigator
      // .maxTouchPoints === 0, as in headless Electron) plays a "Looks like you
      // have a keyboard!" intro and registers responses via Arrow keys ONLY —
      // the button click does nothing, so without this the hearts practice loops
      // forever on the same stimulus. Touch / v1 builds have no key listener, so
      // the keypress is harmless there.
      cy.window({ log: false }).then((win) => {
        if ((win.navigator?.maxTouchPoints ?? 0) === 0) {
          const arrow = action === 'LEFT' ? '{leftarrow}' : '{rightarrow}';
          cy.get('body').type(arrow, { force: true, log: false });
        }
      });
    }
    if (action === 'CONTINUE') {
      // hfV2 in keyboard mode (non-touch: navigator.maxTouchPoints === 0, as in
      // headless Electron) renders NO `.primary` continue button. Text instruction
      // screens advance on the SPACEBAR; the left/right "learn the keys" demos
      // advance on Arrow keys. Touch / v1 builds use the button above and have no
      // key listeners, so these presses are harmless there. The caller polls and
      // calls CONTINUE repeatedly, which is required because the spacebar listener
      // is only armed once the screen's narration audio ends.
      //
      // SPACEBAR is always safe — response trials only listen for ArrowLeft/Right,
      // never space. ARROW keys, by contrast, ARE live trial responses in keyboard
      // mode, so firing them indiscriminately races through (and skips) real
      // trials. Only press arrows on a genuine demo screen: demo response buttons
      // present (`.secondary--green`) AND no real stimulus container
      // (`.haf-stimulus-container`), which a live trial always has.
      cy.get('body').type(' ', { force: true, log: false });
      cy.get('body').then(($scope) => {
        const isKeyboardDemo =
          $scope.find(HF_RESPONSE_BUTTON).length > 0 &&
          $scope.find(HF_STIMULUS_CONTAINER).length === 0;
        if (isKeyboardDemo) {
          cy.get('body').type('{leftarrow}{rightarrow}', { force: true, log: false });
        }
      });
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

/** Confirm a match pair on taskVersion 2 (OK below the card row). No-op on v1. */
Cypress.Commands.add('confirmSdsMatch', () => {
  cy.get('body', { log: false }).then(($body) => {
    const $ok = $body.find(SDS_MATCH_CONFIRM_BUTTON).filter(':visible');
    if ($ok.length === 0) return;
    const $enabled = $ok.filter((_, el) => !(el as unknown as HTMLButtonElement).disabled);
    const $target = ($enabled.length ? $enabled : $ok).first();
    if (($target[0] as unknown as HTMLButtonElement).disabled) {
      cy.wrap($target).should('not.be.disabled', { timeout: 60000 });
    }
    cy.wrap($target).click({ force: true });
  });
});

/** Advance past an SDS instruction / display screen via its OK button. */
Cypress.Commands.add('continueSds', () => {
  clickSdsInstructionOk();
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
      cy.get(MATRIX_CONTINUE_BUTTON).filter(':enabled').first().click({ force: true });
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

/**
 * Capture the current viewport and return it as a base64 PNG for a VLM call.
 *
 * Under WSL2 software rendering `cy.screenshot()` occasionally fails to flush
 * the file in time, so a bare `cy.readFile` (default 10s) can time out and
 * abort a long run mid-task (observed at ~step 431 of a 4-minute EGMA run).
 * This waits for the file via the `screenshotReady` node task, re-takes the
 * screenshot once if it never landed, then reads it with a generous timeout.
 */
const CAPTURE_READ_TIMEOUT_MS = 30000;
const CAPTURE_READY_TIMEOUT_MS = 15000;

Cypress.Commands.add('captureViewportBase64', (name: string) => {
  let shotPath = '';
  cy.screenshot(name, {
    capture: 'viewport',
    overwrite: true,
    onAfterScreenshot(_doc, props) {
      shotPath = props.path;
    },
  });
  return cy
    .then(() => cy.task('screenshotReady', { path: shotPath, timeoutMs: CAPTURE_READY_TIMEOUT_MS }))
    .then((ready) => {
      if (ready) {
        return cy.readFile(shotPath, 'base64', { timeout: CAPTURE_READ_TIMEOUT_MS });
      }
      // First capture never reached disk: re-take it once, then read.
      let retryPath = '';
      cy.screenshot(name, {
        capture: 'viewport',
        overwrite: true,
        onAfterScreenshot(_doc, props) {
          retryPath = props.path;
        },
      });
      return cy.then(() => cy.readFile(retryPath, 'base64', { timeout: CAPTURE_READ_TIMEOUT_MS }));
    });
});

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cypress {
    interface Chainable {
      /**
       * Screenshot the viewport and return it as base64 PNG, tolerant of slow /
       * dropped captures under software rendering (one retry + long read).
       */
      captureViewportBase64(name: string): Chainable<string>;
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
      /** Confirm a match pair (OK below the card row; taskVersion 2). */
      confirmSdsMatch(): Chainable<void>;
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
