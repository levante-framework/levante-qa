#!/usr/bin/env node
/**
 * Offline Gemini ratings for Spanish ROAR-PA items (text pack, no Cypress).
 *
 *   node tools/vlm-panel/eval_pa_es_prompt_bakeoff.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config as loadDotenv } from 'dotenv';
import { parseCSV, writeCsv } from './lib/paEs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
loadDotenv({ path: join(REPO, '.env') });
const OUT = join(HERE, 'out');
const BASELINE = join(OUT, 'pa_es_human_baseline.csv');
const HML_W = { high: 1, med: 0.5, low: 0.25 };

function parseArgs(argv) {
  const out = {
    concurrency: 8,
    model: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
    variants: ['hml_s', 'h15'],
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--concurrency') out.concurrency = Number(argv[++i]);
    else if (a === '--model') out.model = argv[++i];
    else if (a === '--variants') {
      out.variants = String(argv[++i] || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return out;
}

function subtypeLabel(sub) {
  if (sub === 'fsm') return 'first-sound matching (FSM): which picture-word starts with the same sound as the stimulus?';
  if (sub === 'lsm') return 'last-sound matching (LSM): which picture-word ends with the same sound as the stimulus?';
  return String(sub);
}

function promptsFor(variant, age, item) {
  const task = subtypeLabel(item.subtype);
  const pack = `Stimulus: "${item.stim}". Correct match: "${item.goal}". Foils: "${item.foil1}", "${item.foil2}".`;
  if (variant === 'hml_s') {
    const system = [
      'You estimate difficulty of Spanish phonological-awareness (ROAR-PA) items for children.',
      `Task type: ${task}`,
      'The child hears the words (not just reads them). Judge how hard the SOUND match is, not spelling.',
      'Reply with HIGH, MED, or LOW — would a typical child at the age below usually pick the correct match?',
      '  HIGH = nearly certain (>90%): only very obvious same-sound pairs for that age.',
      '  MED  = doable but not automatic — DEFAULT.',
      '  LOW  = often wrong: subtle shared phonemes, similar foils, or rare/long words.',
      'Do NOT default to HIGH. Prefer MED. For age 10, HIGH should be rare.',
      `Judge a typical ${age}-year-old Spanish-speaking child in school.`,
      'Reply with exactly one token: HIGH or MED or LOW. No other words.',
    ].join('\n');
    const user = `Age ${age}. ${pack} Reply HIGH, MED, or LOW.`;
    return { system, user };
  }
  const system = [
    'You estimate difficulty of Spanish phonological-awareness (ROAR-PA) items for children.',
    `Task type: ${task}`,
    'The child hears the words. Judge how hard the SOUND match is, not spelling.',
    'Reply with HARDNESS 1-5 (1=trivial … 5=very hard for that age).',
    'Use the full scale; prefer 2–4 for ordinary school items.',
    `Judge a typical ${age}-year-old Spanish-speaking child in school.`,
    'Reply with exactly one digit 1-5. No other words.',
  ].join('\n');
  const user = `Age ${age}. ${pack} Reply HARDNESS 1-5.`;
  return { system, user };
}

function parseReply(variant, raw) {
  const text = String(raw ?? '').trim().toUpperCase();
  if (variant === 'hml_s') {
    let conf = null;
    if (/\bHIGH\b/.test(text)) conf = 'high';
    else if (/\bMED\b/.test(text)) conf = 'med';
    else if (/\bLOW\b/.test(text)) conf = 'low';
    return { scoreRaw: conf ?? '', pChild: conf ? HML_W[conf] : null };
  }
  const m = text.match(/\b([1-5])\b/);
  if (!m) return { scoreRaw: '', pChild: null };
  const h = Number(m[1]);
  return { scoreRaw: h, pChild: (6 - h) / 5 };
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

async function main() {
  const args = parseArgs(process.argv);
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY not set');
    process.exit(1);
  }
  if (!existsSync(BASELINE)) {
    console.error(`Missing ${BASELINE} — run eval_pa_es_human_baseline.mjs first`);
    process.exit(1);
  }
  mkdirSync(OUT, { recursive: true });
  const items = parseCSV(readFileSync(BASELINE, 'utf8')).filter((r) => r.joined === '1' || r.joined === 1);
  const conditions = [];
  for (const variant of args.variants) {
    conditions.push({ variant, age: 6 });
    conditions.push({ variant, age: 10 });
  }
  const jobs = [];
  for (const item of items) {
    for (const c of conditions) jobs.push({ item, ...c });
  }
  console.error(`PA ES bake-off: ${items.length} items × ${conditions.length} conditions = ${jobs.length} · ${args.model}`);

  let done = 0;
  const results = await mapPool(jobs, args.concurrency, async (job) => {
    const { system, user } = promptsFor(job.variant, job.age, job.item);
    const raw = await askGeminiText({ model: args.model, system, user });
    const parsed = parseReply(job.variant, raw);
    done += 1;
    if (done % 40 === 0 || done === jobs.length) console.error(`  progress ${done}/${jobs.length}`);
    return {
      item_uid: job.item.item_uid,
      subtype: job.item.subtype,
      word: job.item.word,
      stim: job.item.stim,
      goal: job.item.goal,
      foil1: job.item.foil1,
      foil2: job.item.foil2,
      variant: job.variant,
      age: job.age,
      score_raw: parsed.scoreRaw,
      p_child: parsed.pChild,
      raw,
    };
  });

  writeCsv(join(OUT, 'pa_es_vlm_ratings.csv'), results, [
    'item_uid',
    'subtype',
    'word',
    'stim',
    'goal',
    'foil1',
    'foil2',
    'variant',
    'age',
    'score_raw',
    'p_child',
    'raw',
  ]);
  const parsedN = results.filter((r) => Number.isFinite(r.p_child)).length;
  writeFileSync(
    join(OUT, 'pa_es_vlm_ratings_summary.json'),
    JSON.stringify({ n: results.length, parsed: parsedN, args }, null, 2),
  );
  console.log(JSON.stringify({ n: results.length, parsed: parsedN, csv: 'tools/vlm-panel/out/pa_es_vlm_ratings.csv' }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
