/**
 * Side-effect entry for random_agent.cy.ts specs. Import this BEFORE
 * `./oracle.cy` so mode is set before the shared spec module initializes.
 */
Cypress.expose('QA_AGENT_MODE', 'random');
