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
 * Verified against the live demo on 2026-05-29: jsPsych preloads audio via
 * XMLHttpRequest (responseType "arraybuffer"), so both the fetch() and XHR paths
 * are tagged. After clicking through instructions, window.__currentAudioUrl
 * tracked heart-instruct1 -> heart-instruct2 exactly in step with the screens.
 */

export interface AudioWindow extends Window {
  /** URLs of every clip started, in play order. */
  __audioPlayLog?: string[];
  /** The most recently started clip's URL. */
  __currentAudioUrl?: string | null;
  /** The task's asset manifest (key -> URL), exposed by core-tasks. */
  __mediaAssets?: { audio?: Record<string, string> };
}

type XhrWithUrl = XMLHttpRequest & { __mp3Url?: string };

const MP3_RE = /\.mp3(\?|$)/i;

/**
 * Non-speech audio cues (button clicks, coin/fail jingles, silent spacers).
 * These intentionally carry no transcript, so they are treated as "no narration"
 * by the capture helpers and excluded from the transcript content-QA. Verified
 * against the live dev bucket on 2026-05-29.
 */
const NON_SPEECH_AUDIO: ReadonlySet<string> = new Set([
  'coin',
  'fail',
  'select',
  'nullAudio',
  'inputAudioCue',
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

  const abToUrl = new WeakMap<ArrayBuffer, string>();
  const bufToUrl = new WeakMap<AudioBuffer, string>();

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
      return origArrayBuffer.call(this).then((ab) => {
        tag(ab, url);
        return ab;
      });
    };
  }

  // XMLHttpRequest path: jsPsych's audio preloader uses XHR with an arraybuffer
  // response. Remember the URL on open(), then tag the response on load.
  const xhrProto = g.XMLHttpRequest?.prototype;
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
      origOpen.call(this, method, url, async, username ?? null, password ?? null);
    };

    const origSend = xhrProto.send;
    xhrProto.send = function patchedSend(
      this: XhrWithUrl,
      body?: Document | XMLHttpRequestBodyInit | null,
    ): void {
      this.addEventListener('load', () => {
        if (this.response instanceof ArrayBuffer) {
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

  // start() is the moment of playback: record the URL of the buffer being played.
  const srcProto = g.AudioBufferSourceNode?.prototype;
  if (srcProto) {
    const origStart = srcProto.start;
    srcProto.start = function patchedStart(
      this: AudioBufferSourceNode,
      when?: number,
      offset?: number,
      duration?: number,
    ): void {
      const url = this.buffer ? bufToUrl.get(this.buffer) : undefined;
      if (url) {
        g.__currentAudioUrl = url;
        (g.__audioPlayLog ??= []).push(url);
      }
      origStart.call(this, when ?? 0, offset, duration);
    };
  }
}

/**
 * The task's audio asset manifest (key -> URL), if core-tasks exposed it. Useful
 * for a content-QA pass that checks every asset has a transcript tag.
 */
export function audioManifest(win: AudioWindow): Record<string, string> {
  return win.__mediaAssets?.audio ?? {};
}
