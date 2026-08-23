/**
 * Shared helpers for the TROG AIG (automatic item generation) batch.
 * Frozen v4 checklist text is copied from trogPrompts.ts — do not "improve" it.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { tagResidual } from './audit_residuals.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
loadDotenv({ path: join(REPO, '.env') });

export const OUT_DIR = join(HERE, 'out', 'aig_trog');
export const BANK_PATH = join(REPO, 'cypress', 'cache', 'sim-item-bank-trog.csv');
export const METRICS_PATH = join(HERE, 'out', 'd_est_trog_en_metrics.json');
export const CHANCE = 0.25;
export const EPS = 1e-4;

export const TROG_TAG_FEATURES = [
  'passive',
  'comparative',
  'reverse_agent',
  'disjunctive',
  'negation',
  'spatial',
  'relative_clause',
];

/** Frozen v4 adult checklist — keep in sync with trogPrompts.ts SYSTEM_PROMPT_CHECKLIST. */
export const SYSTEM_PROMPT_CHECKLIST = [
  'You are taking a grammar-comprehension test, one item at a time.',
  'You hear a sentence (given to you as text) and see four pictures arranged',
  'in a 2x2 grid. Choose the ONE picture whose scene matches the meaning of the',
  'sentence. Distractors usually show the same objects in a different relationship.',
  '',
  'Before choosing, silently check:',
  '  1) Who is doing what to whom? (do not reverse agent/patient).',
  '     For passives ("X is chased/pushed by Y"), Y is the actor and X is acted on.',
  '  2) Negation scope — e.g. "the horse but not the boy is standing" means the',
  '     horse stands and the boy does not; both must match.',
  '  3) Spatial words literally (in/on/above/below/beside/under/beneath).',
  '  4) Comparatives ("taller/longer/bigger than X"): compare only the named pair',
  '     using sizes visible in the pictures — not metaphor or other objects.',
  '  5) Relative clauses / noun modifiers — HEAD-NOUN rule:',
  '     The MAIN predicate (the outer description/action) applies to the HEAD',
  '     noun only — not to other nouns that only appear inside a modifier.',
  '       • "The X that/who Y …" / "The X VERBing Y is Z" → X is what Z',
  '         describes; a picture where Y is also doing Z is usually wrong.',
  '       • Bare embeddings ("the boy the dog chases") → resolve agent/patient',
  '         inside the clause, then apply any outer description to the head.',
  '  6) Contrast connectives (despite/although/however/instead):',
  '     Match the MAIN clause’s full meaning (who + exact activity). The',
  '     concessive/subordinate side is context only — do not let it pick the',
  '     activity. A scene with the right objects but the wrong action is wrong.',
  '',
  'The pictures are numbered by position:',
  '  1 = top-left      2 = top-right',
  '  3 = bottom-left   4 = bottom-right',
  '',
  'Respond with ONLY the single digit (1, 2, 3, or 4) of the matching picture.',
  'Do not add words, punctuation, or explanation.',
].join('\n');

export function trogUserText(transcript) {
  const base = 'Reply with ONLY the digit (1-4) of the picture that matches the sentence.';
  const t = String(transcript ?? '').toLowerCase();
  const hints = [];
  if (/\bbut not\b|\bnot\b|\bneither\b|\bno (one|body)\b/.test(t)) {
    hints.push('Attend carefully to negation: who/what is excluded.');
  }
  if (/\bis (chased|pushed|followed|pulled) by\b/.test(t)) {
    hints.push('Passive: the noun after "by" is the actor.');
  } else if (/\b(chases|pushes|follows|pulls)\b/.test(t)) {
    hints.push('Do not reverse who acts on whom.');
  }
  if (!hints.length) return base;
  return `${base} ${hints.join(' ')}`;
}

export function parseChoiceDigit(raw) {
  const m = String(raw ?? '').match(/[1-4]/);
  return m ? Number(m[0]) : null;
}

export function ensureOut() {
  mkdirSync(OUT_DIR, { recursive: true });
  return OUT_DIR;
}

export function splitCsv(line) {
  const parts = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQ = !inQ;
      continue;
    }
    if (c === ',' && !inQ) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

export function readCsv(path) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf-8').replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = splitCsv(lines[0]);
  return lines.slice(1).map((line) => {
    const cols = splitCsv(line);
    const row = {};
    header.forEach((h, i) => {
      row[h] = cols[i] ?? '';
    });
    return row;
  });
}

function clip(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function logit(p) {
  const x = clip(p, EPS, 1 - EPS);
  return Math.log(x / (1 - x));
}

export function passToZ(p, c = CHANCE) {
  if (!Number.isFinite(p) || !Number.isFinite(c) || c >= 1) return null;
  const adj = (p - c) / (1 - c);
  if (!Number.isFinite(adj)) return null;
  return logit(adj);
}

export function loadFrozenDestCoefs() {
  const raw = JSON.parse(readFileSync(METRICS_PATH, 'utf-8'));
  return raw.coefficients;
}

export function destFromPred(itemUid, sentence, pPred, coefs) {
  const z = passToZ(pPred, CHANCE);
  if (z == null || !coefs) return { z: null, d_est: null, tags: [] };
  const tags = tagResidual(itemUid, sentence);
  const tagSet = new Set(tags);
  let d = coefs.intercept + coefs.z * z;
  for (const name of TROG_TAG_FEATURES) {
    if (tagSet.has(name) && Number.isFinite(coefs[name])) d += coefs[name];
  }
  return { z, d_est: d, tags };
}

export function bankConstructionStats() {
  const rows = readCsv(BANK_PATH);
  const groups = {
    reversible_passive: [],
    x_but_not_y: [],
  };
  for (const r of rows) {
    const d = Number(r.d);
    if (!Number.isFinite(d)) continue;
    const tt = String(r.trial_type || '').toLowerCase();
    const uid = String(r.item_uid || '');
    if (tt === 'reversible passive' || uid.startsWith('trog_revpassive_')) {
      groups.reversible_passive.push({ item_uid: uid, sentence: r.item, d });
    }
    if (tt === 'x but not y' || uid.startsWith('trog_xnoty_')) {
      groups.x_but_not_y.push({ item_uid: uid, sentence: r.item, d });
    }
  }
  const summarize = (arr) => {
    if (!arr.length) return { n: 0, min: null, max: null, mean: null };
    const ds = arr.map((a) => a.d);
    return {
      n: arr.length,
      min: Math.min(...ds),
      max: Math.max(...ds),
      mean: ds.reduce((s, x) => s + x, 0) / ds.length,
      items: arr,
    };
  };
  return {
    reversible_passive: summarize(groups.reversible_passive),
    x_but_not_y: summarize(groups.x_but_not_y),
  };
}

export async function askGeminiText({
  model,
  system,
  user,
  temperature = 0,
  maxOutputTokens = 1024,
}) {
  const { GoogleGenAI } = await import('@google/genai');
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');
  const client = new GoogleGenAI({ apiKey });
  const base = {
    model,
    contents: [{ text: user }],
    config: { systemInstruction: system, temperature, maxOutputTokens },
  };
  try {
    const response = await client.models.generateContent({
      ...base,
      config: { ...base.config, thinkingConfig: { thinkingBudget: 0 } },
    });
    const text = String(response.text ?? '').trim();
    if (text) return text;
  } catch (err) {
    const message = String(err);
    const retry =
      message.includes('Budget 0 is invalid') ||
      message.includes('only works in thinking mode') ||
      /INVALID_ARGUMENT|invalid argument/i.test(message);
    if (!retry) throw err;
  }
  const response = await client.models.generateContent(base);
  return String(response.text ?? '').trim();
}

export async function askGeminiVision({
  model,
  system,
  user,
  imageBuf,
  mimeType = 'image/png',
  temperature = 0.5,
  maxOutputTokens = 16,
}) {
  const { GoogleGenAI } = await import('@google/genai');
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');
  const client = new GoogleGenAI({ apiKey });
  const contents = [
    {
      role: 'user',
      parts: [
        { inlineData: { mimeType, data: imageBuf.toString('base64') } },
        { text: user },
      ],
    },
  ];
  const base = {
    model,
    contents,
    config: { systemInstruction: system, temperature, maxOutputTokens },
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

export async function generateGeminiImage({ model, prompt }) {
  const { GoogleGenAI } = await import('@google/genai');
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');
  const client = new GoogleGenAI({ apiKey });
  const response = await client.models.generateContent({
    model,
    contents: [{ text: prompt }],
    config: { responseModalities: ['IMAGE', 'TEXT'] },
  });
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    const data = part.inlineData?.data || part.inline_data?.data;
    if (data) return Buffer.from(data, 'base64');
  }
  throw new Error(`No image bytes from ${model}`);
}

export async function mapPool(items, concurrency, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

export function parseLockVerdict(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { hit: false, reason: 'empty lock reply' };
  try {
    return parseJsonObject(text);
  } catch {
    /* fall through */
  }
  const lower = text.toLowerCase();
  if (/\bhit\s*[:=]\s*true\b/.test(lower) || /^\s*yes\b/.test(lower) || /\btrue\b/.test(lower)) {
    return { hit: true, reason: text.slice(0, 240) };
  }
  if (/\bhit\s*[:=]\s*false\b/.test(lower) || /^\s*no\b/.test(lower) || /\bfalse\b/.test(lower)) {
    return { hit: false, reason: text.slice(0, 240) };
  }
  throw new Error(`No lock verdict in: ${text.slice(0, 180)}`);
}

export function parseJsonObject(raw) {
  const text = String(raw ?? '').trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('No JSON object in model reply');
  return JSON.parse(body.slice(start, end + 1));
}

export function parseJsonArray(raw) {
  const text = String(raw ?? '').trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end < start) throw new Error('No JSON array in model reply');
  return JSON.parse(body.slice(start, end + 1));
}

export function slugWords(sentence) {
  return String(sentence)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .split(/\s+/)
    .filter((w) => !/^(the|a|an|is|by|but|not|and)$/.test(w))
    .slice(0, 6)
    .join('_');
}
