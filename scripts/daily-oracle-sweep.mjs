#!/usr/bin/env node
/**
 * Daily -dev oracle sweep.
 *
 * Runs every task in every language it supports against the dashboard
 * (hs-levante-admin-dev), snapshots the pass/fail matrix, diffs it against the
 * previous snapshot, and DMs the current results to Slack (default: david_cardinal)
 * every day — the header flags new regressions (🚨), pre-existing failures (⚠️),
 * or all-green (🟢). Scheduled on GitHub at 04:00 PT (`oracle-sweep.yml`);
 * also fine from a local cron.
 *
 * It reuses the running dashboard end-to-end:
 *   - GET  /api/tasks          → the task × language support matrix
 *                                 (Levante tasks from languageoptions.json +
 *                                  ROAR en/de/es mapping — already computed there)
 *   - POST /api/run            → launch one (task, language) oracle run
 *   - GET  /api/status?runId   → poll until passed | failed | error | cancelled
 *   - DELETE /api/run/:id       → cancel a run that exceeds the per-run timeout
 *
 * Snapshots live in results/daily/<YYYY-MM-DD>.json (+ a human report .md).
 *
 * Config (env / flags):
 *   QA_DASHBOARD_URL          dashboard base URL (default http://localhost:4180)
 *   SWEEP_CONCURRENCY         max parallel runs (default 6)
 *   SWEEP_AGENT               agent to run (default oracle)
 *   SWEEP_RUN_TIMEOUT_MS      per-run timeout (default 1800000 = 30 min)
 *   SWEEP_INCLUDE_TESTING     include ar-IL/he-IL (default off; never alarms)
 *   SWEEP_AGE_YEARS / _MONTHS participant age (default 8 / 0)
 *   SWEEP_AUTOSTART           start the dashboard if it's down (default on)
 *   SLACK_BOT_TOKEN           preferred (DM via chat.postMessage)
 *   SLACK_ALERT_CHANNEL       Slack user id for DM (default W018924DJJV)
 *   SLACK_WEBHOOK_URL         optional fallback (channel fixed by webhook)
 *
 * Flags: --dry-run  --include-testing  --no-slack
 *        --languages=de-DE,en-US  --tasks=pa,sre  --concurrency=N
 */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SNAPSHOT_DIR = join(REPO_ROOT, 'results', 'daily');

// --- flags / config --------------------------------------------------------
const ARGV = process.argv.slice(2);
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

const DASHBOARD = (process.env.QA_DASHBOARD_URL || `http://localhost:${process.env.QA_DASHBOARD_PORT || 4180}`).replace(/\/$/, '');
const AGENT = process.env.SWEEP_AGENT || 'oracle';
const CONCURRENCY = Math.max(1, Number(flagVal('concurrency') || process.env.SWEEP_CONCURRENCY || 6));
const RUN_TIMEOUT_MS = Math.max(60_000, Number(process.env.SWEEP_RUN_TIMEOUT_MS || 30 * 60_000));
const POLL_MS = Math.max(2_000, Number(process.env.SWEEP_POLL_MS || 5_000));
const INCLUDE_TESTING = hasFlag('include-testing') || /^(1|true|yes)$/i.test(process.env.SWEEP_INCLUDE_TESTING || '');
const AGE_YEARS = Number(process.env.SWEEP_AGE_YEARS || 8);
const AGE_MONTHS = Number(process.env.SWEEP_AGE_MONTHS || 0);
const AUTOSTART = !/^(0|false|no)$/i.test(process.env.SWEEP_AUTOSTART || '');
const DRY_RUN = hasFlag('dry-run');
const NO_SLACK = hasFlag('no-slack');
const ONLY_LANGS = csv(flagVal('languages'));
const ONLY_TASKS = csv(flagVal('tasks'));

const log = (...a) => console.log(`[sweep ${new Date().toISOString()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- dashboard HTTP --------------------------------------------------------
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
    log(`dashboard reachable at ${DASHBOARD}`);
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

// --- matrix ----------------------------------------------------------------
async function buildMatrix() {
  const { tasks, languages, taskSupport } = await api('GET', '/api/tasks');
  // Fail loudly on unknown/legacy --languages values (e.g. legacy `nl`, now
  // `nl-NL`) rather than silently matching no cells.
  if (ONLY_LANGS) {
    const known = new Set(languages.map((l) => l.code));
    const unknown = ONLY_LANGS.filter((c) => !known.has(c));
    if (unknown.length) {
      throw new Error(
        `Unknown --languages value(s): ${unknown.join(', ')}. Supported: ${[...known].join(', ')}.`,
      );
    }
  }
  const labelById = new Map(tasks.map((t) => [t.id, t.label]));
  const cells = [];
  for (const lang of languages) {
    if (lang.testing && !INCLUDE_TESTING) continue;
    if (ONLY_LANGS && !ONLY_LANGS.includes(lang.code)) continue;
    for (const taskId of taskSupport[lang.code] || []) {
      if (ONLY_TASKS && !ONLY_TASKS.includes(taskId)) continue;
      cells.push({
        key: `${taskId}|${lang.code}`,
        taskId,
        label: labelById.get(taskId) || taskId,
        language: lang.code,
        testing: !!lang.testing,
      });
    }
  }
  return cells;
}

// --- one run ---------------------------------------------------------------
const TERMINAL = new Set(['passed', 'failed', 'error', 'cancelled']);

async function runCell(cell) {
  const started = Date.now();
  let runId = null;
  try {
    const launch = await api('POST', '/api/run', {
      taskId: cell.taskId,
      agent: AGENT,
      language: cell.language,
      ageYears: AGE_YEARS,
      ageMonths: AGE_MONTHS,
    });
    runId = launch.runId;
  } catch (err) {
    return { ...cell, runId: null, status: 'error', pass: false, errors: [`launch failed: ${err.message}`], failureSummary: `launch failed: ${err.message}`, accuracy: null, nTrials: 0, durationMs: Date.now() - started };
  }

  const deadline = started + RUN_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    try {
      last = await api('GET', `/api/status?runId=${runId}`);
    } catch {
      continue; // transient; keep polling
    }
    if (TERMINAL.has(last.status)) break;
  }

  if (!last || !TERMINAL.has(last.status)) {
    // Timed out — cancel so it stops consuming a slot on the box.
    try {
      await api('DELETE', `/api/run/${runId}`);
    } catch {
      /* best effort */
    }
    return { ...cell, runId, status: 'timeout', pass: false, errors: [`run exceeded ${Math.round(RUN_TIMEOUT_MS / 60000)}min timeout`], failureSummary: `timeout after ${Math.round(RUN_TIMEOUT_MS / 60000)}min`, accuracy: last?.accuracy ?? null, nTrials: last?.nTrials ?? 0, durationMs: Date.now() - started };
  }

  const errors = Array.isArray(last.errors) ? last.errors : [];
  return {
    ...cell,
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

// --- concurrency pool ------------------------------------------------------
async function runPool(cells, concurrency) {
  const results = new Array(cells.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= cells.length) return;
      const cell = cells[i];
      log(`▶ ${cell.taskId} / ${cell.language} (${done}/${cells.length} done, ${i + 1} dispatched)`);
      results[i] = await runCell(cell);
      done++;
      const r = results[i];
      log(`${r.pass ? '✓' : '✗'} ${cell.taskId} / ${cell.language} → ${r.status}${r.failureSummary ? ` — ${r.failureSummary}` : ''} (${Math.round(r.durationMs / 1000)}s)`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, cells.length) }, worker));
  return results;
}

// --- snapshots + diff ------------------------------------------------------
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

async function loadPreviousSnapshot(todayFile) {
  let files = [];
  try {
    files = (await readdir(SNAPSHOT_DIR)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  } catch {
    return null;
  }
  const prior = files.filter((f) => f !== todayFile);
  if (!prior.length) return null;
  try {
    return JSON.parse(await readFile(join(SNAPSHOT_DIR, prior[prior.length - 1]), 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Classify each current cell vs the previous snapshot.
 *  NEW_FAIL   = failing now, was passing (or newly added / no baseline) → alarm
 *  NEW_PASS   = passing now, was failing                                → recovered
 *  STILL_FAIL = failing now and before
 *  STILL_PASS = passing now and before
 */
export function classify(current, previous) {
  const prevMap = new Map((previous?.cells || []).map((c) => [c.key, c]));
  const hasBaseline = !!previous;
  return current.map((c) => {
    const prev = prevMap.get(c.key);
    const prevPass = prev ? prev.pass : null;
    let state;
    if (c.pass) state = prevPass === false ? 'NEW_PASS' : 'STILL_PASS';
    else state = prevPass === false ? 'STILL_FAIL' : 'NEW_FAIL';
    return { ...c, state, prevPass, hadBaseline: hasBaseline && prev !== undefined };
  });
}

// --- Slack -----------------------------------------------------------------
async function postSlack(text) {
  if (NO_SLACK) {
    log('Slack disabled (--no-slack)');
    return;
  }
  const webhook = process.env.SLACK_WEBHOOK_URL;
  const token = process.env.SLACK_BOT_TOKEN;
  // Default: DM david_cardinal (W018924DJJV). Override with SLACK_ALERT_CHANNEL.
  const channel = process.env.SLACK_ALERT_CHANNEL || 'W018924DJJV';
  try {
    // Prefer bot token so we can DM a user id (webhooks are channel-bound).
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
      log('NOTE: no SLACK_BOT_TOKEN / SLACK_WEBHOOK_URL — skipping Slack (report written to disk).');
    }
  } catch (err) {
    log(`WARNING: Slack post failed: ${err.message}`);
  }
}

// --- reporting -------------------------------------------------------------
export function buildReport(classified, previous) {
  const date = todayStr();
  const prod = classified.filter((c) => !c.testing);
  const testing = classified.filter((c) => c.testing);
  const newFails = prod.filter((c) => c.state === 'NEW_FAIL');
  const recovered = prod.filter((c) => c.state === 'NEW_PASS');
  const stillFail = prod.filter((c) => c.state === 'STILL_FAIL');
  const passing = prod.filter((c) => c.pass).length;

  // Per-language tally for the daily "current results" line.
  const byLang = [];
  for (const c of prod) {
    let row = byLang.find((r) => r.language === c.language);
    if (!row) {
      row = { language: c.language, pass: 0, total: 0 };
      byLang.push(row);
    }
    row.total += 1;
    if (c.pass) row.pass += 1;
  }
  const byLangStr = byLang.map((r) => `${r.language} ${r.pass}/${r.total}`).join(' · ');

  const lines = [];
  lines.push(`# Daily -dev oracle sweep — ${date}`);
  lines.push('');
  lines.push(`Agent: ${AGENT} · ${prod.length} runs · ${passing} passing · ${prod.length - passing} failing` + (previous ? ` · baseline ${previous.date}` : ' · no baseline (first run)'));
  lines.push(`By language: ${byLangStr}`);
  lines.push('');
  const section = (title, cells, withSummary) => {
    if (!cells.length) return;
    lines.push(`## ${title} (${cells.length})`);
    for (const c of cells) {
      lines.push(`- ${c.label} — ${c.language}` + (withSummary && c.failureSummary ? `: ${c.failureSummary}` : ''));
    }
    lines.push('');
  };
  section('🔴 NEW failures (regressions)', newFails, true);
  section('🟢 Recovered', recovered, false);
  section('⚪ Still failing', stillFail, true);
  if (testing.length) section('🧪 Testing locales (not alarmed)', testing.filter((c) => !c.pass), true);
  return { text: lines.join('\n'), newFails, recovered, stillFail, passing, prodCount: prod.length, byLangStr };
}

export function slackMessage(report, previous) {
  const date = todayStr();
  const failing = report.prodCount - report.passing;
  // Header reflects the current state: all-green, new regressions, or
  // pre-existing failures only.
  let emoji;
  let headline;
  if (failing === 0) {
    emoji = ':large_green_circle:';
    headline = `all ${report.prodCount} passing`;
  } else if (report.newFails.length > 0) {
    emoji = ':rotating_light:';
    headline = `${report.passing}/${report.prodCount} passing · ${report.newFails.length} new failure${report.newFails.length === 1 ? '' : 's'}`;
  } else {
    emoji = ':warning:';
    headline = `${report.passing}/${report.prodCount} passing · ${failing} failing (no new)`;
  }

  const parts = [];
  parts.push(`${emoji} *Daily -dev oracle sweep — ${date}*: ${headline}`);
  parts.push(`By language: ${report.byLangStr}` + (previous ? ` · baseline ${previous.date}` : ' · no baseline'));
  if (report.newFails.length) {
    parts.push('');
    parts.push('*:red_circle: New failures (regressions):*');
    for (const c of report.newFails) parts.push(`• *${c.label}* — \`${c.language}\`${c.failureSummary ? `: ${c.failureSummary}` : ''}`);
  }
  if (report.recovered.length) {
    parts.push('');
    parts.push(`:white_check_mark: *Recovered:* ${report.recovered.map((c) => `${c.label} (${c.language})`).join(', ')}`);
  }
  if (report.stillFail.length) {
    parts.push('');
    parts.push(`:large_white_circle: *Still failing:*`);
    for (const c of report.stillFail) parts.push(`• ${c.label} — \`${c.language}\`${c.failureSummary ? `: ${c.failureSummary}` : ''}`);
  }
  if (process.env.GITHUB_RUN_URL) parts.push(`\n${process.env.GITHUB_RUN_URL}`);
  return parts.join('\n');
}

// --- main ------------------------------------------------------------------
async function main() {
  await mkdir(SNAPSHOT_DIR, { recursive: true });
  await ensureDashboard();

  const cells = await buildMatrix();
  log(`matrix: ${cells.length} (task × language) cells, agent=${AGENT}, concurrency=${CONCURRENCY}`);
  if (DRY_RUN) {
    for (const c of cells) log(`  · ${c.taskId} / ${c.language}${c.testing ? ' [testing]' : ''}`);
    log('dry run — not launching.');
    return;
  }

  const startedAt = new Date().toISOString();
  const results = await runPool(cells, CONCURRENCY);
  const finishedAt = new Date().toISOString();

  const date = todayStr();
  const todayFile = `${date}.json`;
  const previous = await loadPreviousSnapshot(todayFile);
  const classified = classify(results, previous);

  const snapshot = { date, startedAt, finishedAt, dashboard: DASHBOARD, agent: AGENT, cells: classified };
  await writeFile(join(SNAPSHOT_DIR, todayFile), JSON.stringify(snapshot, null, 2) + '\n', 'utf-8');

  const report = buildReport(classified, previous);
  await writeFile(join(SNAPSHOT_DIR, `${date}.md`), report.text + '\n', 'utf-8');
  console.log('\n' + report.text + '\n');
  log(`snapshot → results/daily/${todayFile}`);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    await writeFile(summaryPath, report.text + '\n', { flag: 'a' });
    log('wrote GitHub Actions job summary');
  }

  // Post the current results every day (green or not).
  await postSlack(slackMessage(report, previous));
}

// Only sweep when run directly (`node scripts/daily-oracle-sweep.mjs`); stays a
// pure module when imported (e.g. for testing the diff / report functions).
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(`[sweep] FATAL: ${err.stack || err.message}`);
    process.exit(1);
  });
}
