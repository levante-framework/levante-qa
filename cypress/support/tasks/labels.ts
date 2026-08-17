/**
 * Localized chrome labels shared across jsPsych tasks. English plus the
 * German / Spanish words the dashboard actually paints on Exit and Continue.
 */

/** Task-finished button (Stories already accepted these; siblings did not). */
export const EXIT_LABEL = /^\s*(exit|salir|beenden|ausgang|terminar|fertig)\s*$/i;

/** Fullscreen / intro / break continue (not always the literal "OK"). */
export const START_CONTINUE_LABEL =
  /^(ok|continue|next|aceptar|continuar|siguiente|weiter)$/i;
