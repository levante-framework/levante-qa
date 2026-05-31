#!/usr/bin/env node
/**
 * LEVANTE-QA dashboard backend.
 *
 * A zero-dependency Node HTTP server that serves the Pitwall-styled UI and
 * orchestrates Cypress task runs. Each launch:
 *   1. provisions a unique, age-specific participant on hs-levante-admin-dev
 *      (via levante-support/scripts/e2e-init/provision-participant.mjs), then
 *   2. spawns `cypress run` in LAUNCH=dashboard mode as that participant, with
 *      logs/screenshots scoped per run so parallel launches never collide.
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
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { CATALOG, VLM_PROVIDERS, findTask } from './catalog.mjs';
import {
  downloadIndex,
  uploadIndex,
  uploadRunArtifacts,
  mergeIndexes,
  gcsTarget,
} from './storage.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const PUBLIC_DIR = join(__dirname, 'public');
const LOGS_ROOT = join(REPO_ROOT, 'cypress', 'logs', 'runs');
const RUNS_INDEX = join(REPO_ROOT, 'results', 'runs.json');
const SUPPORT_DIR = process.env.LEVANTE_SUPPORT_DIR
  ? resolve(process.env.LEVANTE_SUPPORT_DIR)
  : resolve(REPO_ROOT, '..', 'levante-support');
const PROVISIONER = join(SUPPORT_DIR, 'scripts', 'e2e-init', 'provision-participant.mjs');
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://hs-levante-admin-dev.web.app';
const PORT = Number(process.env.QA_DASHBOARD_PORT || 4180);
const MAX_LOG_LINES = 2000;

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
const DIAGNOSTIC_RE = /_(no_key|key_mismatch|unsolved)/;

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
    if (!/^(oracle|vlm)_.+\.jsonl$/.test(name)) continue;
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

  if (run.exitCode !== 0) {
    errors.push(`cypress exited with code ${run.exitCode}`);
  }

  return { accuracy, nTrials, errors, logDir: `cypress/logs/runs/${run.runId}` };
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
    ageYears: run.meta.ageYears,
    ageMonths: run.meta.ageMonths,
    persona: !!run.meta.persona,
    status: run.status,
    accuracy: run.accuracy,
    nTrials: run.nTrials,
    errors: run.errors,
    email: run.creds?.email ?? null,
    exitCode: run.exitCode,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime(),
    logDir: run.logDir,
    spec: run.meta.spec,
  });
  // Mirror the run's small JSONL artifacts to GCS (graceful no-op if disabled).
  uploadRunArtifacts(run.runId, join(LOGS_ROOT, run.runId)).catch(() => {});
}

function spawnCypress(run) {
  const task = findTask(run.meta.task);
  // 'child' is a VLM-backed run (same spec + provider) with the age persona
  // forced on, so it shares the VLM spec path.
  const isVlmBacked = run.meta.agent === 'vlm' || run.meta.agent === 'child';
  const spec = isVlmBacked ? task.vlmSpec : task.oracleSpec;
  run.meta.spec = spec;

  const env = { ...process.env };
  // Match the WSL workaround used for direct cypress runs in this environment.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CYPRESS_CACHE_FOLDER;
  env.LAUNCH = 'dashboard';
  env.DASHBOARD_URL = DASHBOARD_URL;
  env.PARTICIPANT_USER = run.creds.email;
  env.PARTICIPANT_PASS = run.creds.password;
  env.QA_RUN_ID = run.runId;
  if (isVlmBacked && run.meta.provider) {
    env.VLM_PROVIDER = run.meta.provider;
  }
  // 'child' runs force the age persona on: the model answers as a typical child
  // of the participant's age would, calibrated to LEVANTE accuracy-by-age data.
  if (run.meta.persona) {
    env.QA_PERSONA = 'child';
    env.QA_PERSONA_AGE_YEARS = String(run.meta.ageYears);
    env.QA_PERSONA_AGE_MONTHS = String(run.meta.ageMonths);
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
    '--age-years',
    String(run.meta.ageYears),
    '--age-months',
    String(run.meta.ageMonths),
    '--run-id',
    run.runId.slice(0, 8),
  ];
  appendLog(run, `[dashboard] provisioning participant (age ${run.meta.ageYears}y ${run.meta.ageMonths}m)...\n`);

  const child = spawn('node', args, { cwd: SUPPORT_DIR, env: { ...process.env }, detached: true });
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

function statusPayload(run) {
  return {
    runId: run.runId,
    status: run.status,
    meta: run.meta,
    exitCode: run.exitCode,
    accuracy: run.accuracy,
    nTrials: run.nTrials,
    errors: run.errors,
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
        const agent = p.agent === 'vlm' ? 'vlm' : p.agent === 'child' ? 'child' : 'oracle';
        const isVlmBacked = agent === 'vlm' || agent === 'child';
        if (isVlmBacked && !task.vlmSpec) {
          return sendJson(res, 400, { error: `${task.label} has no VLM agent (oracle only).` });
        }
        const provider = isVlmBacked ? String(p.provider || VLM_PROVIDERS[0]) : null;
        const ageYears = Number.isFinite(Number(p.ageYears)) ? Math.max(0, Math.floor(Number(p.ageYears))) : 8;
        const ageMonths = Number.isFinite(Number(p.ageMonths)) ? Math.max(0, Math.floor(Number(p.ageMonths))) : 0;
        // 'child' always simulates the participant's age; persona is intrinsic to it.
        const persona = agent === 'child';
        const runId = startRun({
          task: task.id,
          taskLabel: task.label,
          agent,
          provider,
          persona,
          ageYears,
          ageMonths,
          spec: isVlmBacked ? task.vlmSpec : task.oracleSpec,
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
    const run = runs.get(logMatch[1]);
    if (!run) return sendJson(res, 404, { error: 'Unknown runId' });
    sendJson(res, 200, { runId: run.runId, log: run.logLines.join('') });
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
  hydrateIndexFromGcs().catch((err) => {
    console.warn(`[gcs] index hydrate failed: ${err?.message || err}`);
  });
});
