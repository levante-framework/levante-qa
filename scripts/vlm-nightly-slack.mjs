#!/usr/bin/env node
/**
 * Post a VLM nightly summary to Slack (DM via bot token + user id).
 * Reads downloaded `vlm-results-*` artifacts and optional status JSON.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const CHANNEL = process.env.SLACK_ALERT_CHANNEL || 'W018924DJJV';
const TOKEN = process.env.SLACK_BOT_TOKEN || '';
const WEBHOOK = process.env.SLACK_WEBHOOK_URL || '';
const RUN_URL = process.env.GITHUB_RUN_URL || '';
const MATRIX = process.env.VLM_MATRIX_RESULT || 'unknown';
const ARTIFACTS = process.env.VLM_ARTIFACTS_DIR || 'artifacts';

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cols = line.split(',');
    const row = {};
    header.forEach((h, i) => {
      row[h] = cols[i] ?? '';
    });
    return row;
  });
}

function accOf(row) {
  const keys = ['acc_mixed', 'acc_hearts', 'accuracy', 'acc'];
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== '') return row[k];
  }
  return '';
}

const files = walk(ARTIFACTS);
const statuses = files
  .filter((f) => f.endsWith('vlm-nightly-status.json'))
  .map((f) => {
    try {
      return JSON.parse(readFileSync(f, 'utf8'));
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const csvRows = files
  .filter((f) => f.endsWith('.csv') && /summary\.csv$|_summary\.csv$/.test(f))
  .flatMap((f) => {
    try {
      return parseCsv(readFileSync(f, 'utf8'));
    } catch {
      return [];
    }
  })
  .filter((r) => String(r.agent || '').toLowerCase() === 'vlm' || r.provider);

const latestByKey = new Map();
for (const row of csvRows) {
  const key = `${row.provider || '?'}|${row.task || row.run_id || '?'}`;
  latestByKey.set(key, row);
}

const ran = statuses.filter((s) => s.ran);
const skipped = statuses.filter((s) => !s.ran);
const failed = ran.filter((s) => s.outcome !== 'success');
const emoji = MATRIX === 'success' && failed.length === 0 ? ':large_green_circle:' : ':warning:';

const parts = [];
parts.push(`${emoji} *VLM nightly* — matrix \`${MATRIX}\``);
if (ran.length) {
  parts.push(
    `Ran: ${ran.map((s) => `${s.provider} (${s.outcome})`).join(', ')}`,
  );
}
if (skipped.length) {
  parts.push(`Skipped: ${skipped.map((s) => s.provider).join(', ')}`);
}
if (latestByKey.size) {
  parts.push('');
  parts.push('*Scores (latest VLM row per task):*');
  for (const row of latestByKey.values()) {
    const acc = accOf(row);
    const n = row.n_trials || '?';
    const to = row.timeout_rate !== undefined && row.timeout_rate !== '' ? ` · timeout ${row.timeout_rate}` : '';
    parts.push(`• ${row.provider || '?'} / ${row.task || '?'} — ${n} trials${acc !== '' ? `, acc ${acc}` : ''}${to}`);
  }
} else {
  parts.push('_No scored VLM rows in uploaded results._');
}
if (RUN_URL) parts.push(`\n${RUN_URL}`);

const text = parts.join('\n');

async function post() {
  if (TOKEN) {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ channel: CHANNEL, text, unfurl_links: false }),
    });
    const j = await res.json();
    if (!j.ok) throw new Error(`Slack API: ${j.error}`);
    console.log(`posted Slack DM to ${CHANNEL}`);
    return;
  }
  if (WEBHOOK) {
    const res = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
    console.log('posted Slack via webhook');
    return;
  }
  console.log('NOTE: no SLACK_BOT_TOKEN / SLACK_WEBHOOK_URL — skipping Slack');
  console.log(text);
}

try {
  await post();
} catch (err) {
  console.error(`WARNING: Slack post failed: ${err.message}`);
  console.log(text);
  process.exitCode = 0;
}
