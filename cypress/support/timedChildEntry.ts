/**
 * Side-effect entry for timed_child.cy.ts specs. Import this BEFORE `./oracle.cy`
 * so mode is set before the shared spec module initializes.
 */
Cypress.expose('QA_AGENT_MODE', 'timed_child');
