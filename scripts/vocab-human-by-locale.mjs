#!/usr/bin/env node
/**
 * Aggregate human vocab correctness from hs-levante-admin-prod for flagged items.
 *
 * Locale = tasks/vocab/variants/{run.variantId}.params.language
 * Includes ALL runs (no sandbox / site filter).
 *
 * Usage:
 *   node scripts/vocab-human-by-locale.mjs
 *
 * Auth: gcloud auth print-access-token / application-default
 */
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';

const PROJECT = 'hs-levante-admin-prod';
const ROOT = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)`;

const FLAGGED = {
  'vocab-item-018': 'cloak',
  'vocab-item-044': 'pie',
  'vocab-item-088': 'ball',
  'vocab-item-110': 'picking',
  'vocab-item-115': 'claw',
  'vocab-item-129': 'confectionery',
  'vocab-item-135': 'aesthete',
  'vocab-item-142': 'habit',
  'vocab-item-155': 'precarious',
  'vocab-item-162': 'sedentary',
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'results', 'translation-screen', 'vocab-human-by-locale.json');

function getToken() {
  try {
    return execSync('gcloud auth print-access-token', { encoding: 'utf8' }).trim();
  } catch {
    return execSync('gcloud auth application-default print-access-token', {
      encoding: 'utf8',
    }).trim();
  }
}

function req(method, url, token, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body == null ? null : JSON.stringify(body);
    const headers = { Authorization: `Bearer ${token}` };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const r = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method, headers },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      },
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

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

function normLang(l) {
  if (!l) return 'unknown';
  if (l === 'es-Ar') return 'es-AR';
  return l;
}

/** Locale from variant language + name + corpus (fixes es-CO* named variants with language "es"). */
function localeFromVariant(v) {
  const lang = normLang(v.language);
  const name = v.name || '';
  const corpus = v.corpus || '';

  if (lang === 'es-AR' || lang === 'es-CO' || lang === 'de-DE' || lang === 'en-US' || lang === 'en-GB') {
    return lang;
  }
  if (/es-?ar|argentin/i.test(name) || /es-ar|argentin/i.test(corpus)) return 'es-AR';
  if (/es-?co|colombia/i.test(name) || /co-vocab|es-co|colombia/i.test(corpus)) return 'es-CO';
  if (lang && lang !== 'unknown') return lang;
  return 'unknown';
}

async function runQuery(token, structuredQuery) {
  const res = await req('POST', `${ROOT}/documents:runQuery`, token, { structuredQuery });
  if (res.status >= 400) throw new Error(`runQuery ${res.status}: ${res.body.slice(0, 400)}`);
  return JSON.parse(res.body).filter((r) => r.document);
}

async function batchGetVariantIds(token, runPaths) {
  const out = new Map();
  for (let i = 0; i < runPaths.length; i += 100) {
    const chunk = runPaths.slice(i, i + 100);
    const res = await req('POST', `${ROOT}/documents:batchGet`, token, {
      documents: chunk.map(
        (p) => `projects/${PROJECT}/databases/(default)/documents/${p}`,
      ),
      mask: { fieldPaths: ['variantId', 'taskId', 'completed'] },
    });
    if (res.status >= 400) throw new Error(`batchGet ${res.status}: ${res.body.slice(0, 400)}`);
    for (const row of JSON.parse(res.body)) {
      if (!row.found) continue;
      const path = row.found.name.split('/documents/')[1];
      out.set(path, docFields(row.found).variantId || null);
    }
  }
  return out;
}

async function main() {
  const token = getToken();

  const variants = {};
  let pageToken = null;
  do {
    let url = `${ROOT}/documents/tasks/vocab/variants?pageSize=100`;
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
    const j = JSON.parse((await req('GET', url, token)).body);
    for (const d of j.documents || []) {
      const id = d.name.split('/').pop();
      const f = docFields(d);
      const meta = {
        language: f.params?.language || null,
        name: f.name || null,
        corpus: f.params?.corpus || null,
      };
      variants[id] = { ...meta, locale: localeFromVariant(meta) };
    }
    pageToken = j.nextPageToken || null;
  } while (pageToken);

  const rows = [];
  for (const audioFile of Object.keys(FLAGGED)) {
    const docs = await runQuery(token, {
      from: [{ collectionId: 'trials', allDescendants: true }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'audioFile' },
          op: 'EQUAL',
          value: { stringValue: audioFile },
        },
      },
      limit: 5000,
    });
    const testDocs = docs.filter(
      (d) => docFields(d.document).assessment_stage === 'test_response',
    );
    const trialMeta = [];
    for (const d of testDocs) {
      const parts = d.document.name.split('/documents/')[1].split('/');
      const runPath = `users/${parts[1]}/runs/${parts[3]}`;
      trialMeta.push({
        runPath,
        correct: !!docFields(d.document).correct,
        audioFile,
        word: FLAGGED[audioFile],
      });
    }
    const unique = [...new Set(trialMeta.map((t) => t.runPath))];
    const variantByRun = await batchGetVariantIds(token, unique);
    for (const t of trialMeta) {
      const vid = variantByRun.get(t.runPath) || null;
      const meta = vid ? variants[vid] : null;
      rows.push({
        ...t,
        variantId: vid,
        locale: meta ? meta.locale : 'unknown',
      });
    }
    console.error(`${audioFile}: ${testDocs.length} test trials, ${unique.length} runs`);
  }

  const agg = {};
  for (const r of rows) {
    const key = `${r.audioFile}|${r.locale}`;
    if (!agg[key]) {
      agg[key] = {
        audioFile: r.audioFile,
        word: r.word,
        locale: r.locale,
        n: 0,
        correct: 0,
        variants: new Set(),
      };
    }
    agg[key].n += 1;
    if (r.correct) agg[key].correct += 1;
    if (r.variantId) agg[key].variants.add(r.variantId);
  }

  const table = Object.values(agg)
    .map((a) => ({
      audioFile: a.audioFile,
      word: a.word,
      locale: a.locale,
      n: a.n,
      p_correct: a.n ? a.correct / a.n : null,
      variants: [...a.variants].sort(),
      variantNames: [...a.variants].map((id) => variants[id]?.name || id),
    }))
    .sort((a, b) => a.word.localeCompare(b.word) || a.locale.localeCompare(b.locale));

  mkdirSync(dirname(OUT), { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    project: PROJECT,
    method:
      'All test_response trials; locale from variant language + name + corpus (es-CO* / CO-vocab-item-bank → es-CO)',
    nTrials: rows.length,
    locales: [...new Set(table.map((r) => r.locale))].sort(),
    table,
  };
  writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify({ out: OUT, nTrials: rows.length, locales: payload.locales }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
