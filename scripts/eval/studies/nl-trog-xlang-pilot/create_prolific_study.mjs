#!/usr/bin/env node
/**
 * Create (draft) the NL TROG Study A on Prolific via API.
 *
 * Requires PROLIFIC_API_TOKEN in the environment (or .env at repo root).
 * Create a token: https://app.prolific.com/account/api
 *
 * Usage (from repo root):
 *   node scripts/eval/studies/nl-trog-xlang-pilot/create_prolific_study.mjs
 *   node scripts/eval/studies/nl-trog-xlang-pilot/create_prolific_study.mjs --publish
 *
 * Default is DRAFT only. --publish spends balance (~£35 for 8 × £3 + fees).
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '../../../..');
const API = 'https://api.prolific.com/api/v1';

const STUDY_URL =
  'https://nl-trog-study-a.vercel.app/?PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}';
const COMPLETION_CODE = 'NLTR0GA1';

function loadEnvToken() {
  if (process.env.PROLIFIC_API_TOKEN) return process.env.PROLIFIC_API_TOKEN.trim();
  for (const p of [join(REPO, '.env'), join(HERE, '.env')]) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split(/\n/)) {
      if (line.startsWith('PROLIFIC_API_TOKEN=')) {
        return line.slice('PROLIFIC_API_TOKEN='.length).trim().replace(/^["']|["']$/g, '');
      }
    }
  }
  return '';
}

async function api(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Token ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const msg = json?.error?.detail || json?.error || json?.message || text.slice(0, 400);
    throw new Error(`${method} ${path} → ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  return json;
}

async function findFilters(token) {
  const data = await api(token, 'GET', '/filters/');
  const results = Array.isArray(data.results) ? data.results : Array.isArray(data) ? data : [];
  const byId = Object.fromEntries(results.map((f) => [f.filter_id || f.id, f]));

  const country = byId['current-country-of-residence'];
  const firstLang = byId['first-language'] || byId['primary-language'];
  const age = byId.age;
  const approval = byId.approval_rate;

  /** Prolific select filters: choices is { "0": "Label", ... } */
  function choiceId(filter, ...labels) {
    if (!filter?.choices) return null;
    const lower = labels.map((l) => l.toLowerCase());
    const entries = Array.isArray(filter.choices)
      ? filter.choices.map((c, i) => [String(c.id ?? i), c.name || c.label || c])
      : Object.entries(filter.choices);
    for (const [id, name] of entries) {
      const n = String(name).toLowerCase();
      if (lower.some((l) => n === l || n.includes(l))) return String(id);
    }
    return null;
  }

  const filters = [];

  if (!country) throw new Error('Could not find current-country-of-residence filter');
  const nl = choiceId(country, 'netherlands', 'nederland');
  if (!nl) throw new Error('Could not find Netherlands in current-country-of-residence');
  filters.push({ filter_id: country.filter_id, selected_values: [nl] });

  if (!firstLang) throw new Error('Could not find first-language filter');
  const dutch = choiceId(firstLang, 'dutch', 'nederlands');
  if (!dutch) throw new Error(`Could not find Dutch in ${firstLang.filter_id}`);
  filters.push({ filter_id: firstLang.filter_id, selected_values: [dutch] });

  if (age) {
    filters.push({
      filter_id: age.filter_id,
      selected_range: { lower: 18, upper: age.max ?? 100 },
    });
  }

  if (approval) {
    filters.push({
      filter_id: approval.filter_id,
      selected_range: { lower: 95, upper: 100 },
    });
  }

  return {
    filters,
    meta: {
      country: country.filter_id,
      country_value: nl,
      firstLang: firstLang.filter_id,
      firstLang_value: dutch,
      age: age?.filter_id,
      approval: approval?.filter_id,
    },
  };
}

function descriptionHtml() {
  return [
    '<p>We are checking Dutch translations used in a research assessment for children.</p>',
    '<p>You will see short English sentences and their Dutch translations. For each pair, you rate (1) whether the meaning matches and (2) whether the Dutch wording is natural for speaking with children.</p>',
    '<p>No specialised linguistics training is required. Please do <strong>not</strong> use machine-translation tools — we need your own judgment.</p>',
    '<ul>',
    '<li>Estimated time: 15–20 minutes</li>',
    '<li>Desktop or laptop preferred</li>',
    '</ul>',
  ].join('');
}

async function main() {
  const publish = process.argv.includes('--publish');
  const token = loadEnvToken();
  if (!token) {
    console.error(`Missing PROLIFIC_API_TOKEN.

Create a token at https://app.prolific.com/account/api
then either:
  export PROLIFIC_API_TOKEN='...'
or add to levante-qa/.env:
  PROLIFIC_API_TOKEN=...
`);
    process.exit(1);
  }

  console.log('Resolving demographic filters…');
  const { filters, meta } = await findFilters(token);
  console.log('Filters:', meta);

  const body = {
    name: 'Dutch translations for a children’s language task (English → Dutch)',
    internal_name: 'nl-trog-xlang-study-a-pilot',
    description: descriptionHtml(),
    external_study_url: STUDY_URL,
    prolific_id_option: 'url_parameters',
    total_available_places: 8,
    estimated_completion_time: 18,
    maximum_allowed_time: 45,
    reward: 300, // pence if GBP account (£3.00); cents if USD — Prolific uses account currency minor units
    device_compatibility: ['desktop', 'tablet'],
    peripheral_requirements: [],
    filters,
    completion_codes: [
      {
        code: COMPLETION_CODE,
        code_type: 'COMPLETED',
        actions: [{ action: 'AUTOMATICALLY_APPROVE' }],
      },
    ],
  };

  console.log('Creating draft study…');
  const study = await api(token, 'POST', '/studies/', body);
  const id = study.id;
  const out = join(HERE, 'prolific_study.json');
  writeFileSync(out, JSON.stringify(study, null, 2));
  console.log(`Draft created: ${id}`);
  console.log(`Saved: ${out}`);
  console.log(`Researcher URL: https://app.prolific.com/researcher/workspaces/studies/${id}`);

  if (publish) {
    console.log('Publishing…');
    const pub = await api(token, 'POST', `/studies/${id}/transition/`, { action: 'PUBLISH' });
    writeFileSync(out, JSON.stringify({ ...study, ...pub, published: true }, null, 2));
    console.log('Published.');
  } else {
    console.log('Left as DRAFT. Re-run with --publish when ready to spend balance.');
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
