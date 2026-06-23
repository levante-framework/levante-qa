import { rewriteAudioFileUrl, rewriteAudioListingUrl } from './audio/audioAssetRewrite';

type TranslationMap = Record<string, string>;

interface CrowdinApprovedTranslationsPayload {
  language: string;
  source: 'crowdin-approved';
  translationsByTask: Record<string, TranslationMap>;
}

function enabled(): boolean {
  return String(Cypress.env('QA_TRANSLATIONS_SOURCE') ?? '').toLowerCase() === 'crowdin-approved';
}

function qaLanguage(): string {
  return String(Cypress.env('QA_LANGUAGE') ?? '').trim();
}

function projectId(): string | undefined {
  const value = String(Cypress.env('QA_CROWDIN_PROJECT_ID') ?? '').trim();
  return value || undefined;
}

function cachePath(): string | undefined {
  const value = String(Cypress.env('QA_CROWDIN_CACHE_PATH') ?? '').trim();
  return value || undefined;
}

function refresh(): boolean {
  return /^(1|true|yes)$/i.test(String(Cypress.env('QA_CROWDIN_REFRESH') ?? ''));
}

function audioFallbackLanguage(): string | null {
  const value = String(Cypress.env('QA_AUDIO_FALLBACK_LANGUAGE') ?? '').trim();
  return value || null;
}

/** Target bucket for audio assets (e.g. `levante-assets-draft`), or null. */
function audioBucket(): string | null {
  const value = String(Cypress.env('QA_AUDIO_BUCKET') ?? '').trim();
  return value || null;
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
  if (!bucket && !langSwap) return;

  cy.intercept('GET', '**/storage/v1/b/*/o?prefix=audio/**', async (req) => {
    const url = new URL(req.url);
    const prefix = url.searchParams.get('prefix') ?? '';
    if (!prefix.startsWith(`audio/${language}/`)) {
      req.continue();
      return;
    }
    if (langSwap) {
      url.searchParams.set('prefix', prefix.replace(`audio/${language}/`, `audio/${sourceLang}/`));
    }
    const fetchUrl = rewriteAudioListingUrl(url.toString(), bucket);
    const response = await fetch(fetchUrl);
    const body = await response.json();
    const rewritten = {
      ...body,
      items: (body.items ?? []).map((item: { name?: string }) => ({
        ...item,
        // Map names back to the requested locale so the app builds
        // `audio/<language>/…` URLs that the file intercept below catches.
        name: langSwap ? item.name?.replace(`audio/${sourceLang}/`, `audio/${language}/`) : item.name,
      })),
    };
    req.reply({ statusCode: response.status, body: rewritten });
  });

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
