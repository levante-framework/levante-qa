/**
 * Track jsPsych preload fetches (XHR audio + Image src) so a stuck progress
 * bar can name the URL that never finished.
 */
export type PreloadEvent = { url: string; kind: 'xhr' | 'img'; ms?: number; status?: number; err?: string };

export type PreloadDump = {
  href: string;
  splash: boolean;
  jspsych: boolean;
  inFlightN: number;
  inFlight: { url: string; kind: string; waitedMs: number }[];
  doneN: number;
  errorN: number;
  errors: PreloadEvent[];
  failed: PreloadEvent[];
  mediaAssetCounts?: { images?: number; audio?: number; video?: number };
};

type ProbeWin = Window & {
  __qaPreload?: {
    started: Map<string, { t0: number; kind: 'xhr' | 'img' }>;
    done: PreloadEvent[];
    errors: PreloadEvent[];
  };
  __mediaAssets?: { images?: Record<string, string>; audio?: Record<string, string>; video?: Record<string, string> };
};

function bucket(win: ProbeWin) {
  if (!win.__qaPreload) {
    win.__qaPreload = { started: new Map(), done: [], errors: [] };
  }
  return win.__qaPreload;
}

function trackXhr(win: ProbeWin) {
  const proto = win.XMLHttpRequest?.prototype;
  if (!proto) return;
  const origOpen = proto.open;
  proto.open = function patchedOpen(
    this: XMLHttpRequest & { __qaUrl?: string },
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ) {
    this.__qaUrl = String(url);
    return origOpen.call(this, method, url, async, username, password);
  };
  const origSend = proto.send;
  proto.send = function patchedSend(this: XMLHttpRequest & { __qaUrl?: string }, body?: Document | XMLHttpRequestBodyInit | null) {
    const url = this.__qaUrl || '';
    if (/storage\.googleapis\.com/.test(url)) {
      const t0 = Date.now();
      const b = bucket(win);
      b.started.set(url, { t0, kind: 'xhr' });
      const finish = (ok: boolean, status?: number, err?: string) => {
        if (!b.started.has(url)) return;
        b.started.delete(url);
        const ev: PreloadEvent = { url, kind: 'xhr', ms: Date.now() - t0, status, err };
        if (ok) b.done.push(ev);
        else b.errors.push(ev);
      };
      this.addEventListener('load', () => finish(this.status >= 200 && this.status < 400, this.status));
      this.addEventListener('error', () => finish(false, this.status, 'error'));
      this.addEventListener('timeout', () => finish(false, this.status, 'timeout'));
      this.addEventListener('abort', () => finish(false, this.status, 'abort'));
    }
    return origSend.call(this, body ?? null);
  };
}

function trackImages(win: ProbeWin) {
  const proto = win.HTMLImageElement?.prototype;
  if (!proto) return;
  const desc = Object.getOwnPropertyDescriptor(proto, 'src');
  if (!desc?.set || !desc.get) return;
  Object.defineProperty(proto, 'src', {
    configurable: true,
    get: desc.get,
    set(this: HTMLImageElement, value: string) {
      const url = String(value || '');
      desc.set!.call(this, value);
      if (!/storage\.googleapis\.com/.test(url)) return;
      const t0 = Date.now();
      const b = bucket(win);
      b.started.set(`img:${url}`, { t0, kind: 'img' });
      const finish = (ok: boolean, err?: string) => {
        if (!b.started.has(`img:${url}`)) return;
        b.started.delete(`img:${url}`);
        const ev: PreloadEvent = { url, kind: 'img', ms: Date.now() - t0, err };
        if (ok) b.done.push(ev);
        else b.errors.push(ev);
      };
      this.addEventListener('load', () => finish(true), { once: true });
      this.addEventListener('error', () => finish(false, 'error'), { once: true });
    },
  });
}

export function installPreloadProbe(win: Window): void {
  const w = win as ProbeWin;
  bucket(w);
  trackXhr(w);
  trackImages(w);
}

export function dumpPreloadProbe(win: Window): PreloadDump {
  const w = win as ProbeWin;
  const b = w.__qaPreload;
  const now = Date.now();
  const inFlight = b
    ? [...b.started.entries()]
        .map(([key, { t0, kind }]) => ({
          url: key.replace(/^img:/, ''),
          kind,
          waitedMs: now - t0,
        }))
        .sort((a, c) => c.waitedMs - a.waitedMs)
    : [];
  const media = w.__mediaAssets;
  return {
    href: w.location.href,
    splash: Boolean(w.document.getElementById('levante-logo-loading')),
    jspsych: Boolean(w.document.querySelector('.jspsych-content-wrapper')),
    inFlightN: inFlight.length,
    inFlight: inFlight.slice(0, 25),
    doneN: b?.done.length ?? 0,
    errorN: b?.errors.length ?? 0,
    errors: (b?.errors ?? []).slice(0, 25),
    failed: (b?.done ?? []).filter((e) => e.status != null && e.status >= 400).slice(0, 25),
    mediaAssetCounts: media
      ? {
          images: media.images ? Object.keys(media.images).length : 0,
          audio: media.audio ? Object.keys(media.audio).length : 0,
          video: media.video ? Object.keys(media.video).length : 0,
        }
      : undefined,
  };
}
