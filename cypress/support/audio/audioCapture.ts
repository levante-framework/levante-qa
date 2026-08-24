/**
 * Audio playback capture for jsPsych tasks.
 *
 * The LEVANTE tasks preload every audio asset up front and then play them via
 * the Web Audio API (PageAudioHandler -> AudioBufferSourceNode), so a network
 * intercept only sees the preload burst, not which clip is playing *now*. To get
 * a reliable "currently playing" signal we install (in cy.visit's onBeforeLoad,
 * before the app's own scripts run) a small monkeypatch that links each fetched
 * mp3 to its decoded AudioBuffer, then records the URL whenever a buffer is
 * started.
 *
 * Verified against the live demo on 2026-05-29: jsPsych preloads every clip via
 * XMLHttpRequest with responseType "arraybuffer", reading xhr.response inside its
 * own onload and decoding it synchronously. Two subtleties make this tricky and
 * are handled below:
 *   1. Ordering — jsPsych's onload runs before any 'load' listener we add in
 *      send(), so we tag the buffer from an instance-level `response` getter,
 *      which fires the moment jsPsych reads it (before the decode that follows).
 *   2. Realms — the AUT runs in a separate frame from the Cypress spec, so its
 *      buffers are not `instanceof` our ArrayBuffer; see isArrayBuffer().
 * With both in place, window.__currentAudioUrl tracks the playing clip exactly
 * in step with the screens.
 */

export interface AudioWindow extends Window {
  /** URLs of every clip started, in play order. */
  __audioPlayLog?: string[];
  /** The most recently started clip's URL. */
  __currentAudioUrl?: string | null;
  /** Speech-on-speech overlaps detected during the run. */
  __audioOverlaps?: AudioOverlap[];
  /** The task's asset manifest (key -> URL), exposed by core-tasks. */
  __mediaAssets?: { audio?: Record<string, string> };
  /** Count of speech (non-cue) clips currently playing — polled by waitUntilSpeechIdle. */
  __speechActiveCount?: number;
}

/**
 * A moment where one narration clip started while another was still audible —
 * two voices talking over each other, which is confusing to a child. Non-speech
 * cues (clicks, jingles) never participate.
 */
export interface AudioOverlap {
  /** The clip that started while another was already playing. */
  url: string;
  /** A clip that was still playing when `url` started. */
  against: string;
  /** Wall-clock time (ms) the overlap was confirmed. */
  atMs: number;
  /** Grace window (ms) the overlap had to persist past to be reported. */
  sustainedMs: number;
}

type XhrWithUrl = XMLHttpRequest & { __mp3Url?: string };

const MP3_RE = /\.mp3(\?|$)/i;

/** Ignore clip swaps shorter than this (ms). Override with `QA_AUDIO_OVERLAP_MS`. */
export const DEFAULT_AUDIO_OVERLAP_MS = 100;

/** How long two speech clips must overlap before we treat it as speech-on-speech. */
export function audioOverlapMs(): number {
  const raw = String(Cypress.expose?.('QA_AUDIO_OVERLAP_MS') ?? '').trim();
  if (!raw) return DEFAULT_AUDIO_OVERLAP_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_AUDIO_OVERLAP_MS;
}

/**
 * Non-speech audio cues (button clicks, coin/fail jingles, silent spacers).
 * These intentionally carry no transcript, so they are treated as "no narration"
 * by the capture helpers and excluded from the transcript content-QA. This is
 * the full contents of the locale-independent `audio/shared/` bucket folder —
 * nothing served from there is speech, so a new cue landing in that folder
 * belongs here. Verified against the live dev bucket on 2026-07-29.
 */
const NON_SPEECH_AUDIO: ReadonlySet<string> = new Set([
  'coin',
  'fail',
  'select',
  'nullAudio',
  'inputAudioCue',
  'pop',
]);

/** Filename (without extension) of an audio URL, e.g. ".../heart-instruct1.mp3" -> "heart-instruct1". */
export function audioBasename(url: string): string {
  const file = url.split('?')[0]?.split('/').pop() ?? '';
  return file.replace(/\.mp3$/i, '');
}

/** True for non-speech cue clips that legitimately have no transcript. */
export function isNonSpeechAudio(url: string): boolean {
  return NON_SPEECH_AUDIO.has(audioBasename(url));
}

/**
 * Patch the AUT window's audio pipeline to expose the currently-playing clip.
 * Idempotent: safe to call once per visit. Pass directly to cy.visit:
 *   cy.visit(url, { onBeforeLoad: installAudioCapture })
 */
export function installAudioCapture(win: Window): void {
  // Global constructors live on (Window & typeof globalThis); narrow once so we
  // can read Response/XMLHttpRequest/AudioContext etc. without `any`.
  const g = win as Window & typeof globalThis & AudioWindow;

  g.__audioPlayLog = [];
  g.__currentAudioUrl = null;
  g.__audioOverlaps = [];
  g.__speechActiveCount = 0;

  const abToUrl = new WeakMap<ArrayBuffer, string>();
  const bufToUrl = new WeakMap<AudioBuffer, string>();

  // Realm-safe ArrayBuffer check: the AUT runs in a separate frame from the
  // spec, so the buffers it creates are NOT instanceof *our* ArrayBuffer.
  // Comparing against the AUT window's constructor (with a tag-string fallback)
  // is the only reliable test across realms.
  const isArrayBuffer = (v: unknown): v is ArrayBuffer =>
    v instanceof g.ArrayBuffer || Object.prototype.toString.call(v) === '[object ArrayBuffer]';

  const tag = (ab: ArrayBuffer, url: string | undefined): void => {
    if (url && MP3_RE.test(url)) {
      abToUrl.set(ab, url);
    }
  };

  // fetch() path: tag the ArrayBuffer a Response yields with the request URL.
  const responseProto = g.Response?.prototype;
  if (responseProto) {
    const origArrayBuffer = responseProto.arrayBuffer;
    responseProto.arrayBuffer = function patchedArrayBuffer(this: Response): Promise<ArrayBuffer> {
      const url = this.url;
      return origArrayBuffer.call(this).then((ab: ArrayBuffer) => {
        tag(ab, url);
        return ab;
      });
    };
  }

  // XMLHttpRequest path: jsPsych's audio preloader uses XHR with an arraybuffer
  // response. Remember the URL on open(). The buffer must be tagged *before*
  // jsPsych decodes it, but jsPsych's own onload (registered at setup) runs
  // before any 'load' listener we add in send(), and it reads xhr.response and
  // calls decodeAudioData synchronously. So instead of a load listener we shadow
  // the instance's `response` getter: the buffer is tagged the moment jsPsych
  // reads it, guaranteeing the tag is in place before the decode that follows.
  const xhrProto = g.XMLHttpRequest?.prototype;
  // `response` is an accessor on XMLHttpRequest.prototype; find its getter.
  const responseGetter = ((): ((this: XMLHttpRequest) => unknown) | undefined => {
    let proto: object | null = xhrProto ?? null;
    while (proto) {
      const desc = Object.getOwnPropertyDescriptor(proto, 'response');
      if (desc?.get) {
        return desc.get as (this: XMLHttpRequest) => unknown;
      }
      proto = Object.getPrototypeOf(proto) as object | null;
    }
    return undefined;
  })();
  if (xhrProto) {
    // open() is overloaded; pin a single call signature so .call type-checks.
    const origOpen: (
      method: string,
      url: string | URL,
      async?: boolean,
      username?: string | null,
      password?: string | null,
    ) => void = xhrProto.open;
    xhrProto.open = function patchedOpen(
      this: XhrWithUrl,
      method: string,
      url: string | URL,
      async: boolean = true,
      username?: string | null,
      password?: string | null,
    ): void {
      this.__mp3Url = String(url);
      // Shadow `response` on this instance so the buffer is tagged on first read.
      if (responseGetter && MP3_RE.test(this.__mp3Url)) {
        Object.defineProperty(this, 'response', {
          configurable: true,
          get(this: XhrWithUrl): unknown {
            const value = responseGetter.call(this);
            if (isArrayBuffer(value)) {
              tag(value, this.__mp3Url);
            }
            return value;
          },
        });
      }
      origOpen.call(this, method, url, async, username ?? null, password ?? null);
    };

    const origSend = xhrProto.send;
    xhrProto.send = function patchedSend(
      this: XhrWithUrl,
      body?: Document | XMLHttpRequestBodyInit | null,
    ): void {
      // Fallback for any code path that reads the buffer without going through
      // the shadowed getter (harmless duplicate tagging is idempotent).
      this.addEventListener('load', () => {
        if (isArrayBuffer(this.response)) {
          tag(this.response, this.__mp3Url);
        }
      });
      origSend.call(this, body ?? null);
    };
  }

  // decodeAudioData links the decoded AudioBuffer back to its source URL. Modern
  // browsers resolve the returned promise with the buffer even in callback form,
  // but we also wrap the success callback to be safe across implementations.
  const ctxProto = g.BaseAudioContext?.prototype ?? g.AudioContext?.prototype;
  if (ctxProto) {
    const origDecode = ctxProto.decodeAudioData;
    ctxProto.decodeAudioData = function patchedDecode(
      this: BaseAudioContext,
      data: ArrayBuffer,
      success?: DecodeSuccessCallback | null,
      error?: DecodeErrorCallback | null,
    ): Promise<AudioBuffer> {
      const url = abToUrl.get(data);
      const link = (buf: AudioBuffer): void => {
        if (url) {
          bufToUrl.set(buf, url);
        }
      };
      const wrappedSuccess: DecodeSuccessCallback | null = success
        ? (buf) => {
            link(buf);
            success(buf);
          }
        : null;
      return origDecode.call(this, data, wrappedSuccess, error ?? null).then((buf) => {
        link(buf);
        return buf;
      });
    };
  }

  // start() is the moment of playback: record the URL of the buffer being played,
  // and watch for two *speech* clips sounding at once. A short grace window
  // avoids false positives from the common "start the new clip, then
  // synchronously stop the old one" reorder used to swap narration: by the time
  // the check runs, a genuinely-swapped clip has already been removed, while a
  // real overlap (the old clip left playing) is still active.
  //
  // Also resume a suspended AudioContext before start(). Under Cypress/Chrome
  // headless the context often stays "suspended" (core-tasks only unlocks it on
  // touchscreen fullscreen Continue). A suspended context accepts start() but
  // never fires onended — so instruction OK buttons that wait on narration stay
  // disabled forever.
  const activeSpeech = new Map<AudioBufferSourceNode, string>();
  const syncSpeechCount = (): void => {
    g.__speechActiveCount = activeSpeech.size;
  };
  const OVERLAP_GRACE_MS = audioOverlapMs();
  const srcProto = g.AudioBufferSourceNode?.prototype;
  if (srcProto) {
    const origStart = srcProto.start;
    srcProto.start = function patchedStart(
      this: AudioBufferSourceNode,
      when?: number,
      offset?: number,
      duration?: number,
    ): void {
      const ctx = this.context as AudioContext;
      if (ctx.state === 'suspended') {
        void ctx.resume();
      }

      const url = this.buffer ? bufToUrl.get(this.buffer) : undefined;
      if (url) {
        g.__currentAudioUrl = url;
        (g.__audioPlayLog ??= []).push(url);

        if (!isNonSpeechAudio(url)) {
          const hadOthers = activeSpeech.size > 0;
          activeSpeech.set(this, url);
          syncSpeechCount();
          // Arrow callbacks capture `this` (the source node) lexically.
          this.addEventListener('ended', () => {
            activeSpeech.delete(this);
            syncSpeechCount();
          });
          if (hadOthers) {
            g.setTimeout(() => {
              if (!activeSpeech.has(this)) return; // this clip already finished
              for (const [other, otherUrl] of activeSpeech) {
                if (other !== this) {
                  (g.__audioOverlaps ??= []).push({
                    url,
                    against: otherUrl,
                    atMs: Date.now(),
                    sustainedMs: OVERLAP_GRACE_MS,
                  });
                  break; // one event per offending start is enough
                }
              }
            }, OVERLAP_GRACE_MS);
          }
        }
      }
      origStart.call(this, when ?? 0, offset, duration);
    };

    // stop() must remove the node synchronously so a "start new → stop old" swap
    // in the same tick does not look like an overlap when the grace check runs.
    const origStop = srcProto.stop;
    srcProto.stop = function patchedStop(this: AudioBufferSourceNode, when?: number): void {
      activeSpeech.delete(this);
      syncSpeechCount();
      origStop.call(this, when ?? 0);
    };
  }
}

/** Current speech-clip count on the AUT window (0 when idle / capture not installed). */
export function speechActiveCount(win: AudioWindow): number {
  return win.__speechActiveCount ?? 0;
}

/**
 * Wait for narration timing realism: optionally wait for speech to start (short
 * grace), then until no speech clips are active, then a brief settle. Screens
 * with no speech proceed after the start grace so the agent does not hang.
 */
export function waitUntilSpeechIdle(opts?: {
  startGraceMs?: number;
  idleTimeoutMs?: number;
  settleMs?: number;
}): Cypress.Chainable<null> {
  const startGraceMs = opts?.startGraceMs ?? 3_000;
  const idleTimeoutMs = opts?.idleTimeoutMs ?? 45_000;
  const settleMs = opts?.settleMs ?? 150;

  const startDeadline = Date.now() + startGraceMs;

  const waitIdle = (idleDeadline: number): Cypress.Chainable<null> =>
    cy.window({ log: false }).then((win) => {
      if (speechActiveCount(win as AudioWindow) === 0) {
        return cy.wrap(null, { log: false });
      }
      if (Date.now() > idleDeadline) {
        return cy.wrap(null, { log: false });
      }
      return cy.wait(50, { log: false }).then(() => waitIdle(idleDeadline));
    });

  const waitStartOrGrace = (): Cypress.Chainable<null> =>
    cy.window({ log: false }).then((win) => {
      if (speechActiveCount(win as AudioWindow) > 0) {
        return waitIdle(Date.now() + idleTimeoutMs);
      }
      if (Date.now() > startDeadline) {
        return cy.wrap(null, { log: false });
      }
      return cy.wait(50, { log: false }).then(() => waitStartOrGrace());
    });

  return waitStartOrGrace().then(() => {
    if (settleMs > 0) return cy.wait(settleMs, { log: false }).then(() => null);
    return cy.wrap(null, { log: false });
  });
}

/**
 * The task's audio asset manifest (key -> URL), if core-tasks exposed it. Useful
 * for a content-QA pass that checks every asset has a transcript tag.
 */
export function audioManifest(win: AudioWindow): Record<string, string> {
  return win.__mediaAssets?.audio ?? {};
}
