import type { AudioSource, Mp3Tags } from '../tasks/types';
import { isNonSpeechAudio, type AudioWindow } from './audioCapture';
import { readMp3Tags } from './id3';

/**
 * Resolves the canonical narration transcript for the clip playing on the
 * current screen, by combining the in-page play log (installAudioCapture) with
 * the node-side ID3 reader.
 */

export interface CurrentAudio {
  url: string | null;
  transcript: string | null;
  source: AudioSource | null;
}

const NO_AUDIO: CurrentAudio = { url: null, transcript: null, source: null };

// How many entries of the play log we have already attributed to a screen. The
// log lives on the AUT window and resets on navigation; this pointer lives in
// the spec context and is reset per run via resetAudioCapture().
let consumed = 0;

export function resetAudioCapture(): void {
  consumed = 0;
}

/**
 * The newest narration clip URL that started since the previous call, or null if
 * no new narration began on this screen. Non-speech cues (clicks, jingles) are
 * skipped, and silent screens (e.g. the timed response trials) return null so a
 * stale instruction clip is never mis-attributed to a later trial.
 */
export function takeLatestAudioUrl(win: AudioWindow): string | null {
  const log = win.__audioPlayLog ?? [];
  if (log.length <= consumed) {
    return null;
  }
  // Among clips that started since the last call, take the most recent one that
  // is actual narration (skip non-speech cues like button clicks).
  let url: string | null = null;
  for (let i = log.length - 1; i >= consumed; i -= 1) {
    const candidate = log[i];
    if (candidate && !isNonSpeechAudio(candidate)) {
      url = candidate;
      break;
    }
  }
  consumed = log.length;
  return url;
}

/**
 * Resolve the transcript for the current screen's narration. Yields NO_AUDIO
 * (all nulls) when the screen played no new clip, so callers can log uniformly.
 */
export function currentAudioTranscript(win: AudioWindow): Cypress.Chainable<CurrentAudio> {
  const url = takeLatestAudioUrl(win);
  if (!url) {
    return cy.wrap(NO_AUDIO, { log: false });
  }
  return readMp3Tags(url).then(
    (tags: Mp3Tags): CurrentAudio => ({
      url,
      transcript: tags.transcript,
      source: tags.source,
    }),
  );
}
