#!/usr/bin/env node
/**
 * Child Twins panel runner — age × country × language × task × agent.
 *
 * Expands panel_grid.json into one Cypress run per cell and executes them
 * SEQUENTIALLY (parallel Cypress OOMs under WSL2). Agents:
 *   - sim: IRT-calibrated psychometric twin (QA_SIM_*)
 *   - vlm: vision agent with child-age + country persona (QA_PERSONA_*)
 *          and QA_PERSONA_GATE=irt so final accuracy tracks age norms
 *
 * Each cell gets a unique QA_RUN_ID. Progress is written to out/manifest.json;
 * a cell whose run dir already has a matching log is skipped (resumable).
 *
 * Usage:
 *   node tools/child-twins/run_panel.mjs                 # full grid
 *   node tools/child-twins/run_panel.mjs --limit 1       # smoke: first cell
 *   node tools/child-twins/run_panel.mjs --dry-run
 *   node tools/child-twins/run_panel.mjs --agent sim
 *   node tools/child-twins/run_panel.mjs --grid path.json
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  openSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { legacyLanguageReplacement } from '../../dashboard/catalog.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const OUT_DIR = join(HERE, 'out');
const LOG_DIR = join(OUT_DIR, 'logs');
const MANIFEST = join(OUT_DIR, 'manifest.json');

function parseArgs(argv) {
  const args = {
    grid: join(HERE, 'panel_grid.json'),
    limit: Infinity,
    dryRun: false,
    agent: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--grid') args.grid = argv[++i];
    else if (a === '--agent') args.agent = String(argv[++i]).toLowerCase();
  }
  if (args.agent && !['sim', 'vlm'].includes(args.agent)) {
    throw new Error(`--agent must be sim|vlm (got ${args.agent})`);
  }
  return args;
}

function shortModel(model) {
  return String(model || 'na')
    .replace(/^gemini-/, '')
    .replace(/[^a-z0-9]/gi, '');
}

/** Deterministic seed string from run id (sim replay). */
function seedFromRunId(runId) {
  return createHash('sha256').update(runId).digest('hex').slice(0, 12);
}

function expand(grid) {
  const ages = grid.ages ?? [];
  const locales = grid.locales ?? [];
  const tasks = grid.tasks ?? [];
  const agents = grid.agents ?? ['sim', 'vlm'];
  const models = grid.models?.length ? grid.models : ['gemini-3.6-flash'];
  const repeats = grid.repeats ?? 1;
  const out = [];

  for (const agent of agents) {
    for (const task of tasks) {
      const spec = agent === 'sim' ? task.simSpec : task.vlmSpec;
      if (!spec) {
        throw new Error(`task '${task.slug}' missing ${agent}Spec`);
      }
      const modelList = agent === 'vlm' ? models : [null];
      for (const locale of locales) {
        const country = String(locale.country || '').toLowerCase();
        const language = String(locale.language || '');
        const legacy = legacyLanguageReplacement(language);
        if (legacy) {
          throw new Error(`Locale "${language}" is legacy; use "${legacy}".`);
        }
        const langToken = language.split('-')[0].toLowerCase() || 'xx';
        for (const age of ages) {
          for (const model of modelList) {
            for (let rep = 1; rep <= repeats; rep++) {
              const modelTok = agent === 'vlm' ? shortModel(model) : 'irt';
              const runId = [
                'twin',
                agent,
                task.slug,
                country || 'xx',
                langToken,
                `a${age}`,
                modelTok,
                `r${rep}`,
              ].join('_');
              out.push({
                runId,
                agent,
                task: task.slug,
                spec,
                provider: grid.provider ?? 'gemini',
                country: country || null,
                language,
                age,
                model,
                repeat: rep,
                temperature: grid.temperature ?? 0.8,
                personaAbility: grid.personaAbility ?? 'irt',
                seed: seedFromRunId(runId),
              });
            }
          }
        }
      }
    }
  }
  return out;
}

/** A cell is done when its QA_RUN_ID dir holds any finalized trial jsonl. */
function alreadyDone(r) {
  const dir = join(REPO, 'cypress', 'logs', 'runs', r.runId);
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((f) => /\.jsonl?$/.test(f));
}

function loadManifest() {
  if (!existsSync(MANIFEST)) return {};
  try {
    const arr = JSON.parse(readFileSync(MANIFEST, 'utf-8'));
    return Object.fromEntries(arr.map((row) => [row.runId, row]));
  } catch {
    return {};
  }
}

function saveManifest(byId) {
  const arr = Object.values(byId).sort((a, b) => a.runId.localeCompare(b.runId));
  writeFileSync(MANIFEST, JSON.stringify(arr, null, 2) + '\n', 'utf-8');
}

function buildEnv(r) {
  const env = {
    ...process.env,
    QA_LANGUAGE: r.language,
    QA_RUN_ID: r.runId,
  };
  if (r.agent === 'sim') {
    env.QA_SIM_AGE_YEARS = String(r.age);
    env.QA_SIM_AGE_MONTHS = '0';
    env.QA_SIM_SEED = r.seed;
    if (r.country) env.QA_SIM_COUNTRY = r.country;
  } else {
    env.GEMINI_MODEL = r.model;
    env.VLM_TEMPERATURE = String(r.temperature);
    env.QA_PERSONA = 'child';
    env.QA_PERSONA_AGE_YEARS = String(r.age);
    env.QA_PERSONA_AGE_MONTHS = '0';
    env.QA_PERSONA_ABILITY = r.personaAbility;
    // IRT gate: final correctness tracks age norms; VLM shapes distractors.
    // (vlm-panel stays ungated so item-difficulty screens stay pure-VLM.)
    env.QA_PERSONA_GATE = 'irt';
    env.QA_PERSONA_SEED = r.seed;
    env.QA_SIM_SEED = r.seed;
    if (r.country) env.QA_PERSONA_COUNTRY = r.country;
  }
  if ((env.CYPRESS_CACHE_FOLDER ?? '').includes('sandbox-cache')) {
    delete env.CYPRESS_CACHE_FOLDER;
  }
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function runOne(r, byId) {
  const logFile = join(LOG_DIR, `${r.runId}.log`);
  const env = buildEnv(r);

  byId[r.runId] = {
    ...r,
    status: 'running',
    startedAt: new Date().toISOString(),
    logFile: logFile.replace(REPO + '/', ''),
  };
  saveManifest(byId);

  const fd = openSync(logFile, 'a');
  const started = Date.now();
  const cyArgs = ['cypress', 'run', '--spec', r.spec];
  if (r.agent === 'vlm') cyArgs.push('--env', `provider=${r.provider}`);
  const res = spawnSync('npx', cyArgs, { cwd: REPO, env, stdio: ['ignore', fd, fd] });
  const elapsedMs = Date.now() - started;

  byId[r.runId] = {
    ...byId[r.runId],
    status: res.status === 0 ? 'done' : 'failed',
    finishedAt: new Date().toISOString(),
    exitCode: res.status,
    elapsedMs,
  };
  saveManifest(byId);
  return res.status === 0;
}

function main() {
  const args = parseArgs(process.argv);
  const grid = JSON.parse(readFileSync(args.grid, 'utf-8'));
  mkdirSync(LOG_DIR, { recursive: true });

  let respondents = expand(grid);
  if (args.agent) respondents = respondents.filter((r) => r.agent === args.agent);
  if (Number.isFinite(args.limit)) respondents = respondents.slice(0, args.limit);

  const byId = loadManifest();
  const pending = respondents.filter((r) => !alreadyDone(r));
  const skipped = respondents.length - pending.length;

  const nAges = (grid.ages ?? []).length;
  const nLocales = (grid.locales ?? []).length;
  const nTasks = (grid.tasks ?? []).length;
  const nAgents = (args.agent ? 1 : (grid.agents ?? []).length) || 0;
  console.log(
    `Child Twins: ${respondents.length} cell(s) ` +
      `[${nAgents} agents × ${nAges} ages × ${nLocales} locales × ${nTasks} tasks` +
      `${(grid.agents ?? []).includes('vlm') ? ` × ${(grid.models ?? []).length} models` : ''}` +
      ` × ${grid.repeats ?? 1} repeats]`,
  );
  console.log(`  already done: ${skipped} | to run: ${pending.length}`);

  if (args.dryRun) {
    for (const r of respondents) {
      const tag = alreadyDone(r) ? 'SKIP' : 'RUN ';
      console.log(
        `  [${tag}] ${r.runId}  agent=${r.agent} age=${r.age} ` +
          `country=${r.country} lang=${r.language}` +
          (r.model ? ` model=${r.model}` : ''),
      );
    }
    console.log('(dry run — nothing executed)');
    return;
  }

  let i = 0;
  for (const r of pending) {
    i++;
    console.log(
      `\n[${i}/${pending.length}] ${new Date().toISOString()}  START ${r.runId}`,
    );
    const ok = runOne(r, byId);
    const mins = ((byId[r.runId].elapsedMs ?? 0) / 60000).toFixed(1);
    console.log(
      `           ${ok ? 'DONE' : 'FAILED'} ${r.runId} in ${mins} min (exit ${byId[r.runId].exitCode})`,
    );
  }

  const done = Object.values(byId).filter((r) => r.status === 'done').length;
  const failed = Object.values(byId).filter((r) => r.status === 'failed').length;
  console.log(
    `\nChild Twins finished. done=${done} failed=${failed}. Manifest: ${MANIFEST.replace(REPO + '/', '')}`,
  );
}

main();
