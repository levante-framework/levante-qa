#!/usr/bin/env node
/**
 * Headless assignment runner.
 *
 * Boots the QA dashboard (which already does provision → Cypress → score →
 * mirror-to-GCS), then drives it over HTTP to run every runnable task in a
 * single `qa-tests` assignment as one batch. Designed for CI
 * (.github/workflows/assignment-run.yml) so Pitwall can trigger an assignment
 * run and watch the results land in gs://levante-tools/levante-qa/.
 *
 * The dashboard tags every run with the shared --batch-id, so the Pitwall QA
 * Runs page can filter the batch as it fills in.
 *
 * Usage:
 *   node scripts/run-assignment.mjs --assignment-id=<id> [options]
 *   node scripts/run-assignment.mjs --assignment-name="QA All Tasks" [options]
 *
 * Options (flags or env):
 *   --assignment-id=<firestore id>     the administration to run
 *   --assignment-name=<name>           resolve the id by name instead
 *   --task-id=<kebab taskId>           run only this one task of the assignment
 *   --agent=oracle|vlm|child|wrong     (default oracle)
 *   --provider=openai|anthropic|gemini (VLM/child agents; default gemini)
 *   --age-years=N  --age-months=N      participant age (default 8 / 0)
 *   --batch-id=<id>                    correlate the batch (default random uuid)
 *   --batch-label=<text>               human label (default the assignment name)
 *   --run-timeout-ms=N                 per-task timeout (default 1800000 = 30min)
 *   --poll-ms=N                        status poll interval (default 5000)
 *   --fail-on-error                    exit 1 if any task errors/times out
 *
 * Env: anything the dashboard needs — LEVANTE_ADMIN_FIREBASE_CREDENTIALS (or a
 * levante-support/.env), GCP_SERVICE_ACCOUNT_JSON / GOOGLE_APPLICATION_CREDENTIALS
 * for the GCS mirror, OPENAI/ANTHROPIC/GEMINI keys for VLM agents,
 * LEVANTE_SUPPORT_DIR to point at the support checkout.
 */
import { spawn } from 'node:child_process';
import { execPath } from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const ARGV = process.argv.slice(2);
const hasFlag = (name) => ARGV.includes(`--${name}`);
const flagVal = (name) => {
  const hit = ARGV.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const PORT = Number(process.env.QA_DASHBOARD_PORT || 4180);
const DASHBOARD = (process.env.QA_DASHBOARD_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const AGENT = flagVal('agent') || process.env.RUN_AGENT || 'oracle';
const PROVIDER = flagVal('provider') || process.env.RUN_PROVIDER || 'gemini';
const AGE_YEARS = Number(flagVal('age-years') || process.env.RUN_AGE_YEARS || 8);
const AGE_MONTHS = Number(flagVal('age-months') || process.env.RUN_AGE_MONTHS || 0);
const BATCH_ID = flagVal('batch-id') || process.env.RUN_BATCH_ID || crypto.randomUUID();
const BATCH_LABEL = flagVal('batch-label') || process.env.RUN_BATCH_LABEL || null;
const RUN_TIMEOUT_MS = Math.max(60_000, Number(flagVal('run-timeout-ms') || process.env.RUN_TIMEOUT_MS || 30 * 60_000));
const POLL_MS = Math.max(2_000, Number(flagVal('poll-ms') || process.env.RUN_POLL_MS || 5_000));
const FAIL_ON_ERROR = hasFlag('fail-on-error') || /^(1|true|yes)$/i.test(process.env.RUN_FAIL_ON_ERROR || '');
const ASSIGNMENT_ID = flagVal('assignment-id') || process.env.RUN_ASSIGNMENT_ID || null;
const ASSIGNMENT_NAME = flagVal('assignment-name') || process.env.RUN_ASSIGNMENT_NAME || null;
// When set, run only this one task of the assignment (Pitwall fans an assignment
// out into one workflow run per task). Empty/unset runs every runnable task.
const TASK_ID = flagVal('task-id') || process.env.RUN_TASK_ID || null;

const log = (...a) => console.log(`[run-assignment ${new Date().toISOString()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = new Set(['passed', 'failed', 'error', 'cancelled']);

async function api(method, path, body) {
  const res = await fetch(`${DASHBOARD}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json?.error || text.slice(0, 300)}`);
  return json;
}

async function dashboardUp() {
  try { await api('GET', '/api/tasks'); return true; } catch { return false; }
}

let dashboardProc = null;
async function ensureDashboard() {
  if (await dashboardUp()) { log(`dashboard reachable at ${DASHBOARD}`); return; }
  log('dashboard down — starting `node dashboard/server.mjs`...');
  dashboardProc = spawn(execPath, ['dashboard/server.mjs'], {
    cwd: REPO_ROOT,
    env: { ...process.env },
    detached: true,
    stdio: 'ignore',
  });
  dashboardProc.unref();
  for (let i = 0; i < 45; i++) {
    await sleep(2_000);
    if (await dashboardUp()) { log('dashboard is up'); return; }
  }
  throw new Error('dashboard did not become reachable within 90s');
}

async function resolveAssignmentId() {
  if (ASSIGNMENT_ID) return ASSIGNMENT_ID;
  if (!ASSIGNMENT_NAME) throw new Error('provide --assignment-id or --assignment-name');
  const { assignments } = await api('GET', '/api/assignments');
  const match = assignments.find((a) => a.name === ASSIGNMENT_NAME)
    || assignments.find((a) => (a.name || '').toLowerCase() === ASSIGNMENT_NAME.toLowerCase());
  if (!match) {
    const names = assignments.map((a) => `"${a.name}"`).join(', ');
    throw new Error(`no assignment named "${ASSIGNMENT_NAME}". Available: ${names}`);
  }
  log(`resolved "${ASSIGNMENT_NAME}" → ${match.id}`);
  return match.id;
}

async function pollRun(runId) {
  const started = Date.now();
  const deadline = started + RUN_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    try { last = await api('GET', `/api/status?runId=${runId}`); } catch { continue; }
    if (TERMINAL.has(last.status)) return { ...last, durationMs: Date.now() - started };
  }
  try { await api('DELETE', `/api/run/${runId}`); } catch { /* best effort */ }
  return { runId, status: 'timeout', errors: [`timeout after ${Math.round(RUN_TIMEOUT_MS / 60000)}min`], durationMs: Date.now() - started };
}

async function main() {
  await ensureDashboard();
  const assignmentId = await resolveAssignmentId();

  const isVlmBacked = AGENT === 'vlm' || AGENT === 'child';
  const payload = {
    assignmentId,
    agent: AGENT,
    provider: isVlmBacked ? PROVIDER : null,
    ageYears: AGE_YEARS,
    ageMonths: AGE_MONTHS,
    batchId: BATCH_ID,
    ...(BATCH_LABEL ? { batchLabel: BATCH_LABEL } : {}),
    ...(TASK_ID ? { onlyTaskId: TASK_ID } : {}),
  };
  log(`starting assignment ${assignmentId}${TASK_ID ? ` · task=${TASK_ID}` : ''} · agent=${AGENT}${isVlmBacked ? `/${PROVIDER}` : ''} · batch=${BATCH_ID}`);

  const result = await api('POST', '/api/run-assignment', payload);
  const started = result.started || [];
  const skipped = result.skipped || [];
  log(`batch ${result.batchId}: ${started.length} task(s) started, ${skipped.length} skipped`);
  for (const s of skipped) log(`  skipped ${s.taskId}: ${s.reason}`);
  if (!started.length) throw new Error(result.error || 'no runnable tasks in this assignment');

  // Poll all runs to completion (in parallel — the dashboard runs them async).
  const outcomes = await Promise.all(
    started.map(async (s) => {
      log(`▶ ${s.taskLabel} (${s.taskId}) → ${s.runId}`);
      const r = await pollRun(s.runId);
      const acc = r.accuracy != null ? `${(r.accuracy * 100).toFixed(0)}%` : '—';
      const detail = r.status === 'passed' ? '' : ` — ${(r.errors || [])[0] || r.status}`;
      log(`${r.status === 'passed' ? '✓' : '✗'} ${s.taskLabel} → ${r.status} (acc ${acc}, ${Math.round(r.durationMs / 1000)}s)${detail}`);
      return { ...s, ...r };
    }),
  );

  const counts = outcomes.reduce((m, o) => ((m[o.status] = (m[o.status] || 0) + 1), m), {});
  log('---');
  log(`batch ${result.batchId} complete: ${outcomes.map((o) => `${o.taskId}=${o.status}`).join(', ')}`);
  log(`totals: ${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' · ')}`);
  log(`view: https://levante-web-dashboard.vercel.app/qa-runs.html (filter batch "${BATCH_LABEL || result.batchLabel}")`);

  const hadInfraError = outcomes.some((o) => o.status === 'error' || o.status === 'timeout');
  if (FAIL_ON_ERROR && hadInfraError) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error(`[run-assignment] FATAL: ${err?.stack || err?.message || err}`);
  process.exit(1);
});
