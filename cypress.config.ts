import { defineConfig } from 'cypress';
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as dotenv from 'dotenv';

import { askVLM as dispatchVLM, parseAction } from './cypress/plugins/vlmClients';
import type { VLMRequest, VLMResult } from './cypress/plugins/vlmClients';
import { readMp3Tags } from './cypress/plugins/id3Reader';
import { solveMentalRotation } from './cypress/plugins/mentalRotationSolver';
import type {
  MentalRotationSolveRequest,
  MentalRotationSolveResult,
} from './cypress/plugins/mentalRotationSolver';
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
    // The EGMA oracle drives ~250 items in a single spec; keep the runner's
    // memory flat over the long command chain (snapshots are not needed in CI).
    experimentalMemoryManagement: true,
    numTestsKeptInMemory: 0,
    setupNodeEvents(on, config) {
      // Resolve the active provider once. A CLI override (`--env provider=...`)
      // takes precedence over VLM_PROVIDER in .env; both the dispatch and the
      // spec label use this same value so logs never disagree with what ran.
      const provider = String(config.env.provider ?? process.env.VLM_PROVIDER ?? 'openai');

      on('task', {
        /**
         * Dispatches a screenshot to the resolved VLM provider and returns the
         * raw model text, a normalized H&F action, and the wall-clock latency of
         * the provider call. Tasks whose answer isn't an action (EGMA) read `raw`.
         */
        async askVLM(req: VLMRequest): Promise<VLMResult> {
          const start = Date.now();
          const raw = await dispatchVLM(provider, req);
          const latencyMs = Date.now() - start;
          return { action: parseAction(raw), raw, latencyMs, provider };
        },

        /**
         * Fetches an mp3 and returns its parsed ID3 tags, including the canonical
         * narration transcript. Results are cached by URL inside the reader.
         */
        async readMp3Tags(url: string): Promise<Mp3Tags> {
          return readMp3Tags(url);
        },

        /**
         * Pixel-based Mental Rotation solver: decides which choice is the target
         * under pure rotation (vs. the mirror distractor) directly from the
         * silhouette images. Powers the "authentic" oracle; its answer is
         * cross-checked against the app's `.correct` key by the spec.
         */
        async solveMentalRotation(
          req: MentalRotationSolveRequest,
        ): Promise<MentalRotationSolveResult> {
          return solveMentalRotation(req);
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

      // Surface dashboard-launch settings (.env) to specs via Cypress.env(...).
      // LAUNCH=dashboard switches specs from the standalone demo to logging in
      // to the -dev dashboard and starting the assigned task.
      for (const key of ['LAUNCH', 'DASHBOARD_URL', 'PARTICIPANT_USER', 'PARTICIPANT_PASS']) {
        if (process.env[key] !== undefined) {
          config.env[key] = process.env[key];
        }
      }

      // Allow overriding the task target with BASE_URL (e.g. a local dev server).
      if (process.env.BASE_URL) {
        config.baseUrl = process.env.BASE_URL;
      }

      return config;
    },
  },
});
