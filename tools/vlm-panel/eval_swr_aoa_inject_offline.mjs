#!/usr/bin/env node
/**
 * Offline SWR prompt smoke WITH Kuperman AoA injected into the user text.
 * Compares to prior bake-off rows (no AoA) on the same words × hml ages 6/10.
 *
 *   node tools/vlm-panel/eval_swr_aoa_inject_offline.mjs [--concurrency 6]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config as loadDotenv } from 'dotenv';
import { lookupAoa, bProxyFromP } from './lib/aoa.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
loadDotenv({ path: join(REPO, '.env') });

const OUT = join(HERE, 'out');
const BAKEOFF_CSV = join(OUT, 'swr_prompt_bakeoff.csv');
process.env.QA_SWR_PROMPT = 'v2';
process.env.QA_SWR_AOA = '1';

const HML_W = { high: 1, med: 0.5, low: 0.25 };

function parseArgs(argv) {
  const out = {
    concurrency: 6,
    model: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--concurrency') out.concurrency = Number(argv[++i]);
    else if (a === '--model') out.model = argv[++i];
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

function ageLine(age) {
  return `Judge how a typical ${age}-year-old child reader would do.`;
}

function promptsFor(age, word, aoa) {
  const system = [
    'You help estimate difficulty for SWR (Single Word Recognition).',
    'Each trial shows one letter string. Decide two things:',
    '  (1) REAL or PSEUDO — is this an English word? (common misspellings / nonsense = PSEUDO)',
    '  (2) HIGH, MED, or LOW — would a child at the age below usually get (1) correct?',
    '        HIGH = trivial for that age (very common short words / obvious nonsense)',
    '        MED  = doable but not automatic for that age (default when unsure)',
    '        LOW  = hard for that age (rare, long, academic, or subtle pseudowords)',
    'Do not default to HIGH. Use the full scale; many school-age items should be MED.',
    ageLine(age),
    'When a Kuperman age-of-acquisition (AoA) is provided, use it for REAL words only',
    '(later AoA → harder for that child). Ignore AoA if the string is PSEUDO.',
    'Look carefully at every letter. Short common words (cat, open, night) are REAL.',
    'Made-up letter strings (blans, youx, plissars) are PSEUDO.',
    'Reply with exactly two tokens, e.g. "REAL HIGH" or "PSEUDO MED" or "REAL LOW".',
    'No other words or punctuation.',
  ].join('\n');
  let user = `Reply with exactly two tokens: REAL or PSEUDO, then HIGH, MED, or LOW (would a typical ${age}-year-old correctly judge this string?). Example: "REAL HIGH" or "PSEUDO LOW". The letter string is: "${word}".`;
  if (Number.isFinite(aoa)) {
    user +=
      ` Kuperman age-of-acquisition for this word (if REAL) is about ${aoa.toFixed(1)} years` +
      ` — treat later AoA as harder for that child age; ignore AoA if PSEUDO.`;
  }
  return { system, user };
}

function parseReply(raw) {
  const text = String(raw ?? '').trim().toUpperCase();
  let lexical = null;
  if (/\bREAL\b/.test(text)) lexical = 'real';
  else if (/\bPSEUDO\b/.test(text)) lexical = 'pseudo';
  let conf = null;
  if (/\bHIGH\b/.test(text)) conf = 'high';
  else if (/\bMED\b/.test(text)) conf = 'med';
  else if (/\bLOW\b/.test(text)) conf = 'low';
  return {
    lexical,
    conf,
    pChild: conf ? HML_W[conf] : null,
    raw: String(raw ?? ''),
  };
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

function rhoProxy(rows) {
  const scored = rows.filter((r) => Number.isFinite(r.pChild) && Number.isFinite(r.b));
  return spearman(
    scored.map((r) => bProxyFromP(r.pChild)),
    scored.map((r) => r.b),
  );
}

async function main() {
  const args = parseArgs(process.argv);
  if (!existsSync(BAKEOFF_CSV)) {
    console.error('Missing bake-off CSV; run eval_swr_prompt_bakeoff.mjs first');
    process.exit(1);
  }
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY not set');
    process.exit(1);
  }

  const bake = parseCSV(readFileSync(BAKEOFF_CSV, 'utf8'));
  const baselineBy = new Map();
  const words = new Map();
  for (const r of bake) {
    if (r.variant !== 'hml') continue;
    const word = String(r.word || '').replace(/^"|"$/g, '');
    const key = word.toLowerCase();
    const age = Number(r.age);
    const cond = r.condition;
    baselineBy.set(`${cond}::${key}`, {
      pChild: parseFloat(r.p_child),
      b: parseFloat(r.b),
      rp: r.rp,
    });
    if (!words.has(key)) {
      words.set(key, { word, key, b: parseFloat(r.b), rp: r.rp });
    }
  }

  const ages = [6, 10];
  const jobs = [];
  for (const w of words.values()) {
    for (const age of ages) {
      jobs.push({ ...w, age, condition: `hml_a${age}_aoa` });
    }
  }

  console.error(
    `AoA-inject offline: ${words.size} words × ${ages.length} ages = ${jobs.length} calls`,
  );

  let done = 0;
  const results = await mapPool(jobs, args.concurrency, async (job) => {
    const aoa = lookupAoa(job.word);
    const { system, user } = promptsFor(job.age, job.word, aoa);
    let raw = '';
    try {
      raw = await askGeminiText({ model: args.model, system, user });
    } catch (e) {
      console.error(`  FAIL ${job.condition} ${job.word}: ${e.message || e}`);
    }
    const parsed = parseReply(raw);
    done += 1;
    if (done % 40 === 0 || done === jobs.length) console.error(`  progress ${done}/${jobs.length}`);
    return {
      condition: job.condition,
      age: job.age,
      word: job.word,
      key: job.key,
      b: job.b,
      rp: job.rp,
      aoa: aoa ?? '',
      pChild: parsed.pChild,
      lexical: parsed.lexical || '',
      raw,
    };
  });

  const fmt = (x) => (Number.isFinite(x) ? x.toFixed(3) : 'n/a');
  const summary = {};
  for (const age of ages) {
    const inj = results.filter((r) => r.age === age);
    const baseCond = `hml_a${age}`;
    const baseRows = [...words.values()]
      .map((w) => {
        const b = baselineBy.get(`${baseCond}::${w.key}`);
        if (!b || !Number.isFinite(b.pChild)) return null;
        return { pChild: b.pChild, b: b.b };
      })
      .filter(Boolean);
    summary[`hml_a${age}`] = {
      baseline_rho: rhoProxy(baseRows),
      inject_rho: rhoProxy(inj),
      n: inj.length,
      aoa_hit: inj.filter((r) => r.aoa !== '').length,
    };
  }

  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    join(OUT, 'swr_aoa_inject_offline.csv'),
    [
      'condition,age,word,rp,b,aoa,p_child,lexical,raw',
      ...results.map((r) =>
        [
          r.condition,
          r.age,
          JSON.stringify(r.word),
          r.rp,
          r.b,
          r.aoa,
          r.pChild ?? '',
          r.lexical,
          JSON.stringify(r.raw),
        ].join(','),
      ),
    ].join('\n'),
  );

  const report = `# SWR AoA prompt-inject offline (vs bake-off HML)

**Date:** ${new Date().toISOString().slice(0, 10)}  
**Model:** \`${args.model}\` · **n words:** ${words.size} · **calls:** ${jobs.length}  
**Compare:** same bake-off word set, \`hml\` ages 6/10, with Kuperman AoA line in user text.

| Condition | ρ baseline (no AoA) | ρ with AoA inject | Δ | n |
|-----------|--------------------:|------------------:|--:|--:|
${ages
  .map((age) => {
    const s = summary[`hml_a${age}`];
    const d =
      Number.isFinite(s.inject_rho) && Number.isFinite(s.baseline_rho)
        ? s.inject_rho - s.baseline_rho
        : NaN;
    return `| hml_a${age} | ${fmt(s.baseline_rho)} | **${fmt(s.inject_rho)}** | ${fmt(d)} | ${s.n} |`;
  })
  .join('\n')}

## Verdict

${
  ages.some((a) => summary[`hml_a${a}`].inject_rho > summary[`hml_a${a}`].baseline_rho + 0.02)
    ? '**GO for AoA inject** on at least one age — keep `QA_SWR_AOA=1` (default) for v2/v3.'
    : ages.some((a) => summary[`hml_a${a}`].inject_rho >= summary[`hml_a${a}`].baseline_rho - 0.02)
      ? '**LEAN-GO / neutral** — inject does not hurt much; keep default ON + prefer post-hoc blend (w≈0.5) for age-6 ranking.'
      : '**NO-GO inject** — disable `QA_SWR_AOA=0`; rely on post-hoc blend only.'
}

Also see \`out/REPORT_swr_aoa_blend.md\` (post-hoc w sweep).
`;

  writeFileSync(join(OUT, 'REPORT_swr_aoa_inject_offline.md'), report);
  writeFileSync(join(OUT, 'swr_aoa_inject_offline_summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ summary, report: 'tools/vlm-panel/out/REPORT_swr_aoa_inject_offline.md' }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
