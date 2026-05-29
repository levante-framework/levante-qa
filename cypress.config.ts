import { defineConfig } from 'cypress';
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as dotenv from 'dotenv';

import { askVLM as dispatchVLM } from './cypress/plugins/vlmClients';
import type { VLMRequest, VLMResult } from './cypress/plugins/vlmClients';
import { readMp3Tags } from './cypress/plugins/id3Reader';
import type { Mp3Tags } from './cypress/support/tasks/types';

dotenv.config();

interface WriteJsonlArgs {
  path: string;
  records: unknown[];
}

export default defineConfig({
  e2e: {
    baseUrl: undefined,
    video: false,
    viewportWidth: 1024,
    viewportHeight: 768,
    // Per-spec screenshot folders are derived automatically by Cypress under
    // cypress/screenshots/<spec>/ so no extra wiring is needed here.
    screenshotsFolder: 'cypress/screenshots',
    specPattern: 'cypress/e2e/**/*.cy.ts',
    supportFile: 'cypress/support/e2e.ts',
    defaultCommandTimeout: 10000,
    setupNodeEvents(on, config) {
      // Resolve the active provider once. A CLI override (`--env provider=...`)
      // takes precedence over VLM_PROVIDER in .env; both the dispatch and the
      // spec label use this same value so logs never disagree with what ran.
      const provider = String(config.env.provider ?? process.env.VLM_PROVIDER ?? 'openai');

      on('task', {
        /**
         * Dispatches a screenshot to the resolved VLM provider and returns the
         * chosen action plus the wall-clock latency of the provider call.
         */
        async askVLM(req: VLMRequest): Promise<VLMResult> {
          const start = Date.now();
          const action = await dispatchVLM(provider, req);
          const latencyMs = Date.now() - start;
          return { action, latencyMs, provider };
        },

        /**
         * Fetches an mp3 and returns its parsed ID3 tags, including the canonical
         * narration transcript. Results are cached by URL inside the reader.
         */
        async readMp3Tags(url: string): Promise<Mp3Tags> {
          return readMp3Tags(url);
        },

        /**
         * Appends newline-delimited JSON records to a log file, creating the
         * parent directory if needed. Used for trial logging.
         */
        writeJsonl({ path, records }: WriteJsonlArgs): null {
          const dir = dirname(path);
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }
          const body = records.map((r) => JSON.stringify(r)).join('\n');
          appendFileSync(path, body + '\n', 'utf-8');
          return null;
        },
      });

      // Surface the resolved provider to specs via Cypress.env('provider').
      config.env.provider = provider;

      // Allow overriding the task target with BASE_URL (e.g. a local dev server).
      if (process.env.BASE_URL) {
        config.baseUrl = process.env.BASE_URL;
      }

      return config;
    },
  },
});
