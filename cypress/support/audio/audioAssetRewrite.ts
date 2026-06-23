/**
 * Shared (browser- and node-safe) rewriting of LEVANTE audio asset URLs so a run
 * can pull narration from a different GCS bucket and/or locale folder than the
 * one core-tasks hard-codes.
 *
 * Motivating case: Dutch (`nl`) narration is published to the **draft** bucket
 * under `audio/nl-NL/`, but the deployed core-tasks always requests
 * `levante-assets-dev/audio/<QA_LANGUAGE>/…` and has no `nl → nl-NL` remap. With
 *   QA_AUDIO_BUCKET=levante-assets-draft
 *   QA_LANGUAGE=nl
 *   QA_AUDIO_FALLBACK_LANGUAGE=nl-NL
 * an app request for `…/levante-assets-dev/audio/nl/foo.mp3` is rewritten to
 * `…/levante-assets-draft/audio/nl-NL/foo.mp3`.
 *
 * Both functions are pure and no-op when the relevant override is absent, so the
 * default (dev bucket, same locale) behaviour is unchanged.
 */
export interface AudioRewrite {
  /** Target bucket (e.g. `levante-assets-draft`); null keeps the requested one. */
  bucket: string | null;
  /** Locale folder the app requests (= QA_LANGUAGE, e.g. `nl`). */
  fromLang: string | null;
  /** Locale folder that actually holds the assets (e.g. `nl-NL`). */
  toLang: string | null;
}

function swapLangSegment(url: string, fromLang: string | null, toLang: string | null): string {
  if (!fromLang || !toLang || fromLang === toLang) return url;
  return url.replace(`/audio/${fromLang}/`, `/audio/${toLang}/`);
}

/**
 * Rewrite a direct object URL of the form
 * `https://storage.googleapis.com/<bucket>/audio/<lang>/<file>.mp3`.
 */
export function rewriteAudioFileUrl(url: string, rw: AudioRewrite): string {
  let out = swapLangSegment(url, rw.fromLang, rw.toLang);
  if (rw.bucket) {
    // Swap only the bucket segment that immediately precedes `/audio/`.
    out = out.replace(/(\/\/storage\.googleapis\.com\/)[^/]+(\/audio\/)/, `$1${rw.bucket}$2`);
  }
  return out;
}

/**
 * Rewrite a GCS JSON list request
 * `https://storage.googleapis.com/storage/v1/b/<bucket>/o?prefix=audio/<lang>/…`
 * to the override bucket. The `prefix` query param is handled by the caller
 * (it must also rewrite returned object names), so this only swaps the bucket.
 */
export function rewriteAudioListingUrl(url: string, bucket: string | null): string {
  if (!bucket) return url;
  return url.replace(/(\/storage\/v1\/b\/)[^/]+(\/o\b)/, `$1${bucket}$2`);
}
