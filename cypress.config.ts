import { defineConfig } from 'cypress';
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as dotenv from 'dotenv';

/**
 * When the dashboard launches a run it sets QA_RUN_ID so each run's logs land in
 * their own subdir. Specs use fixed log filenames (e.g.
 * `cypress/logs/_trog_oracle_live.jsonl`); rewriting any `cypress/logs/...` path
 * into `cypress/logs/runs/<QA_RUN_ID>/...` keeps parallel runs from colliding on
 * those fixed names, with no spec changes. Unset → original behavior.
 */
function scopeLogPath(p: string): string {
  const runId = process.env.QA_RUN_ID;
  if (!runId) return p;
  const norm = p.replace(/\\/g, '/');
  const marker = 'cypress/logs/';
  const idx = norm.indexOf(marker);
  if (idx === -1) return p;
  const head = norm.slice(0, idx + marker.length);
  const tail = norm.slice(idx + marker.length);
  if (tail.startsWith(`runs/${runId}/`)) return p;
  return `${head}runs/${runId}/${tail}`;
}

import { askVLM as dispatchVLM, parseAction } from './cypress/plugins/vlmClients';
import type { VLMRequest, VLMResult } from './cypress/plugins/vlmClients';
import { makeChildPersonaPrompt } from './cypress/support/persona/childPersona';
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

/**
 * Optional child-age persona for VLM runs. When `QA_PERSONA=child` (set by the
 * dashboard or a manual run) a persona preamble — grounded in real LEVANTE
 * accuracy-by-age data — is prepended to each task's system prompt so the model
 * answers as a typical child of the target age would. Off by default; the oracle
 * is never affected.
 */
const PERSONA_ON = String(process.env.QA_PERSONA ?? '').toLowerCase() === 'child';
const PERSONA_AGE_YEARS = Number(process.env.QA_PERSONA_AGE_YEARS ?? '');
const PERSONA_AGE_MONTHS = Number(process.env.QA_PERSONA_AGE_MONTHS ?? '0');
/** When `irt`, append mean child IRT θ for this age/task (requires age_task_ability.json). */
const PERSONA_ABILITY_IRT = String(process.env.QA_PERSONA_ABILITY ?? '').toLowerCase() === 'irt';
let personaLogged = false;

function applyPersona(req: VLMRequest): VLMRequest {
  if (!PERSONA_ON || !Number.isFinite(PERSONA_AGE_YEARS)) return req;
  const ageMonths = Number.isFinite(PERSONA_AGE_MONTHS) ? PERSONA_AGE_MONTHS : 0;
  const preamble = makeChildPersonaPrompt(PERSONA_AGE_YEARS, ageMonths, req.taskId ?? undefined, {
    includeIrtAbility: PERSONA_ABILITY_IRT,
  });
  if (!personaLogged) {
    personaLogged = true;
    try {
      const path = scopeLogPath(`cypress/logs/_${req.taskId ?? 'task'}_persona.jsonl`);
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(
        path,
        JSON.stringify({
          timestamp: new Date().toISOString(),
          taskId: req.taskId ?? null,
          ageYears: PERSONA_AGE_YEARS,
          ageMonths,
          personaAbility: PERSONA_ABILITY_IRT ? 'irt' : null,
          preamble,
        }) + '\n',
        'utf-8',
      );
    } catch {
      // Logging the persona is best-effort; never fail a run over it.
    }
  }
  return { ...req, systemPrompt: `${preamble}\n\n${req.systemPrompt}` };
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
          const personaReq = applyPersona(req);
          const start = Date.now();
          const raw = await dispatchVLM(provider, personaReq);
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
        writeJsonl({ path: rawPath, records }: WriteJsonlArgs): null {
          const path = scopeLogPath(rawPath);
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
