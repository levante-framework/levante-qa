#!/usr/bin/env node
/**
 * Read-only prod health check (no Auth users, no assignments, no writes).
 *
 *  1. Registered task packs on hs-levante-admin-prod (Firestore list).
 *  2. Narration files on gs://levante-assets-prod vs gs://levante-assets-dev
 *     (public GCS list). A clip that exists on prod but not -dev is how
 *     Stories es-AR sat on the splash waiting for Continue.
 *
 * Usage:
 *   pnpm run prod-check
 *   pnpm run prod-check -- --no-slack --languages=es-AR --tasks=stories
 *
 * Snapshots: results/prod-readonly/<YYYY-MM-DD>.{json,md}  (not the oracle daily file)
 */
import 'dotenv/config';
import { execSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG, FALLBACK_TASK_OPTIONS, LANGUAGES, isTaskSupportedInLanguage } from '../dashboard/catalog.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OUT_DIR = join(REPO_ROOT, 'results', 'prod-readonly');

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

const NO_SLACK = hasFlag('no-slack');
const ONLY_LANGS = csv(flagVal('languages'));
const ONLY_TASKS = csv(flagVal('tasks'));
const FIRESTORE_PROJECT = process.env.PROD_FIRESTORE_PROJECT || 'hs-levante-admin-prod';
const PROD_BUCKET = process.env.PROD_ASSETS_BUCKET || 'levante-assets-prod';
const DEV_BUCKET = process.env.DEV_ASSETS_BUCKET || 'levante-assets-dev';
const LANGUAGEOPTIONS_URL =
  process.env.PROD_LANGUAGEOPTIONS_URL ||
  `https://storage.googleapis.com/${PROD_BUCKET}/translations/dashboard-consolidated-flat/languageoptions.json`;

const PT = 'America/Los_Angeles';
const SAMPLE_CAP = 8;

const AUDIO_GROUPS = [
  { id: 'stories', label: 'Stories (ToM)', re: /^ToM/i },
  { id: 'vocab', label: 'Vocab', re: /^vocab/i },
  { id: 'trog', label: 'TROG', re: /^trog/i },
  { id: 'same_different', label: 'Same-Different', re: /^(same|sds)/i },
  { id: 'egma_math', label: 'EGMA Math', re: /^(number|math|egma)/i },
  { id: 'memory_game', label: 'Memory Game', re: /^memory/i },
  { id: 'matrix_reasoning', label: 'Matrix Reasoning', re: /^matrix/i },
  { id: 'mental_rotation', label: 'Mental Rotation', re: /^mental/i },
  { id: 'hearts_and_flowers', label: 'Hearts & Flowers', re: /^hearts/i },
];

function todayStr(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: PT,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function formatPtStamp(date = new Date()) {
  const clock = new Intl.DateTimeFormat('en-US', {
    timeZone: PT,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).format(date);
  return `${todayStr(date)} ${clock}`;
}

const log = (...a) => console.log(`[prod-check ${formatPtStamp()}]`, ...a);

function languageOnly(code) {
  return String(code || '').toLowerCase().split('-')[0];
}

function nameMatchesWant(name, want, wantBase) {
  const n = String(name || '').toLowerCase();
  if (!n) return false;
  if (n === want || n === wantBase) return true;
  if (n.startsWith(`${want}-`) || n.startsWith(`${want} `)) return true;
  return n.startsWith(`${wantBase} `);
}

/** Same rules as provision-participant pickVariant, on plain objects. */
function pickRegisteredVariant(variants, languageCode) {
  const want = String(languageCode || 'en-US').toLowerCase();
  const wantBase = languageOnly(want);
  const score = (v) => {
    const lang = String(v.language ?? '').toLowerCase();
    const name = String(v.name ?? '').toLowerCase();
    let s = 0;
    if (lang === want) s += 200;
    else if (lang === wantBase) s += 120;
    if (nameMatchesWant(name, want, wantBase)) s += 150;
    if (v.registered === true) s += 10;
    return s;
  };
  const langMatch = variants.filter((v) => score(v) >= 120);
  const registered = langMatch.filter((v) => v.registered === true);
  if (!registered.length) return null;
  const langOf = (v) => String(v.language ?? '').toLowerCase();
  const exact = registered.filter((v) => langOf(v) === want);
  const bare = registered.filter((v) => langOf(v) === wantBase);
  const pool = exact.length ? exact : bare.length ? bare : registered;
  return [...pool].sort((a, b) => score(b) - score(a))[0] ?? null;
}

function groupName(file) {
  const hit = AUDIO_GROUPS.find((g) => g.re.test(file));
  return hit ? hit.label : 'other';
}

async function gcsListFiles(bucket, prefix) {
  const files = [];
  let page = '';
  for (let i = 0; i < 30; i += 1) {
    const url =
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o` +
      `?prefix=${encodeURIComponent(prefix)}&maxResults=1000` +
      (page ? `&pageToken=${encodeURIComponent(page)}` : '');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GCS list gs://${bucket}/${prefix} → HTTP ${res.status}`);
    const j = await res.json();
    for (const it of j.items || []) {
      const name = String(it.name || '').split('/').pop();
      if (name && !name.endsWith('/')) files.push(name);
    }
    if (!j.nextPageToken) break;
    page = j.nextPageToken;
  }
  return files;
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

function unwrap(v) {
  if (v == null) return v;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
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

async function firestoreGet(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* ignore */
  }
  if (!res.ok) throw new Error(`Firestore GET ${res.status}: ${text.slice(0, 240)}`);
  return json;
}

async function listVariants(token, taskId) {
  const out = [];
  let page = '';
  const root = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT}/databases/(default)/documents/tasks/${encodeURIComponent(taskId)}/variants`;
  for (let i = 0; i < 30; i += 1) {
    const url = `${root}?pageSize=100${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`;
    const j = await firestoreGet(url, token);
    for (const d of j.documents || []) {
      const f = docFields(d);
      out.push({
        id: d.name.split('/').pop(),
        name: f.name ?? null,
        registered: f.registered === true,
        language: f.params?.language ?? null,
        corpus: f.params?.corpus ?? null,
        skipInstructions: f.params?.skipInstructions ?? null,
      });
    }
    if (!j.nextPageToken) break;
    page = j.nextPageToken;
  }
  return out;
}

async function loadLanguageOptions() {
  const res = await fetch(LANGUAGEOPTIONS_URL);
  if (!res.ok) throw new Error(`languageoptions.json HTTP ${res.status}`);
  const data = await res.json();
  const byLang = {};
  const entries = Array.isArray(data) ? data : Object.values(data || {});
  for (const entry of entries) {
    const code = entry?.languageCode || entry?.code || entry?.locale;
    if (code && Array.isArray(entry.taskOptions)) byLang[code] = entry.taskOptions;
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const [code, entry] of Object.entries(data)) {
      if (entry && Array.isArray(entry.taskOptions)) byLang[code] = entry.taskOptions;
    }
  }
  return byLang;
}

function missingGrouped(fromSet, toSet) {
  const missing = [...fromSet].filter((f) => !toSet.has(f)).sort();
  const groups = {};
  for (const f of missing) {
    const g = groupName(f);
    if (!groups[g]) groups[g] = [];
    groups[g].push(f);
  }
  return { n: missing.length, groups };
}

function sampleGroups(groups) {
  const out = {};
  for (const [g, files] of Object.entries(groups)) {
    out[g] = { n: files.length, sample: files.slice(0, SAMPLE_CAP) };
  }
  return out;
}

async function postSlack(text) {
  if (NO_SLACK) {
    log('Slack disabled (--no-slack)');
    return;
  }
  const token = process.env.SLACK_BOT_TOKEN;
  const webhook = process.env.SLACK_WEBHOOK_URL;
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
      log(`posted Slack DM to ${channel}`);
    } else if (webhook) {
      const res = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
      log('posted Slack via webhook');
    } else {
      log('NOTE: no Slack token — report on disk only');
    }
  } catch (err) {
    log(`WARNING: Slack post failed: ${err.message}`);
  }
}

function buildMarkdown(report) {
  const lines = [];
  lines.push(`# Prod read-only check — ${report.date} PT`);
  lines.push('');
  lines.push(`Started: ${report.startedPt}`);
  lines.push(`Firestore: ${report.firestore.status} (${FIRESTORE_PROJECT})`);
  lines.push(`Assets: prod \`${PROD_BUCKET}\` · -dev \`${DEV_BUCKET}\``);
  lines.push('');

  lines.push('## Registered packs on prod');
  if (report.firestore.status !== 'ok') {
    lines.push(`Skipped: ${report.firestore.error || report.firestore.status}`);
  } else {
    const missing = report.cells.filter((c) => !c.variant);
    const found = report.cells.filter((c) => c.variant);
    lines.push(`${found.length}/${report.cells.length} sweep cells have a registered pack.`);
    if (missing.length) {
      lines.push('');
      lines.push('No registered pack:');
      for (const c of missing) lines.push(`- ${c.label} — ${c.language}`);
    }
  }
  lines.push('');

  lines.push('## Audio on prod that is missing on -dev');
  const gaps = report.audio.devMissingVsProd.filter((row) => row.n > 0);
  if (!gaps.length) {
    lines.push('None for the sweep locales.');
  } else {
    for (const row of gaps) {
      lines.push(`- **${row.locale}**: ${row.n} file(s)`);
      for (const [g, info] of Object.entries(row.groups)) {
        const extra = info.n > info.sample.length ? ` (+${info.n - info.sample.length} more)` : '';
        lines.push(`  - ${g} (${info.n}): ${info.sample.join(', ')}${extra}`);
      }
    }
  }
  lines.push('');

  lines.push('## Audio folder sizes');
  lines.push('| Locale | prod | -dev |');
  lines.push('| --- | ---: | ---: |');
  for (const row of report.audio.counts) {
    lines.push(`| ${row.locale} | ${row.prod} | ${row.dev} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function slackMessage(report) {
  const gaps = report.audio.devMissingVsProd.filter((row) => row.n > 0);
  const noPack = report.firestore.status === 'ok' ? report.cells.filter((c) => !c.variant) : [];
  const emoji = gaps.length || noPack.length ? ':large_yellow_circle:' : ':large_green_circle:';
  const parts = [];
  parts.push(`${emoji} *Prod read-only check — ${report.date} PT*`);
  parts.push('No logins, no test kids — packs + audio inventory only.');
  if (report.firestore.status === 'ok') {
    const n = report.cells.filter((c) => c.variant).length;
    parts.push(`Registered packs: ${n}/${report.cells.length} sweep cells`);
  } else {
    parts.push(`Registered packs: skipped (${report.firestore.error || report.firestore.status})`);
  }
  if (noPack.length) {
    parts.push('');
    parts.push('*No registered pack on prod:*');
    for (const c of noPack) parts.push(`• ${c.label} — ${c.language}`);
  }
  if (gaps.length) {
    parts.push('');
    parts.push('*-dev audio missing vs prod:*');
    for (const row of gaps) {
      const bits = Object.entries(row.groups).map(([g, info]) => `${g} ${info.n}`);
      parts.push(`• ${row.locale}: ${row.n} (${bits.join(', ')})`);
    }
  } else {
    parts.push('`-dev` has every prod narration file for these locales.');
  }
  if (process.env.GITHUB_RUN_URL) parts.push(`\n${process.env.GITHUB_RUN_URL}`);
  return parts.join('\n');
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const startedAt = new Date();
  const langs = LANGUAGES.filter((l) => !l.testing).filter((l) => !ONLY_LANGS || ONLY_LANGS.includes(l.code));
  const tasks = CATALOG.filter((t) => !ONLY_TASKS || ONLY_TASKS.includes(t.id));

  let languageOptions = {};
  try {
    languageOptions = await loadLanguageOptions();
    log(`languageoptions.json: ${Object.keys(languageOptions).length} locale(s)`);
  } catch (err) {
    log(`WARNING: languageoptions.json: ${err.message}`);
  }
  const taskOptionsByLang = Object.keys(languageOptions).length ? languageOptions : FALLBACK_TASK_OPTIONS;

  const firestore = { status: 'skipped', error: null };
  const variantsByTask = {};
  const token = await getAccessToken();
  if (token) {
    try {
      for (const task of tasks) {
        variantsByTask[task.taskId] = await listVariants(token, task.taskId);
        log(`variants ${task.taskId}: ${variantsByTask[task.taskId].length}`);
      }
      firestore.status = 'ok';
    } catch (err) {
      firestore.status = 'error';
      firestore.error = err.message;
      log(`WARNING: Firestore skipped: ${err.message}`);
    }
  } else {
    firestore.error = 'no GCP access token';
    log('WARNING: no GCP token — skipping registered-pack list');
  }

  const cells = [];
  for (const lang of langs) {
    for (const task of tasks) {
      if (!isTaskSupportedInLanguage(task, lang.code, taskOptionsByLang)) continue;
      const variants = variantsByTask[task.taskId] || [];
      const pick = firestore.status === 'ok' ? pickRegisteredVariant(variants, lang.code) : null;
      cells.push({
        key: `${task.id}|${lang.code}`,
        taskId: task.id,
        coreTaskId: task.taskId,
        label: task.label,
        language: lang.code,
        variant: pick
          ? {
              id: pick.id,
              name: pick.name,
              language: pick.language,
              corpus: pick.corpus,
              skipInstructions: pick.skipInstructions,
            }
          : null,
      });
    }
  }

  const audioCounts = [];
  const devMissingVsProd = [];
  for (const lang of langs) {
    const prefix = `audio/${lang.code}/`;
    log(`listing ${prefix}`);
    const [prodFiles, devFiles] = await Promise.all([
      gcsListFiles(PROD_BUCKET, prefix),
      gcsListFiles(DEV_BUCKET, prefix),
    ]);
    const prodSet = new Set(prodFiles);
    const devSet = new Set(devFiles);
    const miss = missingGrouped(prodSet, devSet);
    const sweepGroups = Object.fromEntries(
      Object.entries(sampleGroups(miss.groups)).filter(([g]) => g !== 'other'),
    );
    const sweepN = Object.values(sweepGroups).reduce((n, g) => n + g.n, 0);
    audioCounts.push({ locale: lang.code, prod: prodFiles.length, dev: devFiles.length });
    devMissingVsProd.push({
      locale: lang.code,
      n: sweepN,
      otherN: miss.groups.other?.length ?? 0,
      groups: sweepGroups,
    });
    log(`${lang.code}: prod ${prodFiles.length} · -dev ${devFiles.length} · missing on -dev ${sweepN} (plus ${miss.groups.other?.length ?? 0} non-sweep)`);
  }

  const report = {
    date: todayStr(startedAt),
    startedPt: formatPtStamp(startedAt),
    firestore,
    languageOptionsLocales: Object.keys(languageOptions).sort(),
    cells,
    audio: { prodBucket: PROD_BUCKET, devBucket: DEV_BUCKET, counts: audioCounts, devMissingVsProd },
  };

  const md = buildMarkdown(report);
  const date = report.date;
  await writeFile(join(OUT_DIR, `${date}.json`), JSON.stringify(report, null, 2) + '\n');
  await writeFile(join(OUT_DIR, `${date}.md`), md + '\n');
  console.log(`\n${md}\n`);
  log(`snapshot → results/prod-readonly/${date}.json`);

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    await writeFile(summaryPath, md + '\n', { flag: 'a' });
  }

  await postSlack(slackMessage(report));
}

main().catch((err) => {
  console.error(`[prod-check] ${err?.stack || err?.message || err}`);
  process.exit(1);
});
