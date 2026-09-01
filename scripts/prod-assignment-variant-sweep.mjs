#!/usr/bin/env node
/**
 * Open-assignment variant sweep on hs-levante-admin-prod.
 *
 * Sites pin a specific task pack (`variantId`) on each assignment. After a pack
 * is unregistered, those open assignments keep using the leftover — kids then
 * hit wrong language tags, missing audio folders, or a splash that never
 * continues. The nightly -dev oracle sweep only plays *registered* packs, so it
 * misses this.
 *
 * This script:
 *   1. Reads every open (live) administration on -prod (no Auth users, no
 *      writes) and lists the unique packs in use.
 *   2. Looks each pack up under tasks/{task}/variants/{id} and flags
 *      unregistered ("stale"), missing, or no-id rows.
 *   3. Optionally runs the oracle. Default write target is -dev qa-tests.
 *      `--oracle-on-prod` provisions a qa-tests kid on -prod and plays against
 *      platform.levante-network.org. It never mutates field assignments.
 *
 * Usage:
 *   pnpm run prod-variant-sweep                  # inventory (read-only, field sites)
 *   pnpm run prod-variant-sweep -- --run-oracle  # replay leftovers on -dev
 *   pnpm run prod-variant-sweep -- --oracle-on-prod  # replay leftovers on -prod qa-tests
 *
 * Snapshots: results/prod-assignment-variants/<YYYY-MM-DD>.{json,md}
 *
 * Flags: --dry-run  --run-oracle  --oracle-on-prod  --oracle-all  --no-slack
 *        --include-sandbox  --include-test-data  --tasks=vocab,trog
 *        --concurrency=N  --max-variants=N
 */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findTaskByTaskId, canonicalQaLocale } from '../dashboard/catalog.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SNAPSHOT_DIR = join(REPO_ROOT, 'results', 'prod-assignment-variants');

const ARGV = process.argv.slice(2).filter((a) => a !== '--');
const hasFlag = (name) => ARGV.includes(`--${name}`);
const flagVal = (name) => {
  const hit = ARGV.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const csv = (v) =>
  v
    ? v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : null;

const FIRESTORE_PROJECT = process.env.PROD_FIRESTORE_PROJECT || 'hs-levante-admin-prod';
const DASHBOARD = (process.env.QA_DASHBOARD_URL || `http://localhost:${process.env.QA_DASHBOARD_PORT || 4180}`).replace(
  /\/$/,
  '',
);
const AGENT = process.env.SWEEP_AGENT || 'oracle';
const CONCURRENCY = Math.max(1, Number(flagVal('concurrency') || process.env.SWEEP_CONCURRENCY || 4));
const RUN_TIMEOUT_MS = Math.max(60_000, Number(process.env.SWEEP_RUN_TIMEOUT_MS || 30 * 60_000));
const POLL_MS = Math.max(2_000, Number(process.env.SWEEP_POLL_MS || 5_000));
const AUTOSTART = !/^(0|false|no)$/i.test(process.env.SWEEP_AUTOSTART || '');
const DRY_RUN = hasFlag('dry-run');
const NO_SLACK = hasFlag('no-slack');
const INCLUDE_TEST_DATA = hasFlag('include-test-data');
const INCLUDE_SANDBOX = hasFlag('include-sandbox');
const ORACLE_ALL = hasFlag('oracle-all');
const ORACLE_ON_PROD = hasFlag('oracle-on-prod');
const RUN_ORACLE = hasFlag('run-oracle') || ORACLE_ALL || ORACLE_ON_PROD;
const PROD_DASHBOARD_URL = (process.env.PROD_DASHBOARD_URL || 'https://platform.levante-network.org').replace(
  /\/$/,
  '',
);
const PROD_WRITE_PROJECT = process.env.PROD_WRITE_PROJECT || 'hs-levante-admin-prod';
const ONLY_TASKS = csv(flagVal('tasks'));
const MAX_VARIANTS = Number(flagVal('max-variants') || 0) || null;
const AGE_YEARS = Number(process.env.SWEEP_AGE_YEARS || 8);
const AGE_MONTHS = Number(process.env.SWEEP_AGE_MONTHS || 0);
const SKIP_SITES = new Set((process.env.SWEEP_SKIP_SITES || 'qa-tests').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

const PT = 'America/Los_Angeles';
const SITE_SAMPLE = 6;

function todayStr(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: PT,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function formatPtStamp(date = new Date()) {
  const when = date instanceof Date ? date : new Date(date);
  const clock = new Intl.DateTimeFormat('en-US', {
    timeZone: PT,
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).format(when);
  return `${todayStr(when)} ${clock}`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const min = m % 60;
  return min ? `${h}h ${min}m` : `${h}h`;
}

const log = (...a) => console.log(`[prod-variants ${formatPtStamp()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Firestore REST --------------------------------------------------------
function unwrap(v) {
  if (v == null) return v;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.nullValue !== undefined) return null;
  if (v.arrayValue) return (v.arrayValue.values || []).map(unwrap);
  if (v.mapValue) {
    const o = {};
    for (const [k, vv] of Object.entries(v.mapValue.fields || {})) o[k] = unwrap(vv);
    return o;
  }
  return v;
}

function docFields(doc) {
  const f = {};
  for (const [k, v] of Object.entries(doc?.fields || {})) f[k] = unwrap(v);
  return f;
}

function docId(name) {
  return String(name || '').split('/').pop();
}

async function getAccessToken() {
  if (process.env.GOOGLE_ACCESS_TOKEN) return process.env.GOOGLE_ACCESS_TOKEN.trim();
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credPath) {
    try {
      const { GoogleAuth } = await import('google-auth-library');
      const auth = new GoogleAuth({
        keyFile: credPath,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
      const client = await auth.getClient();
      const got = await client.getAccessToken();
      const token = typeof got === 'string' ? got : got?.token;
      if (token) return token;
    } catch (err) {
      log(`WARNING: service-account token failed: ${err.message}`);
    }
  }
  for (const cmd of ['gcloud auth print-access-token', 'gcloud auth application-default print-access-token']) {
    try {
      const t = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (t) return t;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function firestoreGet(url, token, { method = 'GET', body = null } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* ignore */
  }
  if (!res.ok) throw new Error(`Firestore ${method} ${res.status}: ${text.slice(0, 240)}`);
  return json;
}

function collectionUrl(collection) {
  return `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT}/databases/(default)/documents/${collection}`;
}

async function listCollection(token, collection, fieldPaths, pageSize = 200) {
  const out = [];
  let page = '';
  const mask = (fieldPaths || []).map((p) => `mask.fieldPaths=${encodeURIComponent(p)}`).join('&');
  for (let i = 0; i < 80; i += 1) {
    const qs = [`pageSize=${pageSize}`, mask, page ? `pageToken=${encodeURIComponent(page)}` : '']
      .filter(Boolean)
      .join('&');
    const j = await firestoreGet(`${collectionUrl(collection)}?${qs}`, token);
    for (const d of j.documents || []) {
      out.push({ id: docId(d.name), ...docFields(d) });
    }
    if (!j.nextPageToken) break;
    page = j.nextPageToken;
  }
  return out;
}

async function batchGetVariants(token, pairs) {
  const root = `projects/${FIRESTORE_PROJECT}/databases/(default)/documents`;
  const found = new Map();
  for (let i = 0; i < pairs.length; i += 40) {
    const chunk = pairs.slice(i, i + 40);
    const documents = chunk.map(
      ({ taskId, variantId }) => `${root}/tasks/${encodeURIComponent(taskId)}/variants/${encodeURIComponent(variantId)}`,
    );
    const j = await firestoreGet(
      `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT}/databases/(default)/documents:batchGet`,
      token,
      { method: 'POST', body: { documents } },
    );
    const rows = Array.isArray(j) ? j : j ? [j] : [];
    for (const row of rows) {
      if (!row?.found) continue;
      const parts = String(row.found.name || '').split('/');
      const variantId = parts[parts.length - 1];
      const taskId = parts[parts.length - 3];
      const f = docFields(row.found);
      found.set(`${taskId}|${variantId}`, {
        id: variantId,
        taskId,
        name: f.name ?? null,
        registered: f.registered === true,
        language: f.params?.language ?? null,
        corpus: f.params?.corpus ?? null,
        skipInstructions: f.params?.skipInstructions ?? null,
        params: f.params && typeof f.params === 'object' ? f.params : {},
      });
    }
  }
  return found;
}

// --- open-assignment rules -------------------------------------------------
export function parseTs(value) {
  if (!value) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  const seconds = value.seconds ?? value._seconds;
  if (typeof seconds === 'number') return seconds * 1000;
  return null;
}

/** Live = already opened and not yet closed. */
export function isAssignmentOpen(admin, now = Date.now()) {
  const opened = parseTs(admin.dateOpened);
  const closed = parseTs(admin.dateClosed);
  if (!opened || opened > now) return false;
  if (closed && closed <= now) return false;
  return true;
}

export function variantIssue(row) {
  if (!row.variantId) return 'no-id';
  if (!row.catalog) return row.variant ? (row.variant.registered ? 'ok' : 'stale') : 'missing';
  if (!row.variant) return 'missing';
  return row.variant.registered ? 'ok' : 'stale';
}

export function needsOracle(row) {
  if (!row.catalog) return false;
  const issue = variantIssue(row);
  return issue === 'stale' || issue === 'missing' || issue === 'no-id';
}

/** Same name filter as levante-support count-runs-by-real-site / firestore audit. */
export function isSandboxSiteName(name) {
  const n = String(name || '').toLowerCase();
  return (
    n.includes('sandbox') ||
    n.includes('test') ||
    n.includes('workshop') ||
    /\bqa\b/.test(n) ||
    n.includes('demo') ||
    n.includes('playwright') ||
    n.includes('cypress')
  );
}

// --- inventory -------------------------------------------------------------
function siteNameOf(admin, districts) {
  const id = admin.siteId || (Array.isArray(admin.districts) ? admin.districts[0] : null);
  if (id && districts.get(id)) return districts.get(id);
  return id || '(no site)';
}

function mapAssessments(admin) {
  const assessments = Array.isArray(admin.assessments) ? admin.assessments : [];
  return assessments
    .map((a) => ({
      taskId: a?.taskId ?? null,
      variantId: a?.variantId ?? null,
      language: a?.params?.language ?? null,
      params: a?.params && typeof a.params === 'object' ? a.params : {},
    }))
    .filter((a) => a.taskId);
}

export function collectUniqueVariants(assignments) {
  const byKey = new Map();
  for (const a of assignments) {
    for (const t of a.tasks) {
      const key = `${t.taskId}|${t.variantId || 'none'}`;
      let row = byKey.get(key);
      if (!row) {
        row = {
          key,
          taskId: t.taskId,
          variantId: t.variantId || null,
          language: t.language || null,
          params: t.params || {},
          assignmentCount: 0,
          siteCount: 0,
          sites: [],
          assignments: [],
        };
        byKey.set(key, row);
      }
      row.assignmentCount += 1;
      if (t.language && !row.language) row.language = t.language;
      if (t.params && Object.keys(t.params).length && !Object.keys(row.params).length) row.params = t.params;
      if (!row.sites.includes(a.siteName)) row.sites.push(a.siteName);
      if (row.assignments.length < 12) {
        row.assignments.push({ id: a.id, name: a.name, siteName: a.siteName });
      }
    }
  }
  for (const row of byKey.values()) row.siteCount = row.sites.length;
  return [...byKey.values()].sort((a, b) => b.assignmentCount - a.assignmentCount || a.key.localeCompare(b.key));
}

async function inventory(token) {
  log(`listing administrations on ${FIRESTORE_PROJECT}…`);
  const [admins, districtDocs] = await Promise.all([
    listCollection(token, 'administrations', [
      'name',
      'publicName',
      'dateOpened',
      'dateClosed',
      'assessments',
      'siteId',
      'districts',
      'testData',
    ]),
    listCollection(token, 'districts', ['name', 'normalizedName']),
  ]);
  const districts = new Map(districtDocs.map((d) => [d.id, d.name || d.normalizedName || d.id]));
  log(`administrations: ${admins.length} · districts: ${districts.size}`);

  const open = [];
  for (const admin of admins) {
    if (!INCLUDE_TEST_DATA && admin.testData === true) continue;
    if (!isAssignmentOpen(admin)) continue;
    const siteName = siteNameOf(admin, districts);
    if (SKIP_SITES.has(String(siteName).trim().toLowerCase())) continue;
    if (!INCLUDE_SANDBOX && isSandboxSiteName(siteName)) continue;
    const tasks = mapAssessments(admin);
    if (!tasks.length) continue;
    open.push({
      id: admin.id,
      name: admin.name || admin.publicName || admin.id,
      siteName,
      dateOpened: admin.dateOpened ?? null,
      dateClosed: admin.dateClosed ?? null,
      tasks,
    });
  }
  log(
    `open assignments (non-test${INCLUDE_SANDBOX ? '' : ', field sites'}): ${open.length}`,
  );

  let rows = collectUniqueVariants(open);
  if (ONLY_TASKS) {
    const want = new Set(ONLY_TASKS);
    rows = rows.filter((r) => want.has(r.taskId) || want.has(findTaskByTaskId(r.taskId)?.id));
  }

  const lookups = rows.filter((r) => r.variantId).map((r) => ({ taskId: r.taskId, variantId: r.variantId }));
  const variants = lookups.length ? await batchGetVariants(token, lookups) : new Map();
  log(`unique packs: ${rows.length} · variant docs found: ${variants.size}`);

  for (const row of rows) {
    row.catalog = findTaskByTaskId(row.taskId) || null;
    row.variant = row.variantId ? variants.get(`${row.taskId}|${row.variantId}`) || null : null;
    if (row.variant) {
      row.language = row.language || row.variant.language;
      if (!Object.keys(row.params || {}).length && row.variant.params) row.params = row.variant.params;
    }
    row.issue = variantIssue(row);
    row.qaLocale = canonicalQaLocale(row.language || row.params?.language || row.variant?.language);
  }
  return { assignments: open, rows };
}

// --- dashboard / oracle ----------------------------------------------------
async function api(method, path, body) {
  const res = await fetch(`${DASHBOARD}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status} ${json?.error || text.slice(0, 200)}`);
  }
  return json;
}

async function dashboardUp() {
  try {
    await api('GET', '/api/tasks');
    return true;
  } catch {
    return false;
  }
}

async function ensureDashboard() {
  if (await dashboardUp()) {
    if (ORACLE_ON_PROD) {
      log('oracle-on-prod: local dashboard is up — using it (must be this checkout’s server.mjs)');
    } else {
      log(`dashboard reachable at ${DASHBOARD}`);
    }
    return;
  }
  if (!AUTOSTART) throw new Error(`dashboard not reachable at ${DASHBOARD} and autostart disabled`);
  log('dashboard down — starting `node dashboard/server.mjs`...');
  const child = spawn('node', ['dashboard/server.mjs'], {
    cwd: REPO_ROOT,
    env: { ...process.env },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  for (let i = 0; i < 30; i++) {
    await sleep(2_000);
    if (await dashboardUp()) {
      log('dashboard is up');
      return;
    }
  }
  throw new Error('dashboard did not become reachable within 60s');
}

const TERMINAL = new Set(['passed', 'failed', 'error', 'cancelled']);

async function runCell(row) {
  const started = Date.now();
  const task = row.catalog;
  let runId = null;
  try {
    const launch = await api('POST', '/api/run', {
      taskId: task.id,
      agent: AGENT,
      language: row.qaLocale || 'en-US',
      ageYears: AGE_YEARS,
      ageMonths: AGE_MONTHS,
      variantId: row.variantId,
      variantName: row.variant?.name || row.variantId,
      variantParams: Object.keys(row.params || {}).length ? row.params : row.variant?.params || null,
      ...(ORACLE_ON_PROD
        ? { firebaseProject: PROD_WRITE_PROJECT, dashboardUrl: PROD_DASHBOARD_URL }
        : {}),
    });
    runId = launch.runId;
  } catch (err) {
    return {
      ...row,
      runId: null,
      status: 'error',
      pass: false,
      errors: [`launch failed: ${err.message}`],
      failureSummary: `launch failed: ${err.message}`,
      accuracy: null,
      nTrials: 0,
      durationMs: Date.now() - started,
    };
  }

  const deadline = started + RUN_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    try {
      last = await api('GET', `/api/status?runId=${runId}`);
    } catch {
      continue;
    }
    if (TERMINAL.has(last.status)) break;
  }

  if (!last || !TERMINAL.has(last.status)) {
    try {
      await api('DELETE', `/api/run/${runId}`);
    } catch {
      /* best effort */
    }
    return {
      ...row,
      runId,
      status: 'timeout',
      pass: false,
      errors: [`run exceeded ${Math.round(RUN_TIMEOUT_MS / 60000)}min timeout`],
      failureSummary: `timeout after ${Math.round(RUN_TIMEOUT_MS / 60000)}min`,
      accuracy: last?.accuracy ?? null,
      nTrials: last?.nTrials ?? 0,
      durationMs: Date.now() - started,
    };
  }

  const errors = Array.isArray(last.errors) ? last.errors : [];
  return {
    ...row,
    runId,
    status: last.status,
    pass: last.status === 'passed',
    errors,
    failureSummary: last.status === 'passed' ? null : errors[0] || last.failureDetail?.split('\n')[0] || `status=${last.status}`,
    accuracy: last.accuracy ?? null,
    nTrials: last.nTrials ?? 0,
    durationMs: Date.now() - started,
  };
}

async function runPool(cells, concurrency) {
  const results = new Array(cells.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= cells.length) return;
      const cell = cells[i];
      log(`▶ ${cell.taskId} / ${cell.variantId || 'no-id'} (${done}/${cells.length} done)`);
      results[i] = await runCell(cell);
      done++;
      const r = results[i];
      log(
        `${r.pass ? '✓' : '✗'} ${cell.taskId} / ${cell.variantId || 'no-id'} → ${r.status}` +
          `${r.failureSummary ? ` — ${r.failureSummary}` : ''} (${Math.round(r.durationMs / 1000)}s)`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, cells.length) }, worker));
  return results;
}

export function classify(current, previous) {
  const prevMap = new Map((previous?.cells || []).map((c) => [c.key, c]));
  return current.map((c) => {
    const prev = prevMap.get(c.key);
    const prevPass = prev && 'pass' in prev ? prev.pass : null;
    let state = 'INVENTORY';
    if (c.pass === true) state = prevPass === false ? 'NEW_PASS' : 'STILL_PASS';
    else if (c.pass === false) state = prevPass === false ? 'STILL_FAIL' : 'NEW_FAIL';
    return { ...c, state, prevPass };
  });
}

// --- reporting -------------------------------------------------------------
function packLabel(row) {
  const name = row.variant?.name || row.variantId || '(no variant id)';
  const lang = row.language || row.variant?.language || '?';
  const id = row.variantId ? ` \`${row.variantId}\`` : '';
  const sites = row.sites.slice(0, SITE_SAMPLE).join(', ') + (row.siteCount > SITE_SAMPLE ? ` +${row.siteCount - SITE_SAMPLE}` : '');
  return `${row.taskId} · ${name} (${lang})${id} · ${row.assignmentCount} assignment${row.assignmentCount === 1 ? '' : 's'} @ ${sites}`;
}

function oracleDetail(row) {
  const dur = formatDuration(row.durationMs);
  const time = dur ? ` (${dur})` : '';
  const extra = row.failureSummary ? `: ${row.failureSummary}` : '';
  return `${packLabel(row)}${time}${extra}`;
}

export function buildReport(classified, previous, timing = {}, meta = {}) {
  const date = todayStr();
  const stale = classified.filter((c) => c.issue === 'stale');
  const missing = classified.filter((c) => c.issue === 'missing');
  const noId = classified.filter((c) => c.issue === 'no-id');
  const ok = classified.filter((c) => c.issue === 'ok');
  const oracleRan = classified.filter((c) => c.status);
  const newFails = oracleRan.filter((c) => c.state === 'NEW_FAIL');
  const stillFail = oracleRan.filter((c) => c.state === 'STILL_FAIL');
  const passed = oracleRan.filter((c) => c.pass);
  const startedPt = timing.startedAt ? formatPtStamp(timing.startedAt) : '';
  const finishedPt = timing.finishedAt ? formatPtStamp(timing.finishedAt) : '';
  const elapsedMs =
    timing.startedAt && timing.finishedAt ? new Date(timing.finishedAt) - new Date(timing.startedAt) : null;

  const lines = [];
  lines.push(`# Prod open-assignment variant sweep — ${date} PT`);
  lines.push('');
  lines.push(
    `${meta.assignmentCount ?? '?'} open assignments · ${classified.length} unique packs` +
      ` · ${stale.length} stale · ${missing.length} missing · ${ok.length} registered` +
      (previous ? ` · baseline ${previous.date}` : ' · no baseline'),
  );
  if (startedPt) lines.push(`Started: ${startedPt}`);
  if (finishedPt) lines.push(`Finished: ${finishedPt}${elapsedMs != null ? ` · ${formatDuration(elapsedMs)}` : ''}`);
  if (oracleRan.length) {
    lines.push(
      `Oracle: ${passed.length}/${oracleRan.length} passing (${AGENT}${ORACLE_ALL ? ', all packs' : ', stale/missing only'}` +
        `${ORACLE_ON_PROD ? `, ${PROD_WRITE_PROJECT} qa-tests` : ', -dev qa-tests'})`,
    );
  } else {
    lines.push('Oracle: not run (inventory only).');
  }
  lines.push('');

  const section = (title, cells, formatter) => {
    if (!cells.length) return;
    lines.push(`## ${title} (${cells.length})`);
    for (const c of cells) lines.push(`- ${formatter(c)}`);
    lines.push('');
  };
  section('Unregistered packs in open assignments (stale)', stale, packLabel);
  section('Variant doc missing on prod', missing, packLabel);
  section('Assessments with no variant id', noId, packLabel);
  if (oracleRan.length) {
    section('Oracle — new failures', newFails, oracleDetail);
    section('Oracle — still failing', stillFail, oracleDetail);
    section('Oracle — passed', passed, (c) => packLabel(c) + (formatDuration(c.durationMs) ? ` (${formatDuration(c.durationMs)})` : ''));
  }
  section('Registered packs in use', ok, packLabel);
  return {
    text: lines.join('\n'),
    stale,
    missing,
    noId,
    ok,
    newFails,
    stillFail,
    passed,
    oracleRan,
    assignmentCount: meta.assignmentCount ?? 0,
    startedPt,
    finishedPt,
    durationStr: elapsedMs != null ? formatDuration(elapsedMs) : '',
  };
}

export function slackMessage(report, previous) {
  const date = todayStr();
  const issueN = report.stale.length + report.missing.length + report.noId.length;
  const oracleFail = (report.oracleRan || []).filter((c) => !c.pass).length;
  let emoji = ':large_green_circle:';
  let headline = `${report.ok.length} registered packs in open assignments`;
  if (report.newFails.length) {
    emoji = ':rotating_light:';
    headline = `${report.newFails.length} new oracle failure${report.newFails.length === 1 ? '' : 's'} on stale packs`;
  } else if (issueN) {
    emoji = ':warning:';
    headline = `${issueN} stale/missing pack${issueN === 1 ? '' : 's'} in open assignments`;
  } else if (oracleFail) {
    emoji = ':warning:';
    headline = `${oracleFail} oracle failure${oracleFail === 1 ? '' : 's'} (no new)`;
  }
  const parts = [];
  parts.push(`${emoji} *Prod open-assignment variant sweep — ${date} PT*: ${headline}`);
  parts.push(
    `${report.assignmentCount} open assignments · ${report.stale.length} stale · ${report.missing.length} missing · ${report.ok.length} registered` +
      (previous ? ` · baseline ${previous.date}` : ''),
  );
  if (report.startedPt) parts.push(`Started: ${report.startedPt}`);
  if (report.finishedPt) parts.push(`Finished: ${report.finishedPt}${report.durationStr ? ` · ${report.durationStr}` : ''}`);
  if (report.oracleRan?.length) {
    parts.push(`Oracle: ${report.passed.length}/${report.oracleRan.length} passing`);
  } else {
    parts.push('Oracle: inventory only (no -dev writes).');
  }
  const slackSection = (title, cells, formatter) => {
    if (!cells.length) return;
    parts.push('');
    parts.push(`*${title} (${cells.length}):*`);
    const shown = cells.slice(0, 20);
    for (const c of shown) parts.push(`• ${formatter(c)}`);
    if (cells.length > shown.length) parts.push(`• +${cells.length - shown.length} more`);
  };
  slackSection('Stale (unregistered)', report.stale, packLabel);
  slackSection('Missing variant doc', report.missing, packLabel);
  slackSection('New oracle failures', report.newFails, oracleDetail);
  slackSection('Still failing', report.stillFail, oracleDetail);
  if (process.env.GITHUB_RUN_URL) parts.push(`\n${process.env.GITHUB_RUN_URL}`);
  return parts.join('\n');
}

async function postSlack(text) {
  if (NO_SLACK) {
    log('Slack disabled (--no-slack)');
    return;
  }
  const webhook = process.env.SLACK_WEBHOOK_URL;
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_ALERT_CHANNEL || 'W018924DJJV';
  try {
    if (token) {
      const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ channel, text, unfurl_links: false }),
      });
      const j = await res.json();
      if (!j.ok) throw new Error(`Slack API: ${j.error}`);
      log(`posted Slack DM/alert to ${channel}`);
    } else if (webhook) {
      const res = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
      log('posted Slack alert via webhook');
    } else {
      log('NOTE: no SLACK_BOT_TOKEN / SLACK_WEBHOOK_URL — skipping Slack.');
    }
  } catch (err) {
    log(`WARNING: Slack post failed: ${err.message}`);
  }
}

async function loadPreviousSnapshot(todayFile) {
  let files = [];
  try {
    files = (await readdir(SNAPSHOT_DIR)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  } catch {
    return null;
  }
  const prior = files.filter((f) => f < todayFile);
  if (!prior.length) return null;
  try {
    return JSON.parse(await readFile(join(SNAPSHOT_DIR, prior[prior.length - 1]), 'utf-8'));
  } catch {
    return null;
  }
}

// --- main ------------------------------------------------------------------
async function main() {
  await mkdir(SNAPSHOT_DIR, { recursive: true });
  const token = await getAccessToken();
  if (!token) throw new Error('No GCP access token (set GOOGLE_APPLICATION_CREDENTIALS or gcloud auth).');

  const startedAt = new Date().toISOString();
  const { assignments, rows } = await inventory(token);

  let oracleCells = rows.filter((r) => (ORACLE_ALL ? r.catalog : needsOracle(r)));
  if (MAX_VARIANTS) oracleCells = oracleCells.slice(0, MAX_VARIANTS);

  if (DRY_RUN) {
    for (const r of rows) {
      log(`  · ${r.issue.padEnd(8)} ${r.taskId} / ${r.variant?.name || 'unnamed'} / ${r.variantId || 'no-id'} (${r.assignmentCount} assignments)`);
    }
    log(
      `dry run — ${rows.length} packs, ${oracleCells.length} would be oracled` +
        `${ORACLE_ON_PROD ? ` on ${PROD_WRITE_PROJECT} qa-tests` : ' on -dev'}. No Slack, no writes.`,
    );
    return;
  }

  let oracleResults = [];
  if (RUN_ORACLE && oracleCells.length) {
    await ensureDashboard();
    log(
      `oracle: ${oracleCells.length} pack(s), agent=${AGENT}, concurrency=${CONCURRENCY}` +
        (ORACLE_ON_PROD
          ? ` · write ${PROD_WRITE_PROJECT} site=qa-tests · play ${PROD_DASHBOARD_URL}`
          : ' · write -dev qa-tests'),
    );
    oracleResults = await runPool(oracleCells, CONCURRENCY);
  } else if (RUN_ORACLE) {
    log('oracle: nothing to run (no stale/missing catalog packs).');
  }

  const byKey = new Map(oracleResults.map((r) => [r.key, r]));
  const merged = rows.map((r) => byKey.get(r.key) || r);

  const date = todayStr();
  const todayFile = `${date}.json`;
  const previous = await loadPreviousSnapshot(todayFile);
  const classified = classify(merged, previous);
  const finishedAt = new Date().toISOString();

  const snapshot = {
    date,
    startedAt,
    finishedAt,
    project: FIRESTORE_PROJECT,
    agent: AGENT,
    mode: RUN_ORACLE
      ? `${ORACLE_ALL ? 'oracle-all' : 'oracle-stale'}${ORACLE_ON_PROD ? '-prod' : ''}`
      : 'inventory',
    siteFilter: INCLUDE_SANDBOX ? 'all' : 'field',
    oracleTarget: ORACLE_ON_PROD ? PROD_WRITE_PROJECT : 'hs-levante-admin-dev',
    assignmentCount: assignments.length,
    cells: classified,
  };
  await writeFile(join(SNAPSHOT_DIR, todayFile), JSON.stringify(snapshot, null, 2) + '\n', 'utf-8');

  const report = buildReport(classified, previous, { startedAt, finishedAt }, { assignmentCount: assignments.length });
  await writeFile(join(SNAPSHOT_DIR, `${date}.md`), report.text + '\n', 'utf-8');
  console.log('\n' + report.text + '\n');
  log(`snapshot → results/prod-assignment-variants/${todayFile}`);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    await writeFile(summaryPath, report.text + '\n', { flag: 'a' });
    log('wrote GitHub Actions job summary');
  }
  await postSlack(slackMessage(report, previous));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(`[prod-variants] FATAL: ${err.stack || err.message}`);
    process.exit(1);
  });
}
