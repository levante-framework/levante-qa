#!/usr/bin/env node
/**
 * VLM synthetic-respondent panel runner.
 *
 * Expands panel_grid.json into one "respondent" per (model x age x repeat) cell
 * and runs the TROG VLM-agent spec once per respondent, SEQUENTIALLY (parallel
 * Cypress runs OOM under WSL2). Ability is varied only on the responder side:
 *   - model strength via GEMINI_MODEL
 *   - child-age IRT persona via QA_PERSONA=child / QA_PERSONA_AGE_YEARS / QA_PERSONA_ABILITY=irt
 *   - within-cell variance via VLM_TEMPERATURE>0 + repeated runs
 * The stimulus is never altered.
 *
 * Each respondent gets a unique QA_RUN_ID so its trial log lands in
 * cypress/logs/runs/<QA_RUN_ID>/vlm_trog_gemini_*.jsonl. Progress + covariates
 * are written to out/manifest.json; the runner is resumable (a respondent whose
 * log already exists is skipped).
 *
 * Usage:
 *   node tools/vlm-panel/run_panel.mjs                 # full grid
 *   node tools/vlm-panel/run_panel.mjs --limit 1       # smoke test: first respondent only
 *   node tools/vlm-panel/run_panel.mjs --dry-run       # print the plan, run nothing
 *   node tools/vlm-panel/run_panel.mjs --force          # re-run even if logs exist
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  openSync,
  rmSync,
  statSync,
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
    lang: null,
    force: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--force') args.force = true;
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--grid') args.grid = argv[++i];
    else if (a === '--lang') args.lang = argv[++i];
  }
  return args;
}

function shortModel(model) {
  return model.replace(/^gemini-/, '').replace(/[^a-z0-9]/gi, '');
}

/** Cartesian expansion of the grid into respondent descriptors. `token` (e.g.
 * "de") is the short language key in the run id (so panels never collide and
 * analysis can group by it); `locale` (e.g. "de-DE") is what the task needs as
 * QA_LANGUAGE. */
function expand(grid, token, locale) {
  const out = [];
  for (const model of grid.models) {
    for (const age of grid.ages) {
      for (let rep = 1; rep <= (grid.repeats ?? 1); rep++) {
        const runId = `panel_${grid.task}_${token}_${shortModel(model)}_a${age}_r${rep}`;
        out.push({
          runId,
          task: grid.task,
          spec: grid.spec,
          provider: grid.provider ?? 'gemini',
          language: token,
          qaLanguage: locale,
          model,
          age,
          repeat: rep,
          temperature: grid.temperature ?? 0.8,
          personaAbility: grid.personaAbility ?? 'irt',
          country: grid.country ?? null,
        });
      }
    }
  }
  return out;
}

/** A respondent is "done" if its run dir holds a non-empty finalized trial log. */
function alreadyDone(runId) {
  const dir = join(REPO, 'cypress', 'logs', 'runs', runId);
  if (!existsSync(dir)) return false;
  for (const f of readdirSync(dir)) {
    if (!/^vlm_.*\.jsonl?$/.test(f)) continue;
    try {
      // Failed runs sometimes leave a 1-byte stub that must not count as done.
      if (statSync(join(dir, f)).size > 64) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

/** Remove prior trial logs so a forced re-run starts clean. */
function clearTrialLogs(runId) {
  const dir = join(REPO, 'cypress', 'logs', 'runs', runId);
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (/^vlm_.*\.jsonl?$/.test(f) || f.endsWith('.jsonl')) {
      rmSync(join(dir, f), { force: true });
    }
  }
}

function loadManifest() {
  if (!existsSync(MANIFEST)) return {};
  try {
    const arr = JSON.parse(readFileSync(MANIFEST, 'utf-8'));
    return Object.fromEntries(arr.map((r) => [r.runId, r]));
  } catch {
    return {};
  }
}

function saveManifest(byId) {
  const arr = Object.values(byId).sort((a, b) => a.runId.localeCompare(b.runId));
  writeFileSync(MANIFEST, JSON.stringify(arr, null, 2) + '\n', 'utf-8');
}

function runOne(r, byId) {
  const logFile = join(LOG_DIR, `${r.runId}.log`);
  const env = {
    ...process.env,
    GEMINI_MODEL: r.model,
    VLM_TEMPERATURE: String(r.temperature),
    QA_PERSONA: 'child',
    QA_PERSONA_AGE_YEARS: String(r.age),
    QA_PERSONA_AGE_MONTHS: '0',
    QA_PERSONA_ABILITY: r.personaAbility,
    QA_LANGUAGE: r.qaLanguage ?? r.language,
    QA_RUN_ID: r.runId,
  };
  // Optional country-stratified persona norms (Child Twins / grid.country).
  if (r.country) env.QA_PERSONA_COUNTRY = String(r.country);

  // A sandboxed CYPRESS_CACHE_FOLDER (e.g. a temp dir with no installed binary)
  // makes `cypress run` fail immediately. Drop it so Cypress falls back to the
  // real per-user cache (~/.cache/Cypress). Harmless when the var is unset.
  if ((env.CYPRESS_CACHE_FOLDER ?? '').includes('sandbox-cache')) {
    delete env.CYPRESS_CACHE_FOLDER;
  }
  // The editor's remote server exports ELECTRON_RUN_AS_NODE=1, which makes
  // Cypress's bundled Electron boot as plain Node and crash with
  // "Invalid or incompatible cached data". Cypress must run as real Electron.
  delete env.ELECTRON_RUN_AS_NODE;

  byId[r.runId] = {
    ...r,
    status: 'running',
    startedAt: new Date().toISOString(),
    logFile: logFile.replace(REPO + '/', ''),
  };
  saveManifest(byId);

  const fd = openSync(logFile, 'a');
  const started = Date.now();
  const res = spawnSync(
    'npx',
    ['cypress', 'run', '--spec', r.spec, '--env', `provider=${r.provider}`],
    { cwd: REPO, env, stdio: ['ignore', fd, fd] },
  );
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
  const locale = args.lang ?? grid.language ?? 'en';
  const legacyLocale = legacyLanguageReplacement(locale);
  if (legacyLocale) {
    throw new Error(`Locale "${locale}" is legacy; use "${legacyLocale}" (e.g. --lang ${legacyLocale}).`);
  }
  const token = locale.split('-')[0].toLowerCase();
  mkdirSync(LOG_DIR, { recursive: true });

  let respondents = expand(grid, token, locale);
  if (Number.isFinite(args.limit)) respondents = respondents.slice(0, args.limit);

  const byId = loadManifest();
  const pending = args.force
    ? respondents
    : respondents.filter((r) => !alreadyDone(r.runId));
  const skipped = respondents.length - pending.length;

  console.log(
    `Panel: ${respondents.length} respondent(s) [${grid.models.length} models x ${grid.ages.length} ages x ${grid.repeats} repeats]`,
  );
  console.log(`  task=${grid.task} lang=${token} (QA_LANGUAGE=${locale}) temp=${grid.temperature} persona=irt`);
  console.log(
    `  already done: ${skipped} | to run: ${pending.length}` +
      (args.force ? ' (--force: re-run all)' : ''),
  );

  if (args.dryRun) {
    for (const r of respondents) {
      const tag = !args.force && alreadyDone(r.runId) ? 'SKIP' : 'RUN ';
      console.log(`  [${tag}] ${r.runId}  model=${r.model} age=${r.age} temp=${r.temperature}`);
    }
    console.log('(dry run -- nothing executed)');
    return;
  }

  let i = 0;
  for (const r of pending) {
    i++;
    if (args.force) clearTrialLogs(r.runId);
    const t0 = new Date().toISOString();
    console.log(`\n[${i}/${pending.length}] ${t0}  START ${r.runId} (model=${r.model} age=${r.age})`);
    const ok = runOne(r, byId);
    const mins = ((byId[r.runId].elapsedMs ?? 0) / 60000).toFixed(1);
    console.log(`           ${ok ? 'DONE' : 'FAILED'} ${r.runId} in ${mins} min (exit ${byId[r.runId].exitCode})`);
  }

  const done = Object.values(byId).filter((r) => r.status === 'done').length;
  const failed = Object.values(byId).filter((r) => r.status === 'failed').length;
  console.log(`\nPanel finished. done=${done} failed=${failed}. Manifest: ${MANIFEST.replace(REPO + '/', '')}`);
  console.log('Next: node tools/vlm-panel/analyze.mjs');
}

main();
