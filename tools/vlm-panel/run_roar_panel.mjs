#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const OUT_DIR = join(HERE, 'out');
const LOG_DIR = join(OUT_DIR, 'logs');
const MANIFEST = join(OUT_DIR, 'manifest.json');

function parseArgs(argv) {
  const args = { grid: null, limit: Infinity, dryRun: false, lang: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--grid') args.grid = argv[++i];
    else if (a === '--lang') args.lang = argv[++i];
  }
  if (!args.grid) throw new Error('Missing --grid <path>');
  return args;
}

function shortModel(model) {
  return model.replace(/^gemini-/, '').replace(/[^a-z0-9]/gi, '');
}

function expand(grid, token, locale) {
  const out = [];
  for (const model of grid.models) {
    for (const age of grid.ages) {
      for (let rep = 1; rep <= (grid.repeats ?? 1); rep++) {
        const runId = `panel_${grid.task}_${token}_${shortModel(model)}_a${age}_r${rep}`;
        out.push({
          runId,
          task: grid.task,
          language: token,
          qaLanguage: locale,
          model,
          age,
          repeat: rep,
          provider: grid.provider ?? 'gemini',
          temperature: grid.temperature ?? 0.8,
        });
      }
    }
  }
  return out;
}

function alreadyDone(runId, task) {
  const dir = join(REPO, 'cypress', 'logs', 'runs', runId);
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((f) => new RegExp(`^vlm_${task}_.*\\.jsonl?$`).test(f));
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

function parseProvisionStdout(stdout) {
  const m = stdout.match(/PROVISION_RESULT=(\{.*\})/s);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function provisionParticipant(r) {
  // provision-participant.mjs truncates run-id-derived slugs; long panel run ids
  // collide if we pass them directly. Use a short deterministic hash instead.
  const provRunId = `p${createHash('sha1').update(r.runId).digest('hex').slice(0, 10)}`;
  const res = spawnSync(
    'node',
    [
      'scripts/e2e-init/provision-participant.mjs',
      '--task',
      r.task,
      '--language',
      r.qaLanguage,
      '--age-years',
      String(r.age),
      '--age-months',
      '0',
      '--run-id',
      provRunId,
    ],
    { cwd: REPO, env: { ...process.env }, encoding: 'utf-8' },
  );
  if (res.status !== 0) {
    throw new Error(`provision failed (exit ${res.status}): ${res.stderr || res.stdout}`);
  }
  const parsed = parseProvisionStdout(res.stdout || '');
  if (!parsed?.email || !parsed?.password) {
    throw new Error(`provision output missing creds: ${res.stdout}`);
  }
  return parsed;
}

function runOne(r, byId) {
  const logFile = join(LOG_DIR, `${r.runId}.log`);
  byId[r.runId] = {
    ...r,
    status: 'provisioning',
    startedAt: new Date().toISOString(),
    logFile: logFile.replace(REPO + '/', ''),
  };
  saveManifest(byId);

  let creds;
  try {
    creds = provisionParticipant(r);
  } catch (e) {
    byId[r.runId] = {
      ...byId[r.runId],
      status: 'failed',
      finishedAt: new Date().toISOString(),
      exitCode: 1,
      error: String(e?.message ?? e),
    };
    saveManifest(byId);
    return false;
  }

  const env = {
    ...process.env,
    PARTICIPANT_USER: creds.email,
    PARTICIPANT_PASS: creds.password,
    QA_LANGUAGE: r.qaLanguage,
    QA_RUN_ID: r.runId,
    GEMINI_MODEL: r.model,
    VLM_TEMPERATURE: String(r.temperature),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  if ((env.CYPRESS_CACHE_FOLDER ?? '').includes('sandbox-cache')) delete env.CYPRESS_CACHE_FOLDER;

  byId[r.runId] = {
    ...byId[r.runId],
    status: 'running',
    participantEmail: creds.email,
    startedRunAt: new Date().toISOString(),
  };
  saveManifest(byId);

  const fd = openSync(logFile, 'a');
  const started = Date.now();
  const cmd = `cy:run:${r.task}:vlm`;
  const res = spawnSync('npm', ['run', cmd, '--', '--env', `provider=${r.provider}`], {
    cwd: REPO,
    env,
    stdio: ['ignore', fd, fd],
  });
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
  if (!['swr', 'sre'].includes(grid.task)) throw new Error('run_roar_panel supports task=swr|sre');
  const locale = args.lang ?? grid.language ?? 'en-US';
  const token = locale.split('-')[0].toLowerCase();

  mkdirSync(LOG_DIR, { recursive: true });
  let respondents = expand(grid, token, locale);
  if (Number.isFinite(args.limit)) respondents = respondents.slice(0, args.limit);
  const byId = loadManifest();
  const pending = respondents.filter((r) => !alreadyDone(r.runId, r.task));
  const skipped = respondents.length - pending.length;

  console.log(
    `ROAR panel: ${respondents.length} respondent(s) [${grid.models.length} models x ${grid.ages.length} ages x ${grid.repeats} repeats]`,
  );
  console.log(`  task=${grid.task} lang=${token} (QA_LANGUAGE=${locale}) temp=${grid.temperature}`);
  console.log(`  already done: ${skipped} | to run: ${pending.length}`);

  if (args.dryRun) {
    for (const r of respondents) {
      const tag = alreadyDone(r.runId, r.task) ? 'SKIP' : 'RUN ';
      console.log(`  [${tag}] ${r.runId}  model=${r.model} age=${r.age} temp=${r.temperature}`);
    }
    console.log('(dry run -- nothing executed)');
    return;
  }

  let i = 0;
  for (const r of pending) {
    i++;
    console.log(`\n[${i}/${pending.length}] ${new Date().toISOString()} START ${r.runId}`);
    const ok = runOne(r, byId);
    const mins = ((byId[r.runId].elapsedMs ?? 0) / 60000).toFixed(1);
    console.log(`           ${ok ? 'DONE' : 'FAILED'} ${r.runId} in ${mins} min (exit ${byId[r.runId].exitCode})`);
  }

  const done = Object.values(byId).filter((r) => r.status === 'done').length;
  const failed = Object.values(byId).filter((r) => r.status === 'failed').length;
  console.log(`\nROAR panel finished. done=${done} failed=${failed}. Manifest: ${MANIFEST.replace(REPO + '/', '')}`);
}

main();
