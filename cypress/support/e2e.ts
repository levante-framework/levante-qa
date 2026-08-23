import './commands';
import type { AudioWindow } from './audio/audioCapture';
import { installLayoutCapture, type LayoutWindow } from './layout/layoutCapture';

// LEVANTE tasks occasionally throw benign uncaught exceptions (e.g. from audio
// autoplay or third-party libs) that should not fail the QA run. We swallow
// those here so the agent loop can keep driving the task to completion.
// Log them first: a thrown init (empty GCS list, startAssessment) otherwise
// looks like a silent LEVANTE splash because Cypress also auto-dismisses
// the dashboard's "error occurred while starting the task" alert.
Cypress.on('uncaught:exception', (err) => {
  // eslint-disable-next-line no-console
  console.error('[qa-uncaught]', err?.message, err?.stack);
  return false;
});
Cypress.on('window:alert', (text) => {
  // eslint-disable-next-line no-console
  console.error('[qa-alert]', text);
});

// Visual layout overlap capture. Installed for *every* cy.visit (no per-spec
// wiring) so it rides along with whatever the agent is driving and samples the
// live DOM for overlapping tap targets (e.g. buttons drawn on top of each other)
// across every screen, not just the final one. Offenders accumulate on
// `window.__layoutOverlaps`; the guard below asserts on them.
Cypress.on('window:before:load', (win) => installLayoutCapture(win));

// Honor an explicitly-requested resolution. Tasks call the Fullscreen API at the
// OK prompt, after which the layout fills the browser window (landscape) and the
// configured viewport is ignored. So when a specific viewport is requested via
// QA_VIEWPORT_WIDTH/HEIGHT, neuter the Fullscreen API so the task actually
// renders at that size. Default runs (no override) keep real fullscreen.
const requestedW = Number(Cypress.expose('QA_VIEWPORT_WIDTH'));
const requestedH = Number(Cypress.expose('QA_VIEWPORT_HEIGHT'));
if (requestedW > 0 && requestedH > 0) {
  Cypress.on('window:before:load', (win) => {
    const noop = function disabledFullscreen(this: Element): Promise<void> {
      return Promise.resolve();
    };
    try {
      const proto = win.Element.prototype as unknown as Record<string, unknown>;
      proto.requestFullscreen = noop;
      proto.webkitRequestFullscreen = noop;
      proto.mozRequestFullScreen = noop;
      proto.msRequestFullscreen = noop;
    } catch {
      // best effort — never block the run over this
    }
  });
}

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
    ).then(() => {
      expect(
        overlaps.length,
        `overlapping speech audio clips (two narration clips at once — see _${task}_audio_overlap.jsonl)`,
      ).to.equal(0);
    });
  });
});

// Overlapping tap-target guard. The sampler installed above accumulates distinct
// pairs of interactive elements whose painted boxes overlap on screen (e.g. two
// buttons drawn on top of each other — a child mis-taps). After each test (when
// it has not already failed for another reason) we persist the offenders to a
// per-task diagnostic log and fail the run.
afterEach(function layoutOverlapGuard() {
  if (this.currentTest?.state === 'failed') return;
  cy.window({ log: false }).then((w) => {
    const overlaps = (w as LayoutWindow).__layoutOverlaps;
    if (!overlaps || overlaps.length === 0) return;
    const rel = Cypress.spec.relative || '';
    const m = rel.match(/cypress\/e2e\/([^/]+)\//);
    const task = m ? m[1] : 'task';
    cy.task(
      'writeJsonl',
      { path: `cypress/logs/_${task}_layout.jsonl`, records: overlaps },
      { log: false },
    );
    expect(
      overlaps.length,
      `overlapping tap targets (interactive elements drawn on top of each other — see _${task}_layout.jsonl)`,
    ).to.equal(0);
  });
});
