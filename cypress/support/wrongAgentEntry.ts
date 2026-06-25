/**
 * Side-effect entry for wrong_agent.cy.ts specs. Import this BEFORE `./oracle.cy`
 * so mode is set before the shared spec module initializes.
 */
Cypress.expose('QA_AGENT_MODE', 'wrong');
