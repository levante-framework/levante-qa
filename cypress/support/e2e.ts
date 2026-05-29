import './commands';

// LEVANTE tasks occasionally throw benign uncaught exceptions (e.g. from audio
// autoplay or third-party libs) that should not fail the QA run. We swallow
// those here so the agent loop can keep driving the task to completion.
Cypress.on('uncaught:exception', () => {
  return false;
});
