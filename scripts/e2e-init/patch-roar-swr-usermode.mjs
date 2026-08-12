#!/usr/bin/env node
/**
 * Patch the local vite roar-swr prebundle so QA can run alternate userModes
 * (e.g. adaptiveTimingMultiStage) without writing them through updateTaskParams.
 *
 * Strategy: keep Firestore write on stock gameParams (`a2` values only). Set
 * the desired mode via TaskSWR userParams / QA_SWR_USER_MODE (merged into n2).
 *
 * Restores from `.qa-orig` when mode is empty.
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

function dashboardRoot() {
  const fromEnv = process.env.LEVANTE_DASHBOARD_ROOT || process.env.DASHBOARD_ROOT;
  if (fromEnv) return fromEnv;
  return '/home/david/levante/levante-dashboard';
}

function depPath() {
  return join(dashboardRoot(), 'node_modules', '.vite', 'deps', '@bdelab_roar-swr.js');
}

/** Make updateTaskParams use stock gameParams only (ignore merged E2 values). */
function applyStockJ2(body) {
  return body.replace(
    'Object.fromEntries(Object.entries(a2).map(([e10, a3]) => [e10, E2[e10] ?? a3]));',
    'Object.fromEntries(Object.entries(a2).map(([e10, a3]) => [e10, a3]));',
  );
}

export function patchRoarSwrUserMode(mode) {
  const target = depPath();
  if (!existsSync(target)) {
    return { ok: false, reason: `missing prebundle: ${target}` };
  }
  const backup = `${target}.qa-orig`;
  if (!existsSync(backup)) {
    copyFileSync(target, backup);
  }

  if (!mode) {
    copyFileSync(backup, target);
    return { ok: true, restored: true, path: target };
  }

  let body = readFileSync(backup, 'utf8');
  if (!body.includes('adaptiveTimingMultiStage') && mode === 'adaptiveTimingMultiStage') {
    return { ok: false, reason: 'prebundle lacks adaptiveTimingMultiStage' };
  }
  if (!body.includes('Object.fromEntries(Object.entries(a2).map(([e10, a3]) => [e10, E2[e10] ?? a3]));')) {
    return { ok: false, reason: 'prebundle shape unexpected (no j2 merge)' };
  }

  body = applyStockJ2(body);
  writeFileSync(target, body);
  return {
    ok: true,
    path: target,
    mode,
    stockJ2: body.includes('Object.fromEntries(Object.entries(a2).map(([e10, a3]) => [e10, a3]));'),
    note: 'Set userMode via TaskSWR userParams / QA_SWR_USER_MODE; restart vite without --force',
  };
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('patch-roar-swr-usermode.mjs') ||
    process.argv[1].includes('patch-roar-swr-usermode'));

if (isMain) {
  const mode = process.argv[2] || '';
  const result = patchRoarSwrUserMode(mode);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}
