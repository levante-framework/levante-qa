import NodeID3 from 'node-id3';

import type { AudioSource, Mp3Tags } from '../support/tasks/types';

// node-id3 is CommonJS; under the ts-node/esm loader Cypress uses, a namespace
// import (`import * as`) does not expose `.read`, so we use the default import
// and describe just the frames we read. See backfill_audio_transcripts.ts.
interface UserDefinedTextFrame {
  description?: string;
  value?: string;
}
interface Id3Tags {
  title?: string;
  userDefinedText?: UserDefinedTextFrame[];
}

/**
 * Node-side reader for LEVANTE narration mp3s. Fetches a file and pulls the
 * canonical transcript out of its ID3v2 TXXX (user-defined text) frames.
 *
 * Verified against the live dev bucket
 * (https://storage.googleapis.com/levante-assets-dev/audio/en-US/*.mp3,
 * 2026-05-29): the spoken script lives in TXXX frames, e.g. for
 * heart-instruct1.mp3 the TXXX:text frame is
 *   "This is the heart game. Here's how you play it!"
 * TIT2 holds only the asset id and COMM holds voice metadata, so neither is a
 * transcript source.
 *
 * Locale is encoded in the URL path (audio/<locale>/<file>.mp3), and the URL we
 * read is the exact one the page requested — so this reader is locale-agnostic
 * and needs no locale parameter.
 */

// TXXX description keys to try, highest precedence first. See AudioSource.
const TRANSCRIPT_KEYS: ReadonlyArray<{ key: string; source: AudioSource }> = [
  { key: 'original_translation_text', source: 'id3:original_translation_text' },
  { key: 'text', source: 'id3:text' },
  { key: 'audio_enhanced_text', source: 'id3:audio_enhanced_text' },
];

/**
 * Strip TTS-only markup (e.g. emotion cues like "[happy]") that is never spoken,
 * and collapse whitespace, so the transcript matches what a child actually hears.
 */
function normalize(text: string): string {
  return text
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Locale segment of a LEVANTE asset URL (audio/<locale>/<file>.mp3), or null. */
function localeFromUrl(url: string): string | null {
  const m = /\/audio\/([^/]+)\//i.exec(url);
  return m ? m[1] : null;
}

/** Primary language subtag, lowercased (e.g. "en-US" → "en", "de" → "de"). */
function primarySubtag(lang: string | null | undefined): string {
  return String(lang ?? '')
    .trim()
    .toLowerCase()
    .split(/[-_]/)[0];
}

/**
 * The language this run expects its narration to be in. Defaults to the locale
 * the page requested (the URL path), so a file whose embedded `lang_code`
 * contradicts the requested locale is caught. `QA_EXPECTED_AUDIO_LANG` pins an
 * explicit expected language (e.g. "en-US") to also catch a whole run that was
 * mis-provisioned into the wrong language.
 */
function expectedAudioLang(url: string): string | null {
  const env = process.env.QA_EXPECTED_AUDIO_LANG;
  if (env && env.trim()) return env.trim();
  return localeFromUrl(url);
}

/**
 * Throw if the file's `lang_code` is in a different language than expected.
 * Compares primary subtags so "en" / "en-US" match but "de" vs "en-US" fails.
 * Silent when either side is unknown (can't verify) or the read already errored.
 */
function assertAudioLanguage(url: string, tags: Mp3Tags): void {
  if (tags.source === 'error') return;
  const expected = expectedAudioLang(url);
  const got = tags.language;
  if (!expected || !got) return;
  if (primarySubtag(expected) !== primarySubtag(got)) {
    throw new Error(
      `Audio language mismatch for ${url}: file lang_code="${got}" does not match expected language "${expected}".`,
    );
  }
}

// Tags never change between page loads, so cache by URL to keep runs fast and
// make repeated plays of the same asset effectively free.
const cache = new Map<string, Mp3Tags>();

export async function readMp3Tags(url: string): Promise<Mp3Tags> {
  const cached = cache.get(url);
  if (cached) {
    return cached;
  }

  let result: Mp3Tags;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const tags = NodeID3.read(buf) as unknown as Id3Tags;

    const byDescription = new Map<string, string>();
    for (const entry of tags.userDefinedText ?? []) {
      if (entry.description) {
        byDescription.set(entry.description, entry.value ?? '');
      }
    }

    let transcript: string | null = null;
    let source: AudioSource = 'missing';
    for (const { key, source: candidate } of TRANSCRIPT_KEYS) {
      const value = byDescription.get(key);
      if (value && value.trim()) {
        transcript = normalize(value);
        source = candidate;
        break;
      }
    }

    result = {
      url,
      transcript,
      source,
      title: tags.title ?? null,
      language: byDescription.get('lang_code') ?? null,
    };
  } catch (err) {
    result = {
      url,
      transcript: null,
      source: 'error',
      title: null,
      language: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Validate language before caching so a mismatch always throws (a cached
  // result would otherwise silently pass on subsequent plays of the same clip).
  assertAudioLanguage(url, result);

  cache.set(url, result);
  return result;
}
