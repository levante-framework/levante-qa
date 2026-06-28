/**
 * Visual layout overlap capture for the tasks under test.
 *
 * The deterministic oracle reads task *state* and the VLM agent is only asked to
 * pick an answer, so neither notices when the rendered UI is broken — e.g. two
 * tap targets drawn on top of each other (overlapping buttons), which causes a
 * child to mis-tap. This installs a small in-page sampler (mirroring
 * installAudioCapture) that periodically scans the live DOM for interactive
 * elements whose painted boxes overlap, and accumulates the offenders on
 * `window.__layoutOverlaps`. The support-file afterEach guard then persists them
 * to a per-task diagnostic log and fails the run.
 *
 * It is deterministic, free, language-agnostic, and runs on every screen the
 * agent visits (the sampler keeps polling for the life of the page), so it
 * catches overlaps mid-task, not just on the final screen.
 */

/** Interactive controls a child taps. Kept to real "buttons"/links by design. */
const TAP_TARGET_SELECTOR = 'button, [role="button"], a[href]';

/** Minimum overlap (px, both axes) before a pair is reported — borders/margins
 * commonly produce 1–2px of sub-pixel touching that is not a real defect. */
const MIN_OVERLAP_PX = 8;

/** How often (ms) to re-scan the DOM for overlaps. */
const SAMPLE_INTERVAL_MS = 750;

export interface TapTarget {
  /** A short, stable-ish description: tag + #id + .class. */
  selector: string;
  /** Trimmed visible text (truncated), useful to identify the control. */
  text: string;
  /** Viewport-relative bounding box, rounded to whole pixels. */
  rect: { x: number; y: number; width: number; height: number };
}

/** Two interactive elements whose painted boxes overlap on screen. */
export interface LayoutOverlap {
  a: TapTarget;
  b: TapTarget;
  /** Size (px) of the overlapping region. */
  overlap: { width: number; height: number };
  /** Wall-clock time (ms) the overlap was first observed. */
  atMs: number;
}

export interface LayoutWindow extends Window {
  /** Distinct overlapping tap-target pairs observed during the run. */
  __layoutOverlaps?: LayoutOverlap[];
  /** Pair signatures already recorded, so the log stays deduped. */
  __layoutSeen?: Set<string>;
  /** Guard so the sampler is installed at most once per window. */
  __layoutCaptureInstalled?: boolean;
}

const round = (n: number): number => Math.round(n);

function isVisible(win: Window, el: Element): boolean {
  const cs = win.getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
  if (Number(cs.opacity) === 0) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function describeElement(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : '';
  const cls =
    el.classList && el.classList.length > 0 ? `.${Array.from(el.classList).slice(0, 2).join('.')}` : '';
  return `${tag}${id}${cls}`;
}

function tapTargetInfo(el: Element): TapTarget {
  const r = el.getBoundingClientRect();
  return {
    selector: describeElement(el),
    text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
    rect: { x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height) },
  };
}

/**
 * Find pairs of visible interactive elements whose painted boxes overlap on the
 * current screen. Ancestor/descendant pairs (a button wrapping an icon) are
 * skipped, and an overlap is only reported when the element actually painted at
 * the shared region is one of the pair — so two transparent containers with
 * overlapping bounding boxes that never visually collide are not flagged.
 */
export function findOverlappingTapTargets(win: Window): LayoutOverlap[] {
  const doc = win.document;
  const visible = Array.from(doc.querySelectorAll(TAP_TARGET_SELECTOR)).filter((el) => isVisible(win, el));
  const out: LayoutOverlap[] = [];

  for (let i = 0; i < visible.length; i += 1) {
    for (let j = i + 1; j < visible.length; j += 1) {
      const a = visible[i];
      const b = visible[j];
      if (a.contains(b) || b.contains(a)) continue;

      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const overlapW = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const overlapH = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (overlapW < MIN_OVERLAP_PX || overlapH < MIN_OVERLAP_PX) continue;

      // Confirm the two controls genuinely stack at the shared region.
      const cx = Math.max(ra.left, rb.left) + overlapW / 2;
      const cy = Math.max(ra.top, rb.top) + overlapH / 2;
      const hit = doc.elementFromPoint(cx, cy);
      if (!hit) continue;
      const stacks = hit === a || hit === b || a.contains(hit) || b.contains(hit);
      if (!stacks) continue;

      out.push({
        a: tapTargetInfo(a),
        b: tapTargetInfo(b),
        overlap: { width: round(overlapW), height: round(overlapH) },
        atMs: Date.now(),
      });
    }
  }
  return out;
}

function overlapSignature(o: LayoutOverlap): string {
  return [o.a.selector, o.b.selector].sort().join(' :: ');
}

/**
 * Patch the AUT window to sample the DOM for overlapping tap targets for the life
 * of the page. Idempotent; pass to cy.visit's onBeforeLoad, or register globally
 * via Cypress.on('window:before:load', installLayoutCapture).
 */
export function installLayoutCapture(win: Window): void {
  const g = win as LayoutWindow;
  if (g.__layoutCaptureInstalled) return;
  g.__layoutCaptureInstalled = true;
  g.__layoutOverlaps = [];
  const seen = new Set<string>();
  g.__layoutSeen = seen;

  const sample = (): void => {
    try {
      for (const overlap of findOverlappingTapTargets(win)) {
        const sig = overlapSignature(overlap);
        if (seen.has(sig)) continue;
        seen.add(sig);
        (g.__layoutOverlaps ??= []).push(overlap);
      }
    } catch {
      // The sampler must never break the task it is observing.
    }
  };

  win.setInterval(sample, SAMPLE_INTERVAL_MS);
}
