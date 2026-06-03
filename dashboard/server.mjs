#!/usr/bin/env node
/**
 * LEVANTE-QA dashboard backend.
 *
 * A zero-dependency Node HTTP server that serves the Pitwall-styled UI and
 * orchestrates Cypress task runs. Each launch:
 *   1. provisions a unique, age-specific participant on hs-levante-admin-dev
 *      (via levante-support/scripts/e2e-init/provision-participant.mjs), then
 *   2. spawns `cypress run` in LAUNCH=dashboard mode as that participant, with
 *      logs/screenshots scoped per run and a per-run TMPDIR so Cypress lock
 *      files in /tmp do not collide when many tasks launch in parallel.
 * Runs are tracked in-memory; on completion a record is appended to
 * results/runs.json for the Results tab.
 *
 * Parallelism: every POST /api/run is fire-and-forget with its own run id, so
 * multiple runs proceed concurrently (the UI polls /api/status per run).
 *
 * Modeled on levante-support/scripts/local-testing-results-server.mjs.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { execPath } from 'node:process';
import { mkdirSync, existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import {
  CATALOG,
  VLM_PROVIDERS,
  LANGUAGES,
  DEFAULT_LANGUAGE,
  isSupportedLanguage,
  findTask,
  isTaskSupportedInLanguage,
  buildTaskSupport,
  FALLBACK_TASK_OPTIONS,
} from './catalog.mjs';
import {
  downloadIndex,
  uploadIndex,
  uploadRunArtifacts,
  mergeIndexes,
  gcsTarget,
  listRemoteArtifacts,
  downloadRemoteArtifact,
} from './storage.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const PUBLIC_DIR = join(__dirname, 'public');
const LOGS_ROOT = join(REPO_ROOT, 'cypress', 'logs', 'runs');
const RUNS_INDEX = join(REPO_ROOT, 'results', 'runs.json');
const SUPPORT_DIR = process.env.LEVANTE_SUPPORT_DIR
  ? resolve(process.env.LEVANTE_SUPPORT_DIR)
  : resolve(REPO_ROOT, '..', 'levante-support');
// The provisioner + assignment lister are vendored into this repo (scripts/e2e-init)
// so CI does not need to check out the private levante-support repo. We prefer the
// vendored copies and only fall back to a sibling levante-support checkout if the
// vendored scripts are missing.
const LOCAL_E2E_DIR = join(REPO_ROOT, 'scripts', 'e2e-init');
const HAS_LOCAL_E2E = existsSync(LOCAL_E2E_DIR);
const E2E_DIR = HAS_LOCAL_E2E ? LOCAL_E2E_DIR : join(SUPPORT_DIR, 'scripts', 'e2e-init');
// cwd for the spawned scripts decides which .env dotenv loads. Locally, levante-support/.env
// holds the Firebase creds, so use it when present; in CI the creds come from process.env
// and SUPPORT_DIR does not exist, so fall back to REPO_ROOT (which always exists).
const E2E_CWD = existsSync(SUPPORT_DIR) ? SUPPORT_DIR : REPO_ROOT;
const PROVISIONER = join(E2E_DIR, 'provision-participant.mjs');
const ASSIGNMENT_LISTER = join(E2E_DIR, 'list-qa-assignments.mjs');
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://hs-levante-admin-dev.web.app';
const PORT = Number(process.env.QA_DASHBOARD_PORT || 4180);
const MAX_LOG_LINES = 2000;

// ---------------------------------------------------------------------------
// Per-language task support (from the platform's languageoptions.json)
// ---------------------------------------------------------------------------
// Assets bucket env follows the dashboard target (admin-dev → levante-assets-dev).
const ASSETS_ENV =
  process.env.LEVANTE_ASSETS_ENV || (/admin-(\w+)/.exec(DASHBOARD_URL)?.[1] ?? 'dev');
const LANGUAGE_OPTIONS_URL = `https://storage.googleapis.com/levante-assets-${ASSETS_ENV}/translations/dashboard-consolidated-flat/languageoptions.json`;

/** taskOptions-by-language; seeded with the fallback, refreshed from the bucket. */
let taskOptionsByLang = FALLBACK_TASK_OPTIONS;

/** Fetch the live languageoptions.json once at startup; keep fallback on failure. */
async function loadLanguageOptions() {
  try {
    const res = await fetch(LANGUAGE_OPTIONS_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const next = {};
    for (const [code, entry] of Object.entries(json)) {
      if (Array.isArray(entry?.taskOptions)) next[code] = entry.taskOptions;
    }
    if (Object.keys(next).length) {
      // Merge so any language missing taskOptions (e.g. testing locales) keeps
      // its fallback, while configured languages take the live list.
      taskOptionsByLang = { ...FALLBACK_TASK_OPTIONS, ...next };
      console.log(`[dashboard] loaded task support for ${Object.keys(next).length} language(s) from languageoptions.json`);
    }
  } catch (err) {
    console.warn(`[dashboard] languageoptions.json fetch failed (${err?.message}); using built-in fallback.`);
  }
}

/** runId -> run record */
const runs = new Map();

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ---------------------------------------------------------------------------
// Run-index persistence (serialized writes so parallel runs don't clobber it)
// ---------------------------------------------------------------------------
let indexWriteChain = Promise.resolve();

async function readIndex() {
  try {
    const raw = await readFile(RUNS_INDEX, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function appendIndex(record) {
  indexWriteChain = indexWriteChain.then(async () => {
    const list = await readIndex();
    list.push(record);
    await mkdir(dirname(RUNS_INDEX), { recursive: true });
    await writeFile(RUNS_INDEX, JSON.stringify(list, null, 2) + '\n', 'utf-8');
    // Mirror to GCS (no-op/graceful if unavailable).
    await uploadIndex(list);
  });
  return indexWriteChain;
}

/**
 * On startup, fold any runs already in GCS into the local index so the Results
 * tab survives restarts and shows runs recorded by other machines.
 */
async function findIndexedRun(runId) {
  const [local, remote] = await Promise.all([readIndex(), downloadIndex()]);
  return mergeIndexes(local, remote).find((r) => r.runId === runId) || null;
}

async function listLocalArtifacts(runId) {
  try {
    const names = await readdir(join(LOGS_ROOT, runId));
    return names.filter((n) => n.endsWith('.jsonl'));
  } catch {
    return [];
  }
}

/** Reads a JSONL artifact from the local run dir, else GCS. */
async function readArtifactText(runId, name, maxBytes = 512_000) {
  const safe = String(name).replace(/[/\\]/g, '');
  if (!safe.endsWith('.jsonl')) return null;
  try {
    const raw = await readFile(join(LOGS_ROOT, runId, safe), 'utf-8');
    return raw.length > maxBytes ? raw.slice(-maxBytes) : raw;
  } catch {
    const remote = await downloadRemoteArtifact(runId, safe);
    if (!remote) return null;
    return remote.length > maxBytes ? remote.slice(-maxBytes) : remote;
  }
}

function tailJsonlLines(text, maxLines = 40) {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const slice = lines.slice(-maxLines);
  return { lines: slice, totalLines: lines.length, truncated: lines.length > maxLines };
}

async function hydrateIndexFromGcs() {
  const remote = await downloadIndex();
  if (!remote.length) return;
  indexWriteChain = indexWriteChain.then(async () => {
    const merged = mergeIndexes(await readIndex(), remote);
    await mkdir(dirname(RUNS_INDEX), { recursive: true });
    await writeFile(RUNS_INDEX, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  });
  await indexWriteChain;
}

// ---------------------------------------------------------------------------
// Result + serious-error detection from a run's scoped log dir
// ---------------------------------------------------------------------------
const DIAGNOSTIC_RE = /_(no_key|key_mismatch|unsolved|audio_content|match_stuck)/;

async function countLines(filePath) {
  try {
    const raw = await readFile(filePath, 'utf-8');
    return raw.split('\n').filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

async function parseArchive(filePath) {
  let nTrials = 0;
  let nCorrect = 0;
  try {
    const raw = await readFile(filePath, 'utf-8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof rec.correct === 'boolean') {
        nTrials += 1;
        if (rec.correct) nCorrect += 1;
      }
    }
  } catch {
    // unreadable
  }
  const accuracy = nTrials > 0 ? nCorrect / nTrials : null;
  return { nTrials, nCorrect, accuracy };
}

/**
 * Pull a concise, human-readable failure out of the raw Cypress console output
 * so the UI can show "what broke" instead of just an exit code. Returns
 * `{ summary, detail }` where `summary` is a one-liner (the assertion / error
 * message) and `detail` is the surrounding failing-test block for an info popout.
 *
 * Handles the two common mocha spec-reporter shapes:
 *   N) <describe>                          N) <describe>
 *        <test>:                                <test>:
 *      AssertionError: <msg>          or      <bare assertion message>
 *       at <stack>                            + expected - actual
 *                                              at <stack>
 */
function extractCypressFailure(logText) {
  if (!logText) return null;
  const lines = logText.split('\n');

  // Last numbered failing-test header (there may be several runs in one log).
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s{0,6}\d+\)\s+\S/.test(lines[i])) {
      start = i;
      break;
    }
  }

  // Collect the failing block (cap length; stop at the results table / summary).
  const block = [];
  if (start >= 0) {
    for (let i = start; i < lines.length && block.length < 30; i++) {
      const l = lines[i];
      if (/[┌─│└]/.test(l) || /\(Results\)|\(Run Finished\)|Spec Ran:|\d+ passing/.test(l)) break;
      block.push(l.replace(/\s+$/, ''));
    }
  }
  const scope = block.length ? block : lines;

  let summary = null;
  // 1) Explicit error class with a message.
  for (const l of scope) {
    const m = l.match(
      /\b(AssertionError|CypressError|TypeError|ReferenceError|SyntaxError|RangeError|Error)\b:\s*(.+)/,
    );
    if (m) {
      summary = `${m[1]}: ${m[2].trim()}`;
      break;
    }
  }
  // 2) Bare assertion message printed under the test title.
  if (!summary && block.length > 1) {
    for (let i = 1; i < block.length; i++) {
      const t = block[i].trim();
      if (!t || t.endsWith(':')) continue; // blank or the test-title line
      if (/^[+-]\s|^at\s|^expected\b|^actual\b/.test(t)) continue;
      summary = t;
      break;
    }
  }
  if (!summary) return null;

  if (summary.length > 180) summary = `${summary.slice(0, 177)}…`;
  const detail = (block.length ? block : scope.slice(-30)).join('\n').trim();
  return { summary, detail: detail.slice(0, 4000) };
}

/**
 * Inspects the run's scoped log dir for the final archive (accuracy/counts) and
 * any non-empty diagnostic logs (serious errors). Combined with the Cypress
 * exit code, this yields the pass/fail verdict.
 */
async function computeRunResults(run) {
  const dir = join(LOGS_ROOT, run.runId);
  const errors = [];
  let accuracy = null;
  let nTrials = 0;

  let files = [];
  try {
    files = await readdir(dir);
  } catch {
    files = [];
  }

  // Newest archive file (oracle_* / vlm_*, not the underscore-prefixed live or
  // diagnostic logs).
  const archives = [];
  for (const name of files) {
    if (!/^(oracle|vlm|wrong)_.+\.jsonl$/.test(name)) continue;
    try {
      const s = await stat(join(dir, name));
      archives.push({ name, mtime: s.mtimeMs });
    } catch {
      // ignore
    }
  }
  archives.sort((a, b) => b.mtime - a.mtime);

  if (archives.length > 0) {
    const parsed = await parseArchive(join(dir, archives[0].name));
    accuracy = parsed.accuracy;
    nTrials = parsed.nTrials;
  } else {
    // Fall back to the live log if the run was killed before finalize().
    const live = files.find((n) => /_live\.jsonl$/.test(n));
    if (live) {
      const parsed = await parseArchive(join(dir, live));
      accuracy = parsed.accuracy;
      nTrials = parsed.nTrials;
    }
  }

  // Serious errors: non-empty diagnostic logs.
  for (const name of files) {
    if (!DIAGNOSTIC_RE.test(name)) continue;
    const n = await countLines(join(dir, name));
    if (n > 0) errors.push(`${name}: ${n} entr${n === 1 ? 'y' : 'ies'}`);
  }

  let failureDetail = null;
  if (run.exitCode !== 0) {
    const failure = extractCypressFailure(run.logLines.join(''));
    if (failure) {
      errors.push(failure.summary);
      failureDetail = failure.detail;
    } else {
      errors.push(`Cypress exited with code ${run.exitCode} (see log for details)`);
    }
  }

  return { accuracy, nTrials, errors, failureDetail, logDir: `cypress/logs/runs/${run.runId}` };
}

// ---------------------------------------------------------------------------
// Run orchestration
// ---------------------------------------------------------------------------
function appendLog(run, chunk) {
  const text = chunk.toString();
  run.logLines.push(text);
  if (run.logLines.length > MAX_LOG_LINES) {
    run.logLines.splice(0, run.logLines.length - MAX_LOG_LINES);
  }
}

/**
 * Terminates a run's active child process tree (provisioner or Cypress).
 * Spawned detached, so we signal the whole process group. Returns true if a
 * live process was signalled.
 */
function killRun(run) {
  run.cancelled = true;
  const proc = run.proc;
  if (!proc || proc.exitCode !== null || proc.signalCode) return false;
  const pid = proc.pid;
  if (!pid) return false;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try { proc.kill('SIGTERM'); } catch { /* already gone */ }
  }
  // Escalate if it doesn't exit on its own.
  setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
  }, 4000);
  return true;
}

async function finalizeRun(run) {
  // Cancelled runs are aborted by the user and not recorded in run history.
  if (run.cancelled) {
    run.status = 'cancelled';
    run.finishedAt = new Date().toISOString();
    return;
  }
  run.finishedAt = new Date().toISOString();
  const results = await computeRunResults(run);
  run.accuracy = results.accuracy;
  run.nTrials = results.nTrials;
  run.errors = results.errors;
  run.failureDetail = results.failureDetail ?? null;
  run.logDir = results.logDir;
  if (run.status !== 'error') {
    run.status = run.exitCode === 0 && results.errors.length === 0 ? 'passed' : 'failed';
  }
  await appendIndex({
    runId: run.runId,
    task: run.meta.task,
    taskLabel: run.meta.taskLabel,
    agent: run.meta.agent,
    provider: run.meta.provider,
    language: run.meta.language ?? null,
    ageYears: run.meta.ageYears,
    ageMonths: run.meta.ageMonths,
    persona: !!run.meta.persona,
    personaAbility: run.meta.personaAbility ?? null,
    status: run.status,
    accuracy: run.accuracy,
    nTrials: run.nTrials,
    errors: run.errors,
    failureDetail: run.failureDetail ?? null,
    email: run.creds?.email ?? null,
    exitCode: run.exitCode,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime(),
    logDir: run.logDir,
    spec: run.meta.spec,
    batchId: run.meta.batchId ?? null,
    batchLabel: run.meta.batchLabel ?? null,
  });
  // Persist Cypress console output + mirror artifacts to GCS.
  const runLogDir = join(LOGS_ROOT, run.runId);
  if (run.logLines.length) {
    mkdir(runLogDir, { recursive: true })
      .then(() => writeFile(join(runLogDir, 'dashboard.log'), run.logLines.join(''), 'utf-8'))
      .then(() => uploadRunArtifacts(run.runId, runLogDir))
      .catch(() => {});
  } else {
    uploadRunArtifacts(run.runId, runLogDir).catch(() => {});
  }
}

function specForAgent(task, agent) {
  if (agent === 'wrong') return task.wrongSpec;
  if (agent === 'vlm' || agent === 'child') return task.vlmSpec;
  return task.oracleSpec;
}

function spawnCypress(run) {
  const task = findTask(run.meta.task);
  const isVlmBacked = run.meta.agent === 'vlm' || run.meta.agent === 'child';
  const spec = specForAgent(task, run.meta.agent);
  run.meta.spec = spec;

  const env = { ...process.env };
  // Match the WSL workaround used for direct cypress runs in this environment.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CYPRESS_CACHE_FOLDER;
  // Cypress uses $TMPDIR/cypress-<uid>/*.lock; parallel dashboard launches need
  // isolated temp dirs or the second+ instance fails immediately (EEXIST).
  const cypressTmp = join(tmpdir(), 'levante-qa-cypress', run.runId);
  mkdirSync(cypressTmp, { recursive: true });
  env.TMPDIR = cypressTmp;
  env.TEMP = cypressTmp;
  env.TMP = cypressTmp;
  env.LAUNCH = 'dashboard';
  env.DASHBOARD_URL = DASHBOARD_URL;
  env.PARTICIPANT_USER = run.creds.email;
  env.PARTICIPANT_PASS = run.creds.password;
  env.QA_RUN_ID = run.runId;
  // Drive the app's UI + narration locale (QA_LANGUAGE, read by the launch
  // helper → sessionStorage) and assert it on the audio side
  // (QA_EXPECTED_AUDIO_LANG, read by the ID3 reader).
  if (run.meta.language) {
    env.QA_LANGUAGE = run.meta.language;
    env.QA_EXPECTED_AUDIO_LANG = run.meta.language;
  }
  if (isVlmBacked && run.meta.provider) {
    env.VLM_PROVIDER = run.meta.provider;
  }
  if (run.meta.agent === 'wrong') {
    env.QA_AGENT_MODE = 'wrong';
  }
  // 'child' runs force the age persona on: the model answers as a typical child
  // of the participant's age would, calibrated to LEVANTE accuracy-by-age data.
  if (run.meta.persona) {
    env.QA_PERSONA = 'child';
    env.QA_PERSONA_AGE_YEARS = String(run.meta.ageYears);
    env.QA_PERSONA_AGE_MONTHS = String(run.meta.ageMonths);
    if (run.meta.personaAbility === 'irt') {
      env.QA_PERSONA_ABILITY = 'irt';
    }
  }

  const args = [
    'cypress',
    'run',
    '--spec',
    spec,
    '--config',
    `screenshotsFolder=cypress/screenshots/runs/${run.runId}`,
  ];
  if (isVlmBacked && run.meta.provider) {
    args.push('--env', `provider=${run.meta.provider}`);
  }

  appendLog(run, `\n[dashboard] launching: npx ${args.join(' ')}\n`);
  // detached → its own process group so cancellation can kill the whole tree
  // (cypress spawns an Electron/browser child of its own).
  const child = spawn('npx', args, { cwd: REPO_ROOT, env, detached: true });
  run.pid = child.pid;
  run.proc = child;
  run.status = 'running';

  child.stdout.on('data', (c) => appendLog(run, c));
  child.stderr.on('data', (c) => appendLog(run, c));
  child.on('error', (err) => {
    appendLog(run, `\n[dashboard] cypress spawn error: ${err?.message || err}\n`);
  });
  child.on('close', (code) => {
    run.exitCode = code ?? 1;
    finalizeRun(run).catch((err) => {
      appendLog(run, `\n[dashboard] finalize error: ${err?.message || err}\n`);
    });
  });
}

function provisionThenRun(run) {
  const args = [
    PROVISIONER,
    '--task',
    findTask(run.meta.task).taskId,
    '--language',
    run.meta.language || DEFAULT_LANGUAGE,
    '--age-years',
    String(run.meta.ageYears),
    '--age-months',
    String(run.meta.ageMonths),
    '--run-id',
    run.runId.slice(0, 8),
  ];
  appendLog(run, `[dashboard] provisioning participant (age ${run.meta.ageYears}y ${run.meta.ageMonths}m)...\n`);

  const child = spawn(execPath, args, { cwd: E2E_CWD, env: { ...process.env }, detached: true });
  run.proc = child;
  let stdout = '';
  child.stdout.on('data', (c) => {
    stdout += c.toString();
    appendLog(run, c);
  });
  child.stderr.on('data', (c) => appendLog(run, c));
  child.on('error', (err) => {
    run.status = 'error';
    run.exitCode = 1;
    appendLog(run, `\n[dashboard] provisioner spawn error: ${err?.message || err}\n`);
    finalizeRun(run).catch(() => {});
  });
  child.on('close', (code) => {
    const match = stdout.match(/PROVISION_RESULT=(\{.*\})\s*$/m);
    if (code !== 0 || !match) {
      run.status = 'error';
      run.exitCode = code ?? 1;
      run.errors = ['provisioning failed (see log)'];
      appendLog(run, `\n[dashboard] provisioning failed (exit ${code}).\n`);
      finalizeRun(run).catch(() => {});
      return;
    }
    try {
      const creds = JSON.parse(match[1]);
      run.creds = creds;
      appendLog(run, `[dashboard] provisioned ${creds.email} (uid=${creds.uid}); launching task...\n`);
      spawnCypress(run);
    } catch (err) {
      run.status = 'error';
      run.exitCode = 1;
      run.errors = [`could not parse provisioning result: ${err?.message || err}`];
      finalizeRun(run).catch(() => {});
    }
  });
}

function startRun(meta) {
  const runId = crypto.randomUUID();
  const run = {
    runId,
    meta,
    status: 'provisioning',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    accuracy: null,
    nTrials: 0,
    errors: [],
    logLines: [],
    creds: null,
  };
  runs.set(runId, run);
  provisionThenRun(run);
  return runId;
}

/**
 * Spawn the read-only assignment lister (in levante-support, which has
 * firebase-admin) and parse its `ASSIGNMENTS_RESULT=` line. Rejects with the
 * collected stderr on a non-zero exit so the caller can surface a useful error.
 */
function listQaAssignments() {
  return new Promise((resolve, reject) => {
    const child = spawn(execPath, [ASSIGNMENT_LISTER], { cwd: E2E_CWD, env: { ...process.env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      const match = stdout.match(/ASSIGNMENTS_RESULT=(\[.*\])\s*$/m);
      if (code !== 0 || !match) {
        // Surface just the first line (the rest is a Node stack trace).
        const firstLine = stderr.split('\n').map((l) => l.trim()).find(Boolean);
        reject(new Error((firstLine || `lister exited with code ${code}`).replace(/^\[qa-list-assignments\]\s*ERROR:\s*/, '')));
        return;
      }
      try {
        resolve(JSON.parse(match[1]));
      } catch (err) {
        reject(new Error(`could not parse assignment list: ${err?.message || err}`));
      }
    });
  });
}

/** Catalog entry whose kebab `taskId` matches (e.g. "egma-math"), or null. */
function findTaskByTaskId(taskId) {
  return CATALOG.find((t) => t.taskId === taskId) ?? null;
}

/**
 * Fan an assignment's tasks out into one run per supported task, all sharing a
 * `batchId`. Returns `{ batchId, batchLabel, started, skipped }`.
 */
function startAssignmentRuns(assignment, opts) {
  // Honor a caller-supplied batchId (e.g. a Pitwall-triggered CI run that wants
  // to correlate the resulting runs) but fall back to a fresh one.
  const batchId = opts.batchId ? String(opts.batchId) : crypto.randomUUID();
  const batchLabel = opts.batchLabel ? String(opts.batchLabel) : assignment.name || 'assignment';
  const agent = ['vlm', 'child', 'wrong'].includes(opts.agent) ? opts.agent : 'oracle';
  const isVlmBacked = agent === 'vlm' || agent === 'child';
  const provider = isVlmBacked ? String(opts.provider || VLM_PROVIDERS[0]) : null;
  const ageYears = Number.isFinite(Number(opts.ageYears)) ? Math.max(0, Math.floor(Number(opts.ageYears))) : 8;
  const ageMonths = Number.isFinite(Number(opts.ageMonths)) ? Math.max(0, Math.floor(Number(opts.ageMonths))) : 0;
  const persona = agent === 'child';
  const personaAbility = persona && opts.personaAbility === 'irt' ? 'irt' : null;

  const started = [];
  const skipped = [];
  // De-dupe taskIds (an assignment can list a task more than once).
  const seen = new Set();
  for (const t of assignment.tasks || []) {
    if (seen.has(t.taskId)) continue;
    seen.add(t.taskId);
    const task = findTaskByTaskId(t.taskId);
    if (!task) {
      skipped.push({ taskId: t.taskId, reason: 'no QA agent for this task' });
      continue;
    }
    if (agent === 'wrong' && !task.wrongSpec) {
      skipped.push({ taskId: t.taskId, reason: `${task.label} has no Wrong agent spec` });
      continue;
    }
    if (isVlmBacked && !task.vlmSpec) {
      skipped.push({ taskId: t.taskId, reason: `${task.label} is oracle-only (no VLM agent)` });
      continue;
    }
    // Honor the assignment's per-task language when we recognize it; else default.
    const language = isSupportedLanguage(t.language) ? t.language : DEFAULT_LANGUAGE;
    if (!isTaskSupportedInLanguage(task, language, taskOptionsByLang)) {
      skipped.push({ taskId: t.taskId, reason: `${task.label} not supported in ${language}` });
      continue;
    }
    const runId = startRun({
      task: task.id,
      taskLabel: task.label,
      agent,
      provider,
      language,
      persona,
      personaAbility,
      ageYears,
      ageMonths,
      spec: specForAgent(task, agent),
      batchId,
      batchLabel,
    });
    started.push({ runId, taskId: task.taskId, taskLabel: task.label });
  }
  return { batchId, batchLabel, started, skipped };
}

function statusPayload(run) {
  return {
    runId: run.runId,
    status: run.status,
    meta: run.meta,
    exitCode: run.exitCode,
    accuracy: run.accuracy,
    nTrials: run.nTrials,
    errors: run.errors,
    failureDetail: run.failureDetail ?? null,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    email: run.creds?.email ?? null,
    logTail: run.logLines.slice(-60).join(''),
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = resolve(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const file = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(filePath)] || 'application/octet-stream' });
    res.end(file);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  if (req.method === 'GET' && pathname === '/api/tasks') {
    sendJson(res, 200, {
      tasks: CATALOG.map((t) => ({ id: t.id, label: t.label, taskId: t.taskId, hasVlm: !!t.vlmSpec })),
      providers: VLM_PROVIDERS,
      languages: LANGUAGES,
      // { langCode: [supported catalog id, ...] } so the UI can gray out the rest.
      taskSupport: buildTaskSupport(taskOptionsByLang),
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/assignments') {
    try {
      const assignments = await listQaAssignments();
      // Annotate each task with whether the dashboard has a QA agent for it.
      const annotated = assignments.map((a) => ({
        ...a,
        tasks: (a.tasks || []).map((t) => {
          const task = findTaskByTaskId(t.taskId);
          return {
            ...t,
            label: task?.label ?? t.taskId,
            runnable: !!task,
            hasVlm: !!task?.vlmSpec,
          };
        }),
      }));
      sendJson(res, 200, { assignments: annotated });
    } catch (err) {
      sendJson(res, 502, { error: `Could not list assignments: ${err?.message || err}` });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/run-assignment') {
    let body = '';
    req.on('data', (c) => (body += c.toString()));
    req.on('end', async () => {
      try {
        const p = JSON.parse(body || '{}');
        if (!p.assignmentId) return sendJson(res, 400, { error: 'Missing assignmentId' });
        const assignments = await listQaAssignments();
        const assignment = assignments.find((a) => a.id === p.assignmentId);
        if (!assignment) return sendJson(res, 404, { error: `Unknown assignment: ${p.assignmentId}` });
        const result = startAssignmentRuns(assignment, p);
        if (!result.started.length) {
          return sendJson(res, 400, {
            error: 'No runnable tasks in this assignment for the chosen agent.',
            ...result,
          });
        }
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 500, { error: err?.message || 'Failed to start assignment runs' });
      }
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/run') {
    let body = '';
    req.on('data', (c) => (body += c.toString()));
    req.on('end', () => {
      try {
        const p = JSON.parse(body || '{}');
        const task = findTask(p.taskId);
        if (!task) return sendJson(res, 400, { error: `Unknown task: ${p.taskId}` });
        const agent = ['vlm', 'child', 'wrong'].includes(p.agent) ? p.agent : 'oracle';
        const isVlmBacked = agent === 'vlm' || agent === 'child';
        if (agent === 'wrong' && !task.wrongSpec) {
          return sendJson(res, 400, { error: `${task.label} has no Wrong agent spec.` });
        }
        if (isVlmBacked && !task.vlmSpec) {
          return sendJson(res, 400, { error: `${task.label} has no VLM agent (oracle only).` });
        }
        const provider = isVlmBacked ? String(p.provider || VLM_PROVIDERS[0]) : null;
        const language = isSupportedLanguage(p.language) ? p.language : DEFAULT_LANGUAGE;
        if (!isTaskSupportedInLanguage(task, language, taskOptionsByLang)) {
          return sendJson(res, 400, {
            error: `${task.label} is not supported in ${language}.`,
          });
        }
        const ageYears = Number.isFinite(Number(p.ageYears)) ? Math.max(0, Math.floor(Number(p.ageYears))) : 8;
        const ageMonths = Number.isFinite(Number(p.ageMonths)) ? Math.max(0, Math.floor(Number(p.ageMonths))) : 0;
        // 'child' always simulates the participant's age; persona is intrinsic to it.
        const persona = agent === 'child';
        const personaAbility =
          persona && p.personaAbility === 'irt' ? 'irt' : null;
        const runId = startRun({
          task: task.id,
          taskLabel: task.label,
          agent,
          provider,
          language,
          persona,
          personaAbility,
          ageYears,
          ageMonths,
          spec: specForAgent(task, agent),
        });
        sendJson(res, 200, { runId });
      } catch (err) {
        sendJson(res, 500, { error: err?.message || 'Failed to start run' });
      }
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/status') {
    const runId = url.searchParams.get('runId');
    const run = runId && runs.get(runId);
    if (!run) return sendJson(res, 404, { error: 'Unknown runId' });
    sendJson(res, 200, statusPayload(run));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/runs') {
    const [local, remote] = await Promise.all([readIndex(), downloadIndex()]);
    const list = mergeIndexes(local, remote);
    // Newest first.
    list.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    sendJson(res, 200, { runs: list });
    return;
  }

  const logMatch = pathname.match(/^\/api\/run\/([^/]+)\/log$/);
  if (req.method === 'GET' && logMatch) {
    const runId = logMatch[1];
    const live = runs.get(runId);
    if (live) {
      sendJson(res, 200, { runId, log: live.logLines.join('') });
      return;
    }
    let log = null;
    try {
      log = await readFile(join(LOGS_ROOT, runId, 'dashboard.log'), 'utf-8');
    } catch {
      log = await downloadRemoteArtifact(runId, 'dashboard.log');
    }
    if (!log) return sendJson(res, 404, { error: 'No log saved for this run' });
    sendJson(res, 200, { runId, log });
    return;
  }

  const artifactMatch = pathname.match(/^\/api\/run\/([^/]+)\/artifact$/);
  if (req.method === 'GET' && artifactMatch) {
    const runId = artifactMatch[1];
    const name = url.searchParams.get('name');
    if (!name) return sendJson(res, 400, { error: 'Missing name query param' });
    const text = await readArtifactText(runId, name);
    if (!text) return sendJson(res, 404, { error: 'Artifact not found' });
    const tail = Number(url.searchParams.get('tail') || 40);
    const parsed = tailJsonlLines(text, Math.min(200, Math.max(1, tail)));
    sendJson(res, 200, { runId, name, ...parsed });
    return;
  }

  const detailsMatch = pathname.match(/^\/api\/run\/([^/]+)$/);
  if (req.method === 'GET' && detailsMatch) {
    const runId = detailsMatch[1];
    const record = await findIndexedRun(runId);
    if (!record) return sendJson(res, 404, { error: 'Unknown runId' });
    const [localArts, remoteArts] = await Promise.all([
      listLocalArtifacts(runId),
      listRemoteArtifacts(runId),
    ]);
    const artifacts = [...new Set([...localArts, ...remoteArts])].sort();
    const gcs = gcsTarget();
    sendJson(res, 200, {
      run: record,
      artifacts,
      gcsUri: gcs ? `${gcs}/runs/${runId}/` : null,
      hasLiveLog: runs.has(runId),
    });
    return;
  }

  const cancelMatch = pathname.match(/^\/api\/run\/([^/]+)$/);
  if (req.method === 'DELETE' && cancelMatch) {
    const run = runs.get(cancelMatch[1]);
    if (!run) return sendJson(res, 404, { error: 'Unknown runId' });
    const killed = killRun(run);
    appendLog(run, `\n[dashboard] run cancelled by user${killed ? ' — terminating process' : ''}.\n`);
    runs.delete(run.runId);
    sendJson(res, 200, { ok: true, killed });
    return;
  }

  if (req.method === 'GET') {
    await serveStatic(res, pathname);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\nLEVANTE-QA dashboard → http://localhost:${PORT}`);
  console.log(`  repo:        ${REPO_ROOT}`);
  console.log(`  provisioner: ${PROVISIONER}`);
  console.log(`  runs index:  ${RUNS_INDEX}`);
  console.log(`  gcs store:   ${gcsTarget() || '(disabled)'}\n`);
  loadLanguageOptions();
  hydrateIndexFromGcs().catch((err) => {
    console.warn(`[gcs] index hydrate failed: ${err?.message || err}`);
  });
});
