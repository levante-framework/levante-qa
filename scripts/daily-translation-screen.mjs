#!/usr/bin/env node
/**
 * Daily translation screen.
 *
 * Inventories itembank translations (draft bucket by default), skips Esperanto
 * and placeholder-only locales ("NO APPROVED TRANSLATION"), diffs approved keys
 * against the previous snapshot, evaluates only packs with newly appeared
 * strings (edits to existing keys are ignored), and DMs findings via Slack.
 *
 * Vision tasks (vocab / trog / theory-of-mind / same-different-selection) use
 * the English-control vision evals. Everything else uses the Gemini MQM judge
 * scoped to that task path.
 *
 * Snapshots:
 *   results/translation-screen/inventory-baseline.json  — pack hashes + keys
 *   results/translation-screen/latest.json              — last full screen result
 *   results/translation-screen/<YYYY-MM-DD>.{json,md}   — only when new strings
 *
 * Output is delta-only: quiet if no new approved keys since the last run.
 * Slack DMs only when there are findings (not on quiet or clean screens).
 *
 * Config (env / flags):
 *   QA_ITEMBANK_BASE_URL   draft (default) or prod translations root
 *   QA_TRANSLATION_BUCKET  override bucket name (default derived from base)
 *   GEMINI_API_KEY         required when anything needs screening
 *   SLACK_BOT_TOKEN        preferred (DM via chat.postMessage)
 *   SLACK_ALERT_CHANNEL    Slack user id for DM (default W018924DJJV)
 *   SLACK_WEBHOOK_URL      optional fallback (channel fixed by webhook)
 *   TRANSLATION_SCREEN_MQM_MAX  flag MQM scores at or below this (default 90)
 *
 * Flags: --dry-run  --no-slack  --force  --locales=de-DE,en-GB  --tasks=vocab,trog
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const EVAL_DIR = join(REPO_ROOT, 'scripts', 'eval');
const OUT_DIR = join(REPO_ROOT, 'results', 'translation-screen');
const EVAL_OUT = join(EVAL_DIR, 'output');

const PLACEHOLDER = 'NO APPROVED TRANSLATION';
const SOURCE_LOCALE = 'en-US';
const IGNORE_LOCALE_PREFIXES = ['eo']; // Esperanto (eo-UY, …)

const VISION = {
  vocab: { script: 'vocab_vision_eval.py', stem: 'vocab-vision', tag: 'translation_issue' },
  trog: { script: 'trog_vision_eval.py', stem: 'trog-vision', tag: 'translation_issue' },
  'theory-of-mind': { script: 'tom_vision_eval.py', stem: 'tom-vision', tag: 'translation_issue' },
  'same-different-selection': {
    script: 'samediff_vision_eval.py',
    stem: 'samediff-vision',
    tag: 'translation_issue',
  },
};

const DEFAULT_BASE =
  process.env.QA_ITEMBANK_BASE_URL ||
  'https://storage.googleapis.com/levante-assets-draft/translations';

const ARGV = process.argv.slice(2).filter((a) => a !== '--');
const hasFlag = (name) => ARGV.includes(`--${name}`);
const flagVal = (name) => {
  const hit = ARGV.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const csv = (s) =>
  (s || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

const DRY_RUN = hasFlag('dry-run');
const NO_SLACK = hasFlag('no-slack');
const FORCE = hasFlag('force');
const ONLY_LOCALES = new Set(csv(flagVal('locales')));
const ONLY_TASKS = new Set(csv(flagVal('tasks')));
const MQM_MAX = Number(process.env.TRANSLATION_SCREEN_MQM_MAX || 90);
const GCS_BUCKET =
  process.env.QA_TRANSLATION_BUCKET ||
  (DEFAULT_BASE.includes('levante-assets-prod') ? 'levante-assets-prod' : 'levante-assets-draft');
const IMAGE_BUCKET = process.env.QA_VISION_IMAGE_BUCKET || 'levante-assets-prod';

const log = (...a) => console.log(`[translation-screen ${new Date().toISOString()}]`, ...a);

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function sha(obj) {
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

function ignoreLocale(locale) {
  const tok = String(locale || '')
    .split('-')[0]
    .toLowerCase();
  return IGNORE_LOCALE_PREFIXES.includes(tok);
}

function approvedEntries(data) {
  const out = {};
  if (!data || typeof data !== 'object') return out;
  for (const [k, v] of Object.entries(data)) {
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (!t || t === PLACEHOLDER) continue;
    out[k] = t;
  }
  return out;
}

async function gcsList(prefix) {
  const url =
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(GCS_BUCKET)}/o` +
    `?prefix=${encodeURIComponent(prefix)}&maxResults=1000`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GCS list ${prefix} → HTTP ${res.status}`);
  const j = await res.json();
  return (j.items || []).map((it) => it.name);
}

async function gcsJson(objectPath) {
  const url = `https://storage.googleapis.com/${GCS_BUCKET}/${objectPath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GCS get ${objectPath} → HTTP ${res.status}`);
  return res.json();
}

async function inventory() {
  const names = await gcsList('translations/itembank/');
  const packs = [];
  for (const name of names) {
    const m = name.match(
      /^translations\/itembank\/([^/]+)\/([^/]+)\/item-bank-translations\.json$/,
    );
    if (!m) continue;
    const [, task, locale] = m;
    if (locale === SOURCE_LOCALE) continue;
    if (ignoreLocale(locale)) continue;
    if (ONLY_TASKS.size && !ONLY_TASKS.has(task)) continue;
    if (ONLY_LOCALES.size && !ONLY_LOCALES.has(locale)) continue;
    const data = await gcsJson(name);
    const approved = approvedEntries(data);
    const keys = Object.keys(approved).sort();
    const realCount = keys.length;
    packs.push({
      task,
      locale,
      object: name,
      realCount,
      totalKeys: Object.keys(data || {}).length,
      keys,
      hash: realCount ? sha(approved) : null,
      placeholderOnly: realCount === 0,
    });
  }
  packs.sort((a, b) => `${a.task}/${a.locale}`.localeCompare(`${b.task}/${b.locale}`));
  return packs;
}

async function loadBaseline() {
  // Prefer inventory-baseline (updated every run, including dry-run) so repeated
  // manual runs only report packs whose approved strings actually changed.
  for (const name of ['inventory-baseline.json', 'latest.json']) {
    try {
      await access(join(OUT_DIR, name), fsConstants.R_OK);
      return JSON.parse(await readFile(join(OUT_DIR, name), 'utf8'));
    } catch {
      /* try next */
    }
  }
  try {
    const files = (await readdir(OUT_DIR))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort();
    if (!files.length) return null;
    return JSON.parse(await readFile(join(OUT_DIR, files[files.length - 1]), 'utf8'));
  } catch {
    return null;
  }
}

function packsBaselinePayload(packs, date) {
  return {
    date,
    bucket: GCS_BUCKET,
    packs: packs.map(({ task, locale, object, realCount, totalKeys, keys, hash, placeholderOnly }) => ({
      task,
      locale,
      object,
      realCount,
      totalKeys,
      keys: keys || [],
      hash,
      placeholderOnly,
    })),
  };
}

async function saveInventoryBaseline(packs, date) {
  const path = join(OUT_DIR, 'inventory-baseline.json');
  await writeFile(path, JSON.stringify(packsBaselinePayload(packs, date), null, 2));
  return path;
}

/** Keys present in current pack that were not in the previous baseline. */
function newKeysForPack(pack, prev) {
  if (!prev) return pack.keys || [];
  if (!Array.isArray(prev.keys)) {
    // Legacy baseline without keys: treat a hash change as all keys new once.
    if (prev.hash !== pack.hash) return pack.keys || [];
    return [];
  }
  const prevKeys = new Set(prev.keys);
  return (pack.keys || []).filter((k) => !prevKeys.has(k));
}

function diffPacks(current, previous) {
  const prevMap = new Map(
    (previous?.packs || []).map((p) => [`${p.task}|${p.locale}`, p]),
  );
  const changed = [];
  for (const p of current) {
    if (p.placeholderOnly) continue;
    const prev = prevMap.get(`${p.task}|${p.locale}`);
    if (FORCE) {
      changed.push({ ...p, reason: 'force', newKeys: p.keys || [] });
      continue;
    }
    const newKeys = newKeysForPack(p, prev);
    if (!newKeys.length) continue;
    changed.push({
      ...p,
      reason: !prev ? 'new' : 'new-keys',
      newKeys,
    });
  }
  return changed;
}

function findingMatchesNewKeys(finding, newKeys) {
  if (finding.kind === 'error') return true;
  if (!newKeys || !newKeys.length) return true;
  const id = String(finding.itemId || '');
  if (!id) return true;
  return newKeys.some((k) => id === k || id.includes(k));
}

function filterFindingsToNewKeys(findings, changed) {
  const byPack = new Map(
    changed.map((c) => [`${c.task}|${c.locale}`, c.newKeys || c.keys || []]),
  );
  return findings.filter((f) => {
    const keys = byPack.get(`${f.task}|${f.locale}`);
    // Multi-locale vision errors use locale="a,b"; keep those.
    if (keys === undefined) return true;
    return findingMatchesNewKeys(f, keys);
  });
}

function runPython(args, env = {}) {
  log(`$ python ${args.join(' ')}`);
  if (DRY_RUN) return { status: 0, stdout: '', stderr: '' };
  const res = spawnSync('python', args, {
    cwd: EVAL_DIR,
    env: {
      ...process.env,
      QA_ITEMBANK_BASE_URL: DEFAULT_BASE.replace(/\/$/, ''),
      ...env,
    },
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  return res;
}

function parseCsvLoose(text) {
  const rows = [];
  let row = [];
  let val = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        val += '"';
        i++;
      } else if (c === '"') q = false;
      else val += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(val);
      val = '';
    } else if (c === '\n') {
      row.push(val.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      val = '';
    } else val += c;
  }
  if (val || row.length) {
    row.push(val);
    rows.push(row);
  }
  if (!rows.length) return [];
  const header = rows.shift();
  return rows
    .filter((r) => r.some(Boolean))
    .map((r) => Object.fromEntries(header.map((k, i) => [k, r[i] ?? ''])));
}

function parseCsvFileSafe(path) {
  try {
    return parseCsvLoose(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
}

async function screenVision(task, locales) {
  const cfg = VISION[task];
  const findings = [];
  if (!cfg || !locales.length) return findings;
  const res = runPython([
    cfg.script,
    `--locales=${locales.join(',')}`,
    `--gcs-bucket=${IMAGE_BUCKET}`,
    '--no-pdf',
  ]);
  if (res.status !== 0) {
    findings.push({
      kind: 'error',
      task,
      locale: locales.join(','),
      itemId: '',
      detail: `${cfg.script} exited ${res.status}`,
    });
    return findings;
  }
  for (const locale of locales) {
    const rows = parseCsvFileSafe(join(EVAL_OUT, `${cfg.stem}-${locale}.csv`));
    for (const r of rows) {
      if ((r.tag || '') !== cfg.tag) continue;
      findings.push({
        kind: 'vision',
        task,
        locale,
        itemId: r.item_id || r.vid || '',
        detail: (r.reason || '').slice(0, 280),
        en: r.en_word || r.en_sentence || r.en_question || '',
        translation: r.translation || r.translation_question || '',
      });
    }
  }
  return findings;
}

async function screenMqm(task, locale) {
  const findings = [];
  const outCsv = join(EVAL_OUT, `screen-mqm-${task}-${locale}.csv`);
  const res = runPython([
    'evaluate_translations.py',
    `--target-col=${locale}`,
    `--path-contains=itembank/${task}`,
    '--run-llm',
    `--output-csv=${outCsv}`,
  ]);
  if (res.status !== 0) {
    findings.push({
      kind: 'error',
      task,
      locale,
      itemId: '',
      detail: `evaluate_translations.py exited ${res.status}`,
    });
    return findings;
  }
  const rows = parseCsvFileSafe(outCsv);
  let skippedNoScore = 0;
  for (const r of rows) {
    // evaluate_translations leaves mqm_score blank on judge failure (not 0).
    // Number("") === 0 in JS, so require a non-empty numeric score + ok status.
    const raw = String(r.mqm_score ?? '').trim();
    const status = String(r.mqm_status || '');
    if (!raw || (status && status !== 'ok')) {
      skippedNoScore += 1;
      continue;
    }
    const score = Number(raw);
    if (!Number.isFinite(score) || score > MQM_MAX) continue;
    findings.push({
      kind: 'mqm',
      task,
      locale,
      itemId: r.item_id || r.identifier || '',
      detail: `mqm=${score} ${(r.mqm_assessment || '').slice(0, 220)}`,
      en: r.en || '',
      translation: r[locale] || '',
      score,
    });
  }
  if (skippedNoScore) {
    log(`mqm ${task}/${locale}: skipped ${skippedNoScore} row(s) with no score (judge failure)`);
  }
  return findings;
}

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
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${token}`,
        },
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
      log('NOTE: no SLACK_BOT_TOKEN / SLACK_WEBHOOK_URL — skipping Slack (report on disk).');
    }
  } catch (err) {
    log(`WARNING: Slack post failed: ${err.message}`);
  }
}

function buildMessage({ date, bucket, changed, findings }) {
  // Slack only for findings — quiet / clean screens stay silent.
  if (!findings.length) return null;
  const newKeyCount = changed.reduce((n, c) => n + (c.newKeys?.length || 0), 0);
  const lines = [
    `🚨 *Translation screen ${date}* — ${findings.length} finding(s) on \`${bucket}\``,
    `Packs with new strings: ${changed.length} (${newKeyCount} new key(s))`,
  ];
  const show = findings.slice(0, 15);
  for (const f of show) {
    const head = f.itemId ? `${f.task}/${f.locale} \`${f.itemId}\`` : `${f.task}/${f.locale}`;
    lines.push(`• *${f.kind}* ${head}: ${f.detail}`);
    if (f.en || f.translation) {
      lines.push(`    EN: ${String(f.en).slice(0, 120)}`);
      lines.push(`    TR: ${String(f.translation).slice(0, 120)}`);
    }
  }
  if (findings.length > show.length) {
    lines.push(`_…and ${findings.length - show.length} more (see results/translation-screen/${date}.md)_`);
  }
  return lines.join('\n');
}

function buildMarkdown(snapshot) {
  const { date, changed, findings, packs } = snapshot;
  const newKeyCount = changed.reduce((n, c) => n + (c.newKeys?.length || 0), 0);
  const lines = [
    `# Translation screen ${date}`,
    '',
    `- Bucket: \`${snapshot.bucket}\``,
    `- Packs inventoried: ${packs.length}`,
    `- Packs with new strings: ${changed.length} (${newKeyCount} new key(s))`,
    `- Findings: ${findings.length}`,
    '',
    '## Packs with new strings',
    '',
  ];
  if (!changed.length) lines.push('_None_');
  else {
    for (const c of changed) {
      const nk = c.newKeys?.length ?? c.realCount;
      lines.push(
        `- \`${c.task}/${c.locale}\` — ${c.reason}, ${nk} new / ${c.realCount} approved`,
      );
    }
  }
  lines.push('', '## Findings', '');
  if (!findings.length) lines.push('_None_');
  else {
    for (const f of findings) {
      lines.push(`### ${f.kind} · ${f.task}/${f.locale} · ${f.itemId || '(pack)'}`);
      lines.push('', f.detail, '');
      if (f.en) lines.push(`- EN: ${f.en}`);
      if (f.translation) lines.push(`- TR: ${f.translation}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(EVAL_OUT, { recursive: true });
  const date = todayStr();
  log(`bucket=${GCS_BUCKET} base=${DEFAULT_BASE}`);

  const packs = await inventory();
  const skippedPlaceholders = packs.filter((p) => p.placeholderOnly).length;
  const skippedEo = IGNORE_LOCALE_PREFIXES.join(',');
  const previous = await loadBaseline();
  const changed = diffPacks(packs, previous);

  if (!changed.length) {
    const baselinePath = await saveInventoryBaseline(packs, date);
    log(
      `quiet — no new strings across ${packs.length} pack(s)` +
        ` (placeholder-only=${skippedPlaceholders}, ignore=${skippedEo}-*); baseline ${baselinePath}`,
    );
    return;
  }

  const newKeyCount = changed.reduce((n, c) => n + (c.newKeys?.length || 0), 0);
  log(
    `inventory: ${packs.length} pack(s); ${changed.length} with new strings (${newKeyCount} keys)` +
      ` (placeholder-only=${skippedPlaceholders}; ignore=${skippedEo}-*)`,
  );
  for (const c of changed) {
    log(`  ${c.reason} ${c.task}/${c.locale} (+${c.newKeys?.length || 0}/${c.realCount})`);
  }

  let findings = [];
  if (!DRY_RUN && !process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is required to screen new translations');
  }

  const visionLocales = new Map();
  const mqmJobs = [];
  if (!DRY_RUN) {
    for (const c of changed) {
      if (VISION[c.task]) {
        if (!visionLocales.has(c.task)) visionLocales.set(c.task, []);
        visionLocales.get(c.task).push(c.locale);
      } else {
        mqmJobs.push(c);
      }
    }
  } else {
    log('dry-run: skipping vision/MQM calls');
  }

  for (const [task, locales] of visionLocales) {
    findings.push(...(await screenVision(task, locales)));
  }
  for (const c of mqmJobs) {
    findings.push(...(await screenMqm(c.task, c.locale)));
  }
  findings = filterFindingsToNewKeys(findings, changed);

  const snapshot = {
    date,
    bucket: GCS_BUCKET,
    baseUrl: DEFAULT_BASE,
    packs: packsBaselinePayload(packs, date).packs,
    changed,
    findings,
    skippedPlaceholders,
    skippedEo,
  };

  const jsonPath = join(OUT_DIR, `${date}.json`);
  const mdPath = join(OUT_DIR, `${date}.md`);
  const latestPath = join(OUT_DIR, 'latest.json');
  const md = buildMarkdown(snapshot);
  // Advance baseline only after a successful pass so a mid-run failure retries.
  await saveInventoryBaseline(packs, date);
  if (!DRY_RUN) {
    await writeFile(jsonPath, JSON.stringify(snapshot, null, 2));
    await writeFile(mdPath, md);
    await writeFile(latestPath, JSON.stringify(snapshot, null, 2));
    log(`wrote ${jsonPath}`);
  }
  console.log(`\n${md}\n`);

  const msg = buildMessage({ date, bucket: GCS_BUCKET, changed, findings });
  if (msg) await postSlack(msg);
  else log('no findings — no Slack post');

  if (findings.length) process.exitCode = 2;
}

const isDirect =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirect) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
