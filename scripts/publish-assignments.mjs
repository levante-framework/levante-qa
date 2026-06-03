#!/usr/bin/env node
/**
 * Publishes the current `qa-tests` assignment list to
 * gs://levante-tools/levante-qa/assignments.json so the hosted Pitwall "QA Runs"
 * page can offer an assignment picker without Firestore access of its own.
 *
 * Reads the assignments via the read-only support lister
 * (levante-support/scripts/e2e-init/list-qa-assignments.mjs), annotates each
 * task with whether the QA dashboard has an agent for it, and uploads the JSON.
 *
 * Run locally or as a refresh step in CI. Requires the same Firebase Admin +
 * GCS credentials the dashboard uses.
 */
import { spawn } from 'node:child_process';
import { execPath } from 'node:process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG } from '../dashboard/catalog.mjs';
import { uploadJson, gcsTarget } from '../dashboard/storage.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SUPPORT_DIR = process.env.LEVANTE_SUPPORT_DIR
  ? resolve(process.env.LEVANTE_SUPPORT_DIR)
  : resolve(REPO_ROOT, '..', 'levante-support');
const LISTER = join(SUPPORT_DIR, 'scripts', 'e2e-init', 'list-qa-assignments.mjs');

const findTaskByTaskId = (taskId) => CATALOG.find((t) => t.taskId === taskId) ?? null;

function listQaAssignments() {
  return new Promise((res, rej) => {
    const child = spawn(execPath, [LISTER], { cwd: SUPPORT_DIR, env: { ...process.env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('error', rej);
    child.on('close', (code) => {
      const m = stdout.match(/ASSIGNMENTS_RESULT=(\[.*\])\s*$/m);
      if (code !== 0 || !m) {
        const first = stderr.split('\n').map((l) => l.trim()).find(Boolean);
        rej(new Error((first || `lister exited with code ${code}`).replace(/^\[qa-list-assignments\]\s*ERROR:\s*/, '')));
        return;
      }
      try { res(JSON.parse(m[1])); } catch (err) { rej(new Error(`could not parse assignment list: ${err?.message || err}`)); }
    });
  });
}

async function main() {
  const assignments = await listQaAssignments();
  const annotated = assignments.map((a) => ({
    ...a,
    tasks: (a.tasks || []).map((t) => {
      const task = findTaskByTaskId(t.taskId);
      return { ...t, label: task?.label ?? t.taskId, runnable: !!task, hasVlm: !!task?.vlmSpec };
    }),
    runnableCount: (a.tasks || []).filter((t) => findTaskByTaskId(t.taskId)).length,
  }));

  const payload = { updatedAt: new Date().toISOString(), count: annotated.length, assignments: annotated };
  const ok = await uploadJson('assignments.json', payload);
  if (!ok) {
    console.error('[publish-assignments] upload failed (GCS unavailable?) — printing payload instead.');
    console.log(JSON.stringify(payload, null, 2));
    process.exit(1);
  }
  console.log(`[publish-assignments] uploaded ${annotated.length} assignment(s) → ${gcsTarget()}/assignments.json`);
}

main().catch((err) => {
  console.error(`[publish-assignments] FATAL: ${err?.stack || err?.message || err}`);
  process.exit(1);
});
