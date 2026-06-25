import { rewriteAudioFileUrl, rewriteAudioListingUrl } from './audio/audioAssetRewrite';

type TranslationMap = Record<string, string>;

interface CrowdinApprovedTranslationsPayload {
  language: string;
  source: 'crowdin-approved';
  translationsByTask: Record<string, TranslationMap>;
}

function enabled(): boolean {
  return String(Cypress.expose('QA_TRANSLATIONS_SOURCE') ?? '').toLowerCase() === 'crowdin-approved';
}

function qaLanguage(): string {
  return String(Cypress.expose('QA_LANGUAGE') ?? '').trim();
}

function projectId(): string | undefined {
  const value = String(Cypress.expose('QA_CROWDIN_PROJECT_ID') ?? '').trim();
  return value || undefined;
}

function cachePath(): string | undefined {
  const value = String(Cypress.expose('QA_CROWDIN_CACHE_PATH') ?? '').trim();
  return value || undefined;
}

function refresh(): boolean {
  return /^(1|true|yes)$/i.test(String(Cypress.expose('QA_CROWDIN_REFRESH') ?? ''));
}

function audioFallbackLanguage(): string | null {
  const value = String(Cypress.expose('QA_AUDIO_FALLBACK_LANGUAGE') ?? '').trim();
  return value || null;
}

/** Target bucket for audio assets (e.g. `levante-assets-draft`), or null. */
function audioBucket(): string | null {
  const value = String(Cypress.expose('QA_AUDIO_BUCKET') ?? '').trim();
  return value || null;
}

/**
 * A short silent PCM WAV as an ArrayBuffer. Built in-memory (rather than served
 * from a fixture) so the exact bytes reach the browser unmangled — Cypress reads
 * fixtures with an extension-derived encoding and corrupts binary it doesn't
 * recognize. Web Audio's decodeAudioData sniffs the RIFF/WAVE header, so the
 * `.mp3` request URL is irrelevant.
 */
function silentWavBytes(): ArrayBuffer {
  const sampleRate = 44100;
  const numSamples = Math.floor(sampleRate * 0.2);
  const dataSize = numSamples * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(buf);
  const writeStr = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i += 1) dv.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  dv.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  writeStr(36, 'data');
  dv.setUint32(40, dataSize, true);
  // Sample region is left zero-filled (silence).
  return buf;
}

/**
 * Reference locale to source the audio *file list* from when serving silent
 * placeholders, or null when placeholder mode is off. Enables behavioral testing
 * of a task whose narration mp3s don't exist yet (e.g. Dutch vocab): the app
 * still discovers and "plays" every clip, while the spoken word comes from the
 * Crowdin-approved translation text (the same text the real mp3 will be generated
 * from). `QA_AUDIO_PLACEHOLDER=1` defaults the reference to `en-US`; an explicit
 * locale (e.g. `en-US`) is used as-is. The reference must have full audio
 * coverage in the dev bucket so the rewritten listing names every expected clip.
 */
function audioPlaceholderRef(): string | null {
  const value = String(Cypress.expose('QA_AUDIO_PLACEHOLDER') ?? '').trim();
  if (!value) return null;
  return /^(1|true|yes)$/i.test(value) ? 'en-US' : value;
}

function taskFromTranslationUrl(url: string): string | null {
  const match = /\/translations\/itembank\/([^/?#]+)\/[^/?#]+\/item-bank-translations\.json/.exec(url);
  return match?.[1] ?? null;
}

/**
 * Redirect the app's audio-asset requests to a different bucket and/or locale
 * folder than core-tasks hard-codes. The app requests
 * `levante-assets-dev/audio/<QA_LANGUAGE>/…`; this can serve them from
 * `QA_AUDIO_BUCKET` (e.g. `levante-assets-draft`) under `QA_AUDIO_FALLBACK_LANGUAGE`
 * (e.g. `nl-NL`). Returned listing names are rewritten back to the requested
 * locale so the app's subsequent file requests still match the file intercept.
 *
 * No-op unless a bucket override or a distinct fallback locale is configured.
 * Exported so it applies to every launch, independent of crowdin-approved text.
 */
export function installAudioAssetIntercept(): void {
  const language = qaLanguage();
  if (!language) return;
  const bucket = audioBucket();
  const sourceLang = audioFallbackLanguage() ?? language;
  const langSwap = sourceLang !== language;
  const placeholderRef = audioPlaceholderRef();
  if (!bucket && !langSwap && !placeholderRef) return;

  // The app discovers a locale's clips by listing the bucket, then requests each
  // listed file. In placeholder mode we source that list from a fully-covered
  // reference locale in the dev bucket (so every expected clip is named), then
  // map the names to the requested locale; the file intercept below answers each
  // with a silent mp3. Otherwise we forward the listing to the override bucket/
  // locale (audio that really exists elsewhere, e.g. the draft bucket).
  cy.intercept('GET', '**/storage/v1/b/*/o?prefix=audio/**', async (req) => {
    const url = new URL(req.url);
    const prefix = url.searchParams.get('prefix') ?? '';
    if (!prefix.startsWith(`audio/${language}/`)) {
      req.continue();
      return;
    }
    const fromLang = placeholderRef ?? sourceLang;
    const swap = fromLang !== language;
    if (swap) {
      url.searchParams.set('prefix', prefix.replace(`audio/${language}/`, `audio/${fromLang}/`));
    }
    // Placeholder lists from the dev bucket (where the reference locale lives);
    // the redirect path lists from the configured override bucket.
    const listingBucket = placeholderRef ? 'levante-assets-dev' : bucket;
    const fetchUrl = rewriteAudioListingUrl(url.toString(), listingBucket);
    const response = await fetch(fetchUrl);
    const body = await response.json();
    const rewritten = {
      ...body,
      items: (body.items ?? []).map((item: { name?: string }) => ({
        ...item,
        // Map names back to the requested locale so the app builds
        // `audio/<language>/…` URLs that the file intercept below catches.
        name: swap ? item.name?.replace(`audio/${fromLang}/`, `audio/${language}/`) : item.name,
      })),
    };
    req.reply({ statusCode: response.status, body: rewritten });
  });

  // Placeholder mode: answer every clip with a valid silent mp3 (+ CORS) so the
  // app's all-or-nothing preloader succeeds and each clip "plays" (logging its
  // URL); the transcript then comes from the Crowdin-approved text, not the audio.
  if (placeholderRef) {
    const silentBody = silentWavBytes();
    cy.intercept('GET', `**/audio/${language}/*.mp3*`, (req) => {
      req.reply({
        statusCode: 200,
        headers: { 'access-control-allow-origin': '*', 'content-type': 'audio/wav' },
        body: silentBody,
      });
    });
    return;
  }

  // A unique-per-process token appended to redirected audio URLs. GCS adds CORS
  // headers per-request, but a no-CORS response cached (by the browser or an
  // intermediary keyed on URL without `Vary: Origin`) before the bucket's CORS
  // policy propagated will keep being served stale — and the app's preloader is
  // all-or-nothing, so one stale clip aborts the whole task. Busting the cache
  // key forces a fresh fetch that carries the now-present CORS headers.
  const cacheBust = `qa_cb=${Date.now()}`;
  cy.intercept('GET', `**/audio/${language}/*.mp3*`, (req) => {
    const target = rewriteAudioFileUrl(req.url, { bucket, fromLang: language, toLang: sourceLang });
    if (target !== req.url) {
      const sep = target.includes('?') ? '&' : '?';
      req.redirect(`${target}${sep}${cacheBust}`, 302);
    } else req.continue();
  });
}

export function installCrowdinApprovedTranslationIntercept(): void {
  if (!enabled()) return;
  const language = qaLanguage();
  expect(language, 'QA_LANGUAGE is required for QA_TRANSLATIONS_SOURCE=crowdin-approved').to.not.equal('');

  cy.task<CrowdinApprovedTranslationsPayload>('loadCrowdinApprovedTranslations', {
    language,
    projectId: projectId(),
    cachePath: cachePath(),
    refresh: refresh(),
  }).then((payload) => {
    cy.intercept('GET', '**/translations/itembank/**/item-bank-translations.json', (req) => {
      const task = taskFromTranslationUrl(req.url);
      const translations = task ? payload.translationsByTask[task] : null;
      if (!translations) req.continue();
      else {
        req.continue((res) => {
          if (res.statusCode >= 200 && res.statusCode < 300 && res.body && typeof res.body === 'object') {
            res.body = { ...(res.body as TranslationMap), ...translations };
          } else {
            res.send({ statusCode: 200, body: translations });
          }
        });
      }
    });
  });
}
