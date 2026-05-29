import type { Mp3Tags } from '../tasks/types';

/**
 * Browser-side wrapper around the node `readMp3Tags` task. The actual fetch +
 * ID3 parse + transcript-precedence logic lives node-side in
 * cypress/plugins/id3Reader.ts (it needs node-id3 and a real network stack);
 * this just hands the URL across the cy.task bridge and types the result.
 */
export function readMp3Tags(url: string): Cypress.Chainable<Mp3Tags> {
  return cy.task<Mp3Tags>('readMp3Tags', url);
}
