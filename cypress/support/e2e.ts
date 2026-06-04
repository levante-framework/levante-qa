import './commands';
import type { AudioWindow } from './audio/audioCapture';

// LEVANTE tasks occasionally throw benign uncaught exceptions (e.g. from audio
// autoplay or third-party libs) that should not fail the QA run. We swallow
// those here so the agent loop can keep driving the task to completion.
Cypress.on('uncaught:exception', () => {
  return false;
});

// Speech-on-speech audio overlap guard. Any spec that installs the audio capture
// (installAudioCapture) accumulates `__audioOverlaps` on the AUT window whenever
// two narration clips play at once — confusing to a child. After each such test
// (when it has not already failed for another reason) we persist the offenders
// to a per-task diagnostic log and fail the run. Specs without audio capture
// leave `__audioOverlaps` undefined and are skipped.
afterEach(function audioOverlapGuard() {
  if (this.currentTest?.state === 'failed') return;
  cy.window({ log: false }).then((w) => {
    const overlaps = (w as AudioWindow).__audioOverlaps;
    if (!overlaps || overlaps.length === 0) return;
    const rel = Cypress.spec.relative || '';
    const m = rel.match(/cypress\/e2e\/([^/]+)\//);
    const task = m ? m[1] : 'task';
    cy.task(
      'writeJsonl',
      { path: `cypress/logs/_${task}_audio_overlap.jsonl`, records: overlaps },
      { log: false },
    );
    expect(
      overlaps.length,
      `overlapping speech audio clips (two narration clips at once — see _${task}_audio_overlap.jsonl)`,
    ).to.equal(0);
  });
});
