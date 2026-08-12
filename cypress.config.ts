import { defineConfig } from 'cypress';
import { existsSync, mkdirSync, appendFileSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as dotenv from 'dotenv';

const PANEL_STATUS_PATH = join(process.cwd(), 'tools', 'vlm-panel', 'out', 'status.json');
const PANEL_STATUS_LOG = join(process.cwd(), 'tools', 'vlm-panel', 'out', 'status.log');

function writePanelStatus(patch: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(PANEL_STATUS_PATH), { recursive: true });
    let prev: Record<string, unknown> = {};
    if (existsSync(PANEL_STATUS_PATH)) {
      try {
        prev = JSON.parse(readFileSync(PANEL_STATUS_PATH, 'utf-8'));
      } catch {
        /* ignore */
      }
    }
    const next = { ...prev, ...patch, updatedAt: new Date().toISOString() };
    writeFileSync(PANEL_STATUS_PATH, JSON.stringify(next, null, 2) + '\n');
    const line = [
      next.updatedAt,
      next.phase && `[${next.phase}]`,
      next.message,
      next.itemsCaptured != null && `captured=${next.itemsCaptured}`,
      next.lastTranscript && `"${String(next.lastTranscript).slice(0, 60)}"`,
    ]
      .filter(Boolean)
      .join(' ');
    appendFileSync(PANEL_STATUS_LOG, line + '\n');
  } catch {
    /* status is best-effort; never fail the run */
  }
}
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
import { buildSimChildConfig, type SimChildConfig } from './cypress/plugins/simChildConfig';
import { buildTimedChildConfig, type TimedChildConfig } from './cypress/plugins/timedChildConfig';
import {
  loadCrowdinApprovedTranslations as loadCrowdinApprovedTranslationsFromCrowdin,
  translationForAudioUrl,
  type CrowdinApprovedTranslationsPayload,
} from './cypress/plugins/crowdinApprovedTranslations';
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
/** Optional country-stratified norms (`de`/`co`/`ca`); falls back to QA_SIM_COUNTRY. */
const PERSONA_COUNTRY =
  process.env.QA_PERSONA_COUNTRY || process.env.QA_SIM_COUNTRY || undefined;
let personaLogged = false;
let crowdinApprovedTranslationsCache: Promise<CrowdinApprovedTranslationsPayload> | null = null;

function applyPersona(req: VLMRequest): VLMRequest {
  if (!PERSONA_ON || !Number.isFinite(PERSONA_AGE_YEARS)) return req;
  const ageMonths = Number.isFinite(PERSONA_AGE_MONTHS) ? PERSONA_AGE_MONTHS : 0;
  const preamble = makeChildPersonaPrompt(PERSONA_AGE_YEARS, ageMonths, req.taskId ?? undefined, {
    includeIrtAbility: PERSONA_ABILITY_IRT,
    country: PERSONA_COUNTRY,
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

function useCrowdinApprovedTranslations(): boolean {
  return String(process.env.QA_TRANSLATIONS_SOURCE ?? '').toLowerCase() === 'crowdin-approved';
}

async function crowdinApprovedTranscriptForAudio(url: string): Promise<string | null> {
  if (!useCrowdinApprovedTranslations()) return null;
  const language = String(process.env.QA_LANGUAGE ?? '').trim();
  if (!language) return null;

  crowdinApprovedTranslationsCache ??= loadCrowdinApprovedTranslationsFromCrowdin({
    language,
    projectId: process.env.QA_CROWDIN_PROJECT_ID,
    cachePath: process.env.QA_CROWDIN_CACHE_PATH,
    refresh: /^(1|true|yes)$/i.test(process.env.QA_CROWDIN_REFRESH ?? ''),
  });
  return translationForAudioUrl(await crowdinApprovedTranslationsCache, url);
}

export default defineConfig({
  allowCypressEnv: false,
  e2e: {
    baseUrl: undefined,
    video: false,
    // Defaults to 1024×768. Requesting a specific resolution via
    // QA_VIEWPORT_WIDTH/HEIGHT also disables the tasks' fullscreen (see
    // support/e2e.ts), so the layout actually renders at that size rather than
    // snapping to the browser window — useful for reproducing small-screen /
    // tablet layouts where controls are more likely to overlap.
    viewportWidth: Number(process.env.QA_VIEWPORT_WIDTH) || 1024,
    viewportHeight: Number(process.env.QA_VIEWPORT_HEIGHT) || 768,
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

      // Headless Chrome leaves AudioContext suspended without a real user
      // gesture; SDS instruction OK only enables on narration `onended`. Allow
      // autoplay so resume()/start() actually audibly run under Cypress.
      on('before:browser:launch', (browser, launchOptions) => {
        if (browser.family === 'chromium' && Array.isArray(launchOptions.args)) {
          launchOptions.args.push('--autoplay-policy=no-user-gesture-required');
        }
        return launchOptions;
      });

      on('task', {
        /**
         * Dispatches a screenshot to the resolved VLM provider and returns the
         * raw model text, a normalized H&F action, and the wall-clock latency of
         * the provider call. Tasks whose answer isn't an action (EGMA) read `raw`.
         */
        async askVLM(req: VLMRequest): Promise<VLMResult> {
          const personaReq = applyPersona(req);
          const start = Date.now();
          const reply = await dispatchVLM(provider, personaReq);
          const latencyMs = Date.now() - start;
          const raw = reply.text;
          // Panel cells set QA_RUN_ID; append Gemini/OpenAI usage per call for cost.
          const runId = process.env.QA_RUN_ID;
          if (runId && reply.usage) {
            const usagePath = `tools/vlm-panel/out/usage/${runId}.jsonl`;
            mkdirSync(dirname(usagePath), { recursive: true });
            appendFileSync(
              usagePath,
              `${JSON.stringify({
                ts: new Date().toISOString(),
                runId,
                provider,
                model:
                  process.env.GEMINI_MODEL ||
                  process.env.OPENAI_MODEL ||
                  process.env.ANTHROPIC_MODEL ||
                  null,
                latencyMs,
                usage: reply.usage,
              })}\n`,
            );
          }
          return { action: parseAction(raw), raw, latencyMs, provider, usage: reply.usage };
        },

        /**
         * Builds the calibrated simulated-child config for a task: age theta,
         * per-item IRT difficulty from the deployed item bank (disk-cached),
         * and a calibration offset matching the empirical accuracy-by-age
         * table. Called once per sim_child spec; env: QA_SIM_AGE_YEARS
         * (required), QA_SIM_AGE_MONTHS, QA_SIM_SEED, QA_SIM_REFRESH.
         */
        async getSimConfig({ taskSlug }: { taskSlug: string }): Promise<SimChildConfig> {
          return buildSimChildConfig(taskSlug);
        },

        /**
         * Age-binned empirical accuracy + RT percentiles for timed_child (PA).
         * Env: QA_TIMED_AGE_YEARS (required), QA_TIMED_AGE_MONTHS, QA_TIMED_SEED.
         */
        async getTimedChildConfig({
          taskSlug,
        }: {
          taskSlug: string;
        }): Promise<TimedChildConfig> {
          return buildTimedChildConfig(taskSlug);
        },

        /**
         * Fetches an mp3 and returns its parsed ID3 tags, including the canonical
         * narration transcript. Results are cached by URL inside the reader.
         */
        async readMp3Tags(url: string): Promise<Mp3Tags> {
          const crowdinTranscript = await crowdinApprovedTranscriptForAudio(url);
          if (crowdinTranscript) {
            return {
              url,
              transcript: crowdinTranscript,
              source: 'crowdin-approved',
              title: null,
              language: String(process.env.QA_LANGUAGE ?? '').trim() || null,
            };
          }
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
         * Optional QA-only translation source. When a spec enables the
         * crowdin-approved translation intercept, this returns task translation
         * JSON built from Crowdin's approved XLIFF export instead of the GCS
         * bucket. Production task runtime is unaffected.
         */
        async loadCrowdinApprovedTranslations({
          language,
          projectId,
          cachePath,
          refresh,
        }: {
          language: string;
          projectId?: string;
          cachePath?: string;
          refresh?: boolean;
        }) {
          return loadCrowdinApprovedTranslationsFromCrowdin({ language, projectId, cachePath, refresh });
        },

        /**
         * Polls for a screenshot file to appear on disk, up to `timeoutMs`, and
         * reports whether it exists. Under WSL2 software rendering
         * `cy.screenshot()` intermittently fails to flush the PNG in time, so
         * the VLM capture command uses this to decide whether to re-take the
         * shot before reading it (rather than letting `cy.readFile` time out and
         * abort a long run). Never throws.
         */
        async screenshotReady({
          path,
          timeoutMs = 15000,
        }: {
          path: string;
          timeoutMs?: number;
        }): Promise<boolean> {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            if (path && existsSync(path)) return true;
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          return Boolean(path) && existsSync(path);
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

        /**
         * Panel asset capture: write PNG + append item metadata for offline replay.
         */
        savePanelAsset(req: {
          dir: string;
          assetId: string;
          step: number;
          pngBase64: string;
          transcript?: string | null;
          audioSource?: string | null;
          choices: string[];
          keyedIndex: number;
          promptText?: string | null;
        }): null {
          const dir = req.dir;
          if (!dir) throw new Error('savePanelAsset: dir required');
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, `${req.assetId}.png`), Buffer.from(req.pngBase64, 'base64'));
          appendFileSync(
            join(dir, '_items.jsonl'),
            JSON.stringify({
              assetId: req.assetId,
              step: req.step,
              transcript: req.transcript ?? null,
              audioSource: req.audioSource ?? null,
              choices: req.choices,
              keyedIndex: req.keyedIndex,
              promptText: req.promptText ?? null,
            }) + '\n',
            'utf-8',
          );
          let n = 0;
          try {
            n = readFileSync(join(dir, '_items.jsonl'), 'utf-8')
              .split(/\r?\n/)
              .filter(Boolean).length;
          } catch {
            n = 0;
          }
          writePanelStatus({
            phase: 'capture',
            runId: process.env.QA_RUN_ID ?? null,
            message: 'saving item',
            itemsCaptured: n,
            lastAssetId: req.assetId,
            lastTranscript: req.transcript ?? null,
            lastStep: req.step,
          });
          return null;
        },

        readPanelAsset({ dir, assetId }: { dir: string; assetId: string }): {
          pngBase64: string | null;
        } {
          const p = join(dir, `${assetId}.png`);
          if (!existsSync(p)) return { pngBase64: null };
          return { pngBase64: readFileSync(p).toString('base64') };
        },

        finalizePanelAssets({ dir, locale }: { dir: string; locale?: string }): {
          n: number;
        } {
          const staging = join(dir, '_items.jsonl');
          if (!existsSync(staging)) return { n: 0 };
          const items = readFileSync(staging, 'utf-8')
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line));
          writeFileSync(
            join(dir, 'index.json'),
            JSON.stringify(
              {
                locale: locale ?? process.env.QA_LANGUAGE ?? null,
                capturedAt: new Date().toISOString(),
                items,
              },
              null,
              2,
            ) + '\n',
          );
          writePanelStatus({
            phase: 'capture',
            runId: process.env.QA_RUN_ID ?? null,
            message: 'finalized',
            itemsCaptured: items.length,
            status: 'done',
          });
          return { n: items.length };
        },
      });

      // Surface the resolved provider to specs via Cypress.expose('provider').
      config.env.provider = provider;

      // Surface dashboard-launch settings (.env) to specs via Cypress.expose(...).
      // LAUNCH=dashboard switches specs from the standalone demo to logging in
      // to the -dev dashboard and starting the assigned task.
      for (const key of [
        'LAUNCH',
        'DASHBOARD_URL',
        'PARTICIPANT_USER',
        'PARTICIPANT_PASS',
        'BASE_URL',
        'QA_CAT',
        'QA_LANGUAGE',
        'QA_TRANSLATIONS_SOURCE',
        'QA_CROWDIN_PROJECT_ID',
        'QA_CROWDIN_CACHE_PATH',
        'QA_CROWDIN_REFRESH',
        'QA_STORIES_NUMBER_OF_STORIES',
        'QA_STORIES_MAX_STEPS',
        'QA_STORIES_STOP_AFTER_TEXT',
        'QA_STORIES_CORPUS',
        'QA_AUDIO_FALLBACK_LANGUAGE',
        'QA_AUDIO_BUCKET',
        'QA_AUDIO_PLACEHOLDER',
        'QA_VIEWPORT_WIDTH',
        'QA_VIEWPORT_HEIGHT',
        'QA_AGENT_MODE',
        'QA_SIM_AGE_YEARS',
        'QA_SIM_AGE_MONTHS',
        'QA_SIM_SEED',
        'QA_SIM_COUNTRY',
        'QA_SIM_SITE',
        'QA_TIMED_AGE_YEARS',
        'QA_TIMED_AGE_MONTHS',
        'QA_TIMED_SEED',
        'QA_PA_IS_ADAPTIVE',
        'QA_PERSONA_AGE_YEARS',
        'QA_PERSONA_AGE_MONTHS',
        'QA_PERSONA_ABILITY',
        'QA_PERSONA_COUNTRY',
        'QA_PERSONA_GATE',
        'QA_PERSONA_SEED',
        'QA_PANEL_CAPTURE',
        'QA_PANEL_ASSET_DIR',
        'QA_PANEL_USE_ASSETS',
        'QA_VOCAB_PROMPT',
      ]) {
        if (process.env[key] !== undefined) {
          config.env[key] = process.env[key];
        }
      }

      // Allow overriding the task target with BASE_URL (e.g. a local dev server).
      if (process.env.BASE_URL) {
        config.baseUrl = process.env.BASE_URL;
        config.env.BASE_URL = process.env.BASE_URL;
      }

      // Mirror all resolved env (static block + CLI --env + dynamic overrides) into
      // `expose` so specs can read them via Cypress.expose() now that Cypress.env()
      // is disabled (allowCypressEnv: false).
      config.expose = { ...(config.expose || {}), ...config.env };

      return config;
    },
  },
});
