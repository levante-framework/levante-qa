#!/usr/bin/env node
/**
 * Dual-age SWR ensemble: average p_child (ages 6 & 10), optional AoA blend,
 * vs human EN `b`. Uses existing bake-off CSV and/or fresh Gemini calls.
 *
 *   node tools/vlm-panel/eval_swr_dual_age_ensemble.mjs
 *   node tools/vlm-panel/eval_swr_dual_age_ensemble.mjs --fresh --limit 120
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config as loadDotenv } from 'dotenv';
import { lookupAoa, blendPChild, bProxyFromP } from './lib/aoa.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
loadDotenv({ path: join(REPO, '.env') });

const OUT = join(HERE, 'out');
const RUNS = join(REPO, 'cypress', 'logs', 'runs');
const BANK_EN = '/home/david/levante/roar-swr/src/wordlist/en/item_bank_v5.csv';
const BAKEOFF = join(OUT, 'swr_prompt_bakeoff.csv');
const HML_W = { high: 1, med: 0.5, low: 0.25 };

function parseArgs(argv) {
  const out = {
    fresh: false,
    limit: 120,
    concurrency: 6,
    model: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
    aoaBlend: 0.5,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fresh') out.fresh = true;
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--concurrency') out.concurrency = Number(argv[++i]);
    else if (a === '--model') out.model = argv[++i];
    else if (a === '--aoa-blend') out.aoaBlend = Number(argv[++i]);
  }
  return out;
}

function parseCSV(text) {
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  const split = (line) => {
    const out = [];
    let cur = '';
    let q = false;
    for (const ch of line) {
      if (ch === '"') {
        q = !q;
        continue;
      }
      if (ch === ',' && !q) {
        out.push(cur);
        cur = '';
        continue;
      }
      cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const hdr = split(lines[0]);
  return lines.slice(1).filter(Boolean).map((line) => {
    const cols = split(line);
    const o = {};
    hdr.forEach((h, i) => {
      o[h] = cols[i] ?? '';
    });
    return o;
  });
}

function spearman(xs, ys) {
  const n = xs.length;
  if (n < 3) return NaN;
  const rank = (arr) => {
    const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = Array(n);
    for (let i = 0; i < n; ) {
      let j = i;
      while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = rx[i] - mx;
    const b = ry[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return num / Math.sqrt(dx * dy);
}

function loadBank() {
  const by = new Map();
  for (const r of parseCSV(readFileSync(BANK_EN, 'utf8'))) {
    const w = String(r.word || '')
      .trim()
      .toLowerCase();
    if (!w) continue;
    const b = parseFloat(r.b);
    if (!Number.isFinite(b)) continue;
    by.set(w, { word: r.word, b, rp: String(r.realpseudo || '').toLowerCase() });
  }
  return by;
}

function rhoProxy(rows, pKey = 'p') {
  const scored = rows.filter((r) => Number.isFinite(r[pKey]) && Number.isFinite(r.b));
  return {
    n: scored.length,
    rho: spearman(
      scored.map((r) => bProxyFromP(r[pKey])),
      scored.map((r) => r.b),
    ),
  };
}

function applyBlend(rows, wAoa, ageYears) {
  return rows.map((r) => {
    const aoa = lookupAoa(r.word);
    const p = blendPChild({
      pVlm: r.p,
      aoa,
      ageYears,
      rp: r.rp,
      wAoa,
    });
    return { ...r, p_blend: p, aoa: Number.isFinite(aoa) ? aoa : null };
  });
}

function loadBakeoffPairs() {
  if (!existsSync(BAKEOFF)) return null;
  const rows = parseCSV(readFileSync(BAKEOFF, 'utf8')).filter((r) => r.variant === 'hml');
  const byKey = new Map();
  for (const r of rows) {
    const word = String(r.word || '').replace(/^"|"$/g, '');
    const key = word.toLowerCase();
    const age = Number(r.age);
    const p = parseFloat(r.p_child);
    if (!Number.isFinite(p) || !Number.isFinite(age)) continue;
    const row = byKey.get(key) || {
      word,
      key,
      b: parseFloat(r.b),
      rp: String(r.rp || '').toLowerCase(),
      byAge: {},
    };
    row.byAge[age] = p;
    byKey.set(key, row);
  }
  return [...byKey.values()]
    .filter((r) => Number.isFinite(r.byAge[6]) && Number.isFinite(r.byAge[10]))
    .map((r) => ({
      word: r.word,
      b: r.b,
      rp: r.rp,
      p6: r.byAge[6],
      p10: r.byAge[10],
      p: (r.byAge[6] + r.byAge[10]) / 2,
    }));
}

function loadLangfixSample(limit, bank) {
  const dirs = readdirSync(RUNS).filter(
    (d) => /^panel_swr_en_/.test(d) && d.includes('_langfix') && !/_langfix\d/.test(d),
  );
  const by = new Map();
  for (const runId of dirs) {
    const dir = join(RUNS, runId);
    const f = readdirSync(dir).find((x) => /^vlm_swr.*\.jsonl$/.test(x));
    if (!f) continue;
    for (const line of readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean)) {
      const rec = JSON.parse(line);
      if (rec.itemType !== 'item') continue;
      const word = String(rec.promptText || '').trim();
      if (!word || word === '+' || /^[123]$/.test(word)) continue;
      const key = word.toLowerCase();
      const hum = bank.get(key);
      if (!hum) continue;
      by.set(key, { word, key, b: hum.b, rp: hum.rp });
    }
  }
  const all = [...by.values()].sort((a, b) => a.b - b.b);
  const n = Math.min(limit, all.length);
  const sample = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.floor((i + 0.5) * (all.length / n));
    sample.push(all[Math.min(all.length - 1, idx)]);
  }
  const seen = new Set();
  return sample.filter((w) => (seen.has(w.key) ? false : (seen.add(w.key), true)));
}

function promptsFor(age, word) {
  const system = [
    'You help estimate difficulty for SWR (Single Word Recognition).',
    'Each trial shows one letter string. Decide two things:',
    '  (1) REAL or PSEUDO — is this an English word? (common misspellings / nonsense = PSEUDO)',
    '  (2) HIGH, MED, or LOW — would a child at the age below usually get (1) correct?',
    '        HIGH = trivial for that age',
    '        MED  = doable but not automatic (default when unsure)',
    '        LOW  = hard for that age',
    'Do not default to HIGH. Use the full scale.',
    `Judge how a typical ${age}-year-old child reader would do.`,
    'Reply with exactly two tokens, e.g. "REAL HIGH" or "PSEUDO MED".',
    'No other words or punctuation.',
  ].join('\n');
  const user = `Reply with exactly two tokens: REAL or PSEUDO, then HIGH, MED, or LOW (for a typical ${age}-year-old). The letter string is: "${word}".`;
  return { system, user };
}

function parseReply(raw) {
  const text = String(raw ?? '').trim().toUpperCase();
  let conf = null;
  if (/\bHIGH\b/.test(text)) conf = 'high';
  else if (/\bMED\b/.test(text)) conf = 'med';
  else if (/\bLOW\b/.test(text)) conf = 'low';
  return conf ? HML_W[conf] : null;
}

async function askGeminiText({ model, system, user }) {
  const { GoogleGenAI } = await import('@google/genai');
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');
  const client = new GoogleGenAI({ apiKey });
  const base = {
    model,
    contents: [{ text: user }],
    config: { systemInstruction: system, temperature: 0, maxOutputTokens: 16 },
  };
  try {
    const response = await client.models.generateContent({
      ...base,
      config: { ...base.config, thinkingConfig: { thinkingBudget: 0 } },
    });
    return String(response.text ?? '').trim();
  } catch (err) {
    const message = String(err);
    const retry =
      message.includes('Budget 0 is invalid') ||
      message.includes('only works in thinking mode') ||
      /INVALID_ARGUMENT|invalid argument/i.test(message);
    if (!retry) throw err;
    const response = await client.models.generateContent(base);
    return String(response.text ?? '').trim();
  }
}

async function mapPool(items, concurrency, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
  return out;
}

async function freshDualAge(words, args) {
  const jobs = [];
  for (const w of words) {
    for (const age of [6, 10]) jobs.push({ ...w, age });
  }
  console.error(`Fresh dual-age: ${words.length} words × 2 ages = ${jobs.length} calls`);
  let done = 0;
  const results = await mapPool(jobs, args.concurrency, async (job) => {
    const { system, user } = promptsFor(job.age, job.word);
    let raw = '';
    try {
      raw = await askGeminiText({ model: args.model, system, user });
    } catch (e) {
      console.error(`  FAIL a${job.age} ${job.word}: ${e.message || e}`);
    }
    done += 1;
    if (done % 40 === 0 || done === jobs.length) console.error(`  progress ${done}/${jobs.length}`);
    return { ...job, p: parseReply(raw), raw };
  });
  const byKey = new Map();
  for (const r of results) {
    const row = byKey.get(r.key) || { word: r.word, b: r.b, rp: r.rp, p6: null, p10: null };
    if (r.age === 6) row.p6 = r.p;
    if (r.age === 10) row.p10 = r.p;
    byKey.set(r.key, row);
  }
  return [...byKey.values()]
    .filter((r) => Number.isFinite(r.p6) && Number.isFinite(r.p10))
    .map((r) => ({ ...r, p: (r.p6 + r.p10) / 2 }));
}

function summarize(label, pairs, wAoa) {
  const base = rhoProxy(pairs, 'p');
  const blended = applyBlend(pairs, wAoa, 8); // mid age for blend persona
  const blendRho = rhoProxy(blended, 'p_blend');
  const a6 = rhoProxy(
    pairs.map((r) => ({ ...r, p: r.p6 })),
    'p',
  );
  const a10 = rhoProxy(
    pairs.map((r) => ({ ...r, p: r.p10 })),
    'p',
  );
  return { label, a6, a10, age_avg: base, age_avg_aoa: blendRho, wAoa };
}

async function main() {
  const args = parseArgs(process.argv);
  const bank = loadBank();
  mkdirSync(OUT, { recursive: true });
  const fmt = (x) => (Number.isFinite(x) ? x.toFixed(3) : 'n/a');

  const blocks = [];

  const bake = loadBakeoffPairs();
  if (bake?.length) {
    blocks.push(summarize('bakeoff_reuse', bake, args.aoaBlend));
  }

  if (args.fresh) {
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
    const sample = loadLangfixSample(args.limit, bank);
    const fresh = await freshDualAge(sample, args);
    writeFileSync(
      join(OUT, 'swr_dual_age_fresh.csv'),
      [
        'word,rp,b,p6,p10,p_avg',
        ...fresh.map((r) =>
          [JSON.stringify(r.word), r.rp, r.b, r.p6, r.p10, r.p].join(','),
        ),
      ].join('\n'),
    );
    blocks.push(summarize('langfix_fresh', fresh, args.aoaBlend));
  }

  const report = `# SWR dual-age ensemble (HML) ± AoA blend

**Date:** ${new Date().toISOString().slice(0, 10)}  
**Method:** \`p_avg = (p_age6 + p_age10) / 2\`; optional AoA blend w=${args.aoaBlend} on reals (persona age 8 for blend).  
**Score:** ρ(\`b_proxy=-z(p)\`, human \`b\`)

| Source | n | ρ a6 | ρ a10 | ρ age-avg | ρ age-avg+AoA |
|--------|--:|-----:|------:|----------:|--------------:|
${blocks
  .map((b) => {
    const n = b.age_avg.n;
    return `| ${b.label} | ${n} | ${fmt(b.a6.rho)} | ${fmt(b.a10.rho)} | **${fmt(b.age_avg.rho)}** | **${fmt(b.age_avg_aoa.rho)}** |`;
  })
  .join('\n')}

## Verdict

${
  blocks.some((b) => b.age_avg_aoa.rho > Math.max(b.a6.rho, b.a10.rho, b.age_avg.rho) + 0.01)
    ? '**GO** — dual-age + AoA beat single-age on at least one set; use for offline ranking.'
    : blocks.some((b) => b.age_avg.rho >= Math.max(b.a6.rho, b.a10.rho) - 0.01)
      ? '**LEAN-GO** — age-avg helps or ties; keep dual-age offline ranking.'
      : '**ITERATE** — dual-age did not clearly help on these sets.'
}

CSV (if --fresh): \`out/swr_dual_age_fresh.csv\`
`;

  writeFileSync(join(OUT, 'REPORT_swr_dual_age_ensemble.md'), report);
  writeFileSync(join(OUT, 'swr_dual_age_ensemble_summary.json'), JSON.stringify({ blocks, args }, null, 2));
  console.log(JSON.stringify({ blocks, report: 'tools/vlm-panel/out/REPORT_swr_dual_age_ensemble.md' }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
