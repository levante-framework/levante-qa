import { buildUrl } from '../../support/tasks/heartsAndFlowers';
import {
  audioBasename,
  audioManifest,
  installAudioCapture,
  isNonSpeechAudio,
  type AudioWindow,
} from '../../support/audio/audioCapture';
import { readMp3Tags } from '../../support/audio/id3';
import type { Mp3Tags } from '../../support/tasks/types';

/**
 * Audio content-QA (independent of any agent): every narration asset the task
 * references must carry a non-empty transcript tag (ID3 TXXX) in the active
 * locale. Reads the task's asset manifest (window.__mediaAssets) and checks each
 * audio file's tags via the readMp3Tags node task.
 *
 * If an upstream gap appears that can't be fixed immediately, quarantine its
 * item id here so this stays green on known debt while still failing loud on any
 * NEW untagged narration. The H&F en-US gaps found on 2026-05-29 were backfilled
 * (see scripts/backfill_audio_transcripts.ts), so the list is currently empty.
 */
const KNOWN_MISSING_TRANSCRIPTS: ReadonlySet<string> = new Set<string>([]);

describe('Hearts & Flowers — audio content QA', () => {
  it('every narration asset has a transcript tag', () => {
    cy.visit(buildUrl(), { onBeforeLoad: installAudioCapture });

    // The manifest is populated during preload, before the user dismisses the
    // fullscreen prompt.
    cy.window({ timeout: 120000 })
      .should((w) => {
        const audio = (w as AudioWindow).__mediaAssets?.audio;
        expect(audio, 'task audio manifest is exposed').to.be.an('object');
        expect(Object.keys(audio ?? {}).length, 'manifest is non-empty').to.be.greaterThan(0);
      })
      .then((w) => {
        const urls = Object.values(audioManifest(w as AudioWindow));
        const tags: Mp3Tags[] = [];

        urls.forEach((url) => {
          readMp3Tags(url).then((t) => {
            tags.push(t);
          });
        });

        cy.wrap(null, { log: false }).then(() => {
          const narration = tags.filter((t) => !isNonSpeechAudio(t.url));
          const missing = narration.filter(
            (t) => t.source === 'missing' || t.source === 'error',
          );

          if (missing.length > 0) {
            cy.log(
              `Narration assets without a transcript: ${missing
                .map((t) => audioBasename(t.url))
                .join(', ')}`,
            );
          }

          const newGaps = missing
            .map((t) => audioBasename(t.url))
            .filter((name) => !KNOWN_MISSING_TRANSCRIPTS.has(name));

          expect(
            newGaps,
            'narration assets missing a transcript (excluding known upstream gaps)',
          ).to.deep.equal([]);
        });
      });
  });
});
