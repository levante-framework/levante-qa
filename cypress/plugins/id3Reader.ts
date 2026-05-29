import * as NodeID3 from 'node-id3';

import type { AudioSource, Mp3Tags } from '../support/tasks/types';

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
    const tags = NodeID3.read(buf);

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

  cache.set(url, result);
  return result;
}
