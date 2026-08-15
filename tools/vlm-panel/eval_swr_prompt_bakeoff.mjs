#!/usr/bin/env node
/**
 * Offline SWR prompt bake-off vs human EN bank `b` (text-only Gemini).
 *
 * Variants:
 *   hml   — REAL|PSEUDO + HIGH|MED|LOW (current v2)
 *   hml_s — same scale, stricter HIGH (anti-ceiling)
 *   h15   — REAL|PSEUDO + HARDNESS 1-5 (1=easiest for child)
 * Ages: 6 and 10 (also report age-averaged p).
 *
 *   node tools/vlm-panel/eval_swr_prompt_bakeoff.mjs [--limit 120] [--concurrency 4]
 *   node tools/vlm-panel/eval_swr_prompt_bakeoff.mjs --source bank --limit 180 --variants hml,hml_s,h15
 *
 * Held-out: 70/30 split by word hash; primary metric = Spearman ρ(b_proxy, b) on test.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config as loadDotenv } from 'dotenv';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
loadDotenv({ path: join(REPO, '.env') });

const OUT = join(HERE, 'out');
const RUNS = join(REPO, 'cypress', 'logs', 'runs');
const BANK_EN = '/home/david/levante/roar-swr/src/wordlist/en/item_bank_v5.csv';

const HML_W = { high: 1, med: 0.5, low: 0.25 };

function parseArgs(argv) {
  const out = {
    limit: 120,
    concurrency: 4,
    model: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
    seed: 42,
    /** If set, use unique item words from this run dir (matched offline diagnosis). */
    fromRun: '',
    /** langfix (default) | bank — ignore panel words; stratify full EN bank. */
    source: 'langfix',
    /** Comma list: hml,hml_s,h15 (default all three). */
    variants: ['hml', 'hml_s', 'h15'],
    /** Optional output tag (e.g. full) → swr_prompt_bakeoff_bank_full.csv */
    tag: '',
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--concurrency') out.concurrency = Number(argv[++i]);
    else if (a === '--model') out.model = argv[++i];
    else if (a === '--seed') out.seed = Number(argv[++i]);
    else if (a === '--from-run') out.fromRun = String(argv[++i] || '').trim();
    else if (a === '--source') out.source = String(argv[++i] || 'langfix').trim().toLowerCase();
    else if (a === '--tag') out.tag = String(argv[++i] || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
    else if (a === '--variants') {
      out.variants = String(argv[++i] || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === '--help') {
      console.log(
        'Usage: node tools/vlm-panel/eval_swr_prompt_bakeoff.mjs [--limit N] [--concurrency K] [--model id] [--from-run RUN_ID] [--source langfix|bank] [--variants hml,hml_s,h15] [--tag name]',
      );
      process.exit(0);
    }
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

function logit(p) {
  const x = Math.min(1 - 1e-6, Math.max(1e-6, p));
  return Math.log(x / (1 - x));
}

function zFromP(p, c = 0.5) {
  const adj = Math.min(1 - 1e-3, Math.max(1e-3, (p - c) / (1 - c)));
  return logit(adj);
}

function hashWord(w, seed) {
  let h = seed >>> 0;
  const s = String(w);
  for (let i = 0; i < s.length; i++) h = (Math.imul(h ^ s.charCodeAt(i), 0x9e3779b1) >>> 0);
  return h;
}

function ageLine(age) {
  return `Judge how a typical ${age}-year-old child reader would do.`;
}

function promptsFor(variant, age, word) {
  if (variant === 'hml' || variant === 'hml_s') {
    const strict = variant === 'hml_s';
    const system = [
      'You help estimate difficulty for SWR (Single Word Recognition).',
      'Each trial shows one letter string. Decide two things:',
      '  (1) REAL or PSEUDO — is this an English word? (common misspellings / nonsense = PSEUDO)',
      '  (2) HIGH, MED, or LOW — probability a child at the age below usually gets (1) correct.',
      ...(strict
        ? [
            '        HIGH = nearly certain (>90%): only ultra-common early words (cat, dog, big) or blatant nonsense (xkq).',
            '        MED  = plausible but not automatic — DEFAULT. Most grade-level real words and many pseudos.',
            '        LOW  = often wrong: rare/academic/long words, or pseudos that look like real words.',
            'CRITICAL: Do NOT use HIGH for ordinary school vocabulary. Prefer MED. For age 10, HIGH should be rare (<20%).',
            'If the word is longer than 5 letters or uncommon, do not choose HIGH.',
          ]
        : [
            '        HIGH = trivial for that age (very common short words / obvious nonsense)',
            '        MED  = doable but not automatic for that age (default when unsure)',
            '        LOW  = hard for that age (rare, long, academic, or subtle pseudowords)',
            'Do not default to HIGH. Use the full scale; many school-age items should be MED.',
          ]),
      ageLine(age),
      'Look carefully at every letter. Short common words (cat, open, night) are REAL.',
      'Made-up letter strings (blans, youx, plissars) are PSEUDO.',
      'Reply with exactly two tokens, e.g. "REAL HIGH" or "PSEUDO MED" or "REAL LOW".',
      'No other words or punctuation.',
    ].join('\n');
    const user = `Reply with exactly two tokens: REAL or PSEUDO, then HIGH, MED, or LOW (would a typical ${age}-year-old correctly judge this string?). Example: "REAL HIGH" or "PSEUDO LOW". The letter string is: "${word}".`;
    return { system, user };
  }
  // h15
  const system = [
    'You help estimate difficulty for SWR (Single Word Recognition).',
    'Each trial shows one letter string. Decide two things:',
    '  (1) REAL or PSEUDO — is this an English word? (misspellings / nonsense = PSEUDO)',
    '  (2) HARDNESS 1-5 — how hard would (1) be for a child at the age below?',
    '        1 = trivial (very common short words / obvious nonsense)',
    '        2 = easy',
    '        3 = moderate (default when unsure)',
    '        4 = hard (rare, long, or subtle)',
    '        5 = very hard for that age',
    'Use the full 1-5 scale; do not default to 1 or 3 for everything. Prefer 2–4 for ordinary school words.',
    ageLine(age),
    'Look carefully at every letter. Short common words (cat, open, night) are REAL.',
    'Made-up letter strings (blans, youx, plissars) are PSEUDO.',
    'Reply with exactly two tokens, e.g. "REAL 2" or "PSEUDO 4" or "REAL 5".',
    'No other words or punctuation.',
  ].join('\n');
  const user = `Reply with exactly two tokens: REAL or PSEUDO, then HARDNESS 1-5 (for a typical ${age}-year-old). Example: "REAL 2" or "PSEUDO 4". The letter string is: "${word}".`;
  return { system, user };
}

function parseReply(variant, raw) {
  const text = String(raw ?? '').trim().toUpperCase();
  let lexical = null;
  if (/\bREAL\b/.test(text)) lexical = 'real';
  else if (/\bPSEUDO\b/.test(text)) lexical = 'pseudo';

  let pChild = null;
  let scoreRaw = null;
  if (variant === 'hml' || variant === 'hml_s') {
    let conf = null;
    if (/\bHIGH\b/.test(text)) conf = 'high';
    else if (/\bMED\b/.test(text)) conf = 'med';
    else if (/\bLOW\b/.test(text)) conf = 'low';
    scoreRaw = conf;
    if (conf) pChild = HML_W[conf];
  } else {
    const m = text.match(/\b([1-5])\b/);
    if (m) {
      const h = Number(m[1]);
      scoreRaw = h;
      // 1 → 1.0 easiness … 5 → 0.2
      pChild = (6 - h) / 5;
    }
  }
  return { lexical, scoreRaw, pChild, raw: String(raw ?? '') };
}

function loadBank() {
  const by = new Map();
  for (const r of parseCSV(readFileSync(BANK_EN, 'utf8'))) {
    const w = String(r.word || '').trim().toLowerCase();
    if (!w) continue;
    const b = parseFloat(r.b);
    if (!Number.isFinite(b)) continue;
    by.set(w, { word: r.word, b, rp: String(r.realpseudo || '').toLowerCase() });
  }
  return by;
}

function loadLangfixWords() {
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
      const row = by.get(key) || { word, n: 0 };
      row.n += 1;
      by.set(key, row);
    }
  }
  return { dirs: dirs.length, items: [...by.values()] };
}

/** Unique item words (+ live pChild/hardness) from one panel run. */
function loadWordsFromRun(runId) {
  const dir = join(RUNS, runId);
  const f = readdirSync(dir).find((x) => /^vlm_swr.*\.jsonl$/.test(x));
  if (!f) throw new Error(`No vlm_swr*.jsonl in ${dir}`);
  const by = new Map();
  for (const line of readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean)) {
    const rec = JSON.parse(line);
    if (rec.itemType !== 'item') continue;
    const word = String(rec.promptText || '').trim();
    if (!word || word === '+' || /^[123]$/.test(word)) continue;
    const key = word.toLowerCase();
    const raw = String(rec.modelRaw || '').trim().toUpperCase();
    let pLive = rec.pChild != null ? Number(rec.pChild) : null;
    let hardness = null;
    const hm = raw.match(/\b([1-5])\b/);
    if (hm) {
      hardness = Number(hm[1]);
      if (!Number.isFinite(pLive)) pLive = (6 - hardness) / 5;
    }
    const row = by.get(key) || {
      word,
      n: 0,
      liveRaw: raw,
      livePChild: null,
      liveHardness: null,
    };
    row.n += 1;
    // Keep first trial's live rating for matched comparison.
    if (row.livePChild == null && Number.isFinite(pLive)) {
      row.livePChild = pLive;
      row.liveHardness = hardness;
      row.liveRaw = String(rec.modelRaw || '');
    }
    by.set(key, row);
  }
  return { file: f, items: [...by.values()] };
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

function metricsFor(rows) {
  const scored = rows.filter((r) => Number.isFinite(r.pChild) && Number.isFinite(r.b));
  const withProxy = scored.map((r) => ({ ...r, b_proxy: -zFromP(r.pChild) }));
  const train = withProxy.filter((r) => r.split === 'train');
  const test = withProxy.filter((r) => r.split === 'test');
  const rhoAll = spearman(
    withProxy.map((r) => r.b_proxy),
    withProxy.map((r) => r.b),
  );
  const rhoP = spearman(
    withProxy.map((r) => r.pChild),
    withProxy.map((r) => r.b),
  );
  const rhoTest = spearman(
    test.map((r) => r.b_proxy),
    test.map((r) => r.b),
  );
  const lexN = rows.filter((r) => r.lexMatch === 0 || r.lexMatch === 1).length;
  const lexHits = rows.filter((r) => r.lexMatch === 1).length;
  const nCeil = withProxy.filter((r) => r.pChild >= 0.99).length;
  const nUniqueP = new Set(withProxy.map((r) => r.pChild)).size;
  return {
    n: rows.length,
    scored: withProxy.length,
    n_train: train.length,
    n_test: test.length,
    rho_b_proxy_all: rhoAll,
    rho_p_child_all: rhoP,
    rho_b_proxy_test: rhoTest,
    lex_acc: lexN ? lexHits / lexN : null,
    parse_rate: withProxy.length / Math.max(1, rows.length),
    frac_ceiling: withProxy.length ? nCeil / withProxy.length : null,
    n_unique_p: nUniqueP,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY not set');
    process.exit(1);
  }

  const bank = loadBank();
  const matched = Boolean(args.fromRun);
  let words = [];

  if (matched) {
    const panel = loadWordsFromRun(args.fromRun);
    words = panel.items
      .map((it) => {
        const hum = bank.get(it.word.toLowerCase());
        if (!hum) return null;
        return {
          word: it.word,
          key: it.word.toLowerCase(),
          b: hum.b,
          rp: hum.rp,
          n_panel: it.n,
          livePChild: it.livePChild,
          liveHardness: it.liveHardness,
          liveRaw: it.liveRaw,
          split: hashWord(it.word.toLowerCase(), args.seed) % 10 < 7 ? 'train' : 'test',
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.b - b.b);
    console.error(
      `Matched mode: --from-run ${args.fromRun} → ${words.length} words (jsonl ${panel.file})`,
    );
  } else {
    let candidates;
    if (args.source === 'bank') {
      candidates = [...bank.values()]
        .map((hum) => ({
          word: hum.word,
          key: hum.word.toLowerCase(),
          b: hum.b,
          rp: hum.rp,
          n_panel: 0,
        }))
        .sort((a, b) => a.b - b.b);
      console.error(`Source=bank: ${candidates.length} EN bank words with b`);
    } else {
      const panel = loadLangfixWords();
      // Stratify by |b| quartiles from panel∩bank, then fill from bank if needed.
      candidates = panel.items
        .map((it) => {
          const hum = bank.get(it.word.toLowerCase());
          if (!hum) return null;
          return { word: it.word, key: it.word.toLowerCase(), b: hum.b, rp: hum.rp, n_panel: it.n };
        })
        .filter(Boolean)
        .sort((a, b) => a.b - b.b);

      if (candidates.length < args.limit) {
        for (const [key, hum] of bank) {
          if (candidates.some((c) => c.key === key)) continue;
          candidates.push({ word: hum.word, key, b: hum.b, rp: hum.rp, n_panel: 0 });
        }
        candidates.sort((a, b) => a.b - b.b);
      }
      console.error(`Source=langfix(+bank fill): ${candidates.length} candidates`);
    }

    // Even sample across difficulty.
    const n = Math.min(args.limit, candidates.length);
    const sample = [];
    for (let i = 0; i < n; i++) {
      const idx = Math.floor((i + 0.5) * (candidates.length / n));
      sample.push(candidates[Math.min(candidates.length - 1, idx)]);
    }
    // de-dupe
    const seen = new Set();
    for (const w of sample) {
      if (seen.has(w.key)) continue;
      seen.add(w.key);
      words.push({
        ...w,
        split: hashWord(w.key, args.seed) % 10 < 7 ? 'train' : 'test',
      });
    }
  }

  const allowed = new Set(args.variants);
  const conditions = [];
  for (const variant of ['hml', 'hml_s', 'h15']) {
    if (!allowed.has(variant)) continue;
    conditions.push({ id: `${variant}_a6`, variant, age: 6 });
    conditions.push({ id: `${variant}_a10`, variant, age: 10 });
  }
  if (!conditions.length) {
    console.error('No variants selected');
    process.exit(1);
  }

  console.error(
    `Bake-off: ${words.length} words × ${conditions.length} conditions · model=${args.model} · concurrency=${args.concurrency}`,
  );

  const jobs = [];
  for (const w of words) {
    for (const c of conditions) {
      jobs.push({ word: w, condition: c });
    }
  }

  let done = 0;
  const jobResults = await mapPool(jobs, args.concurrency, async (job) => {
    const { word: w, condition: c } = job;
    const { system, user } = promptsFor(c.variant, c.age, w.word);
    let raw = '';
    try {
      raw = await askGeminiText({ model: args.model, system, user });
    } catch (e) {
      raw = '';
      console.error(`  FAIL ${c.id} ${w.word}: ${e.message || e}`);
    }
    const parsed = parseReply(c.variant, raw);
    const lexMatch =
      parsed.lexical && (w.rp === 'real' || w.rp === 'pseudo')
        ? parsed.lexical === w.rp
          ? 1
          : 0
        : '';
    done += 1;
    if (done % 40 === 0 || done === jobs.length) {
      console.error(`  progress ${done}/${jobs.length}`);
    }
    return {
      condition: c.id,
      variant: c.variant,
      age: c.age,
      word: w.word,
      key: w.key,
      b: w.b,
      rp: w.rp,
      split: w.split,
      lexical: parsed.lexical || '',
      scoreRaw: parsed.scoreRaw ?? '',
      pChild: parsed.pChild,
      lexMatch,
      raw,
    };
  });

  // Per-condition metrics
  const byCond = new Map();
  for (const r of jobResults) {
    if (!byCond.has(r.condition)) byCond.set(r.condition, []);
    byCond.get(r.condition).push(r);
  }

  // Age-averaged ensembles per variant
  const byWordVar = new Map();
  for (const r of jobResults) {
    if (!Number.isFinite(r.pChild)) continue;
    const k = `${r.variant}::${r.key}`;
    const row = byWordVar.get(k) || {
      variant: r.variant,
      word: r.word,
      key: r.key,
      b: r.b,
      rp: r.rp,
      split: r.split,
      ps: [],
      lexHits: 0,
      lexN: 0,
    };
    row.ps.push(r.pChild);
    if (r.lexMatch === 0 || r.lexMatch === 1) {
      row.lexN += 1;
      row.lexHits += r.lexMatch;
    }
    byWordVar.set(k, row);
  }
  const ensembles = {
    hml_age_avg: [],
    hml_s_age_avg: [],
    h15_age_avg: [],
  };
  for (const row of byWordVar.values()) {
    const pChild = row.ps.reduce((a, b) => a + b, 0) / row.ps.length;
    const entry = {
      ...row,
      pChild,
      lexMatch: row.lexN ? (row.lexHits === row.lexN ? 1 : row.lexHits > 0 ? 0.5 : 0) : '',
    };
    if (row.variant === 'hml') ensembles.hml_age_avg.push(entry);
    else if (row.variant === 'hml_s') ensembles.hml_s_age_avg.push(entry);
    else if (row.variant === 'h15') ensembles.h15_age_avg.push(entry);
  }

  const summary = {};
  for (const [id, rows] of byCond) summary[id] = metricsFor(rows);
  for (const [id, rows] of Object.entries(ensembles)) {
    if (rows.length) summary[id] = metricsFor(rows);
  }

  let liveVsOffline = null;
  if (matched) {
    const liveRows = words
      .filter((w) => Number.isFinite(w.livePChild))
      .map((w) => ({
        condition: 'live_v3_a6',
        variant: 'h15',
        age: 6,
        word: w.word,
        key: w.key,
        b: w.b,
        rp: w.rp,
        split: w.split,
        pChild: w.livePChild,
        lexMatch: '',
      }));
    summary.live_v3_a6 = metricsFor(liveRows);

    const offlineA6 = byCond.get('h15_a6') || [];
    const byKeyOff = new Map(
      offlineA6.filter((r) => Number.isFinite(r.pChild)).map((r) => [r.key, r]),
    );
    const paired = [];
    for (const w of words) {
      const off = byKeyOff.get(w.key);
      if (!off || !Number.isFinite(w.livePChild)) continue;
      paired.push({ live: w.livePChild, offline: off.pChild, b: w.b });
    }
    liveVsOffline = {
      n: paired.length,
      rho_live_offline_p: spearman(
        paired.map((p) => p.live),
        paired.map((p) => p.offline),
      ),
      rho_live_b: spearman(
        paired.map((p) => p.live),
        paired.map((p) => p.b),
      ),
      rho_offline_b: spearman(
        paired.map((p) => p.offline),
        paired.map((p) => p.b),
      ),
    };
  }

  const ranked = Object.entries(summary)
    .filter(([id]) => !id.startsWith('live_'))
    .map(([id, m]) => ({
      id,
      rho_test: m.rho_b_proxy_test,
      rho_all: m.rho_b_proxy_all,
      lex_acc: m.lex_acc,
      parse_rate: m.parse_rate,
      frac_ceiling: m.frac_ceiling,
      n_unique_p: m.n_unique_p,
      n_test: m.n_test,
      score: Number.isFinite(m.rho_b_proxy_test) ? m.rho_b_proxy_test : m.rho_b_proxy_all,
    }))
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

  const winner = ranked[0];

  mkdirSync(OUT, { recursive: true });
  const csvName = matched
    ? 'swr_prompt_matched_offline.csv'
    : args.source === 'bank'
      ? `swr_prompt_bakeoff_bank${args.tag ? `_${args.tag}` : ''}.csv`
      : 'swr_prompt_bakeoff.csv';
  const csvPath = join(OUT, csvName);
  const cols = [
    'condition',
    'variant',
    'age',
    'word',
    'rp',
    'b',
    'split',
    'lexical',
    'score_raw',
    'p_child',
    'lex_match',
    'raw',
  ];
  writeFileSync(
    csvPath,
    [
      cols.join(','),
      ...jobResults.map((r) =>
        [
          r.condition,
          r.variant,
          r.age,
          JSON.stringify(r.word),
          r.rp,
          r.b,
          r.split,
          r.lexical,
          r.scoreRaw,
          r.pChild ?? '',
          r.lexMatch,
          JSON.stringify(r.raw),
        ].join(','),
      ),
    ].join('\n'),
  );

  const fmt = (x) => (Number.isFinite(x) ? x.toFixed(3) : 'n/a');
  const liveRow =
    matched && summary.live_v3_a6
      ? `| live_v3_a6 (from jsonl) | ${summary.live_v3_a6.n_test} | **${fmt(summary.live_v3_a6.rho_b_proxy_test)}** | ${fmt(summary.live_v3_a6.rho_b_proxy_all)} | ${fmt(summary.live_v3_a6.rho_p_child_all)} | ${fmt(summary.live_v3_a6.lex_acc)} | ${fmt(summary.live_v3_a6.parse_rate)} |`
      : '';
  const liveBlock =
    matched && liveVsOffline
      ? `
## Live vs offline (same words, h15 age 6)

| Metric | Value |
|--------|------:|
| n paired | ${liveVsOffline.n} |
| ρ(live p_child, offline p_child) | **${fmt(liveVsOffline.rho_live_offline_p)}** |
| ρ(live p_child, b) | ${fmt(liveVsOffline.rho_live_b)} |
| ρ(offline p_child, b) | ${fmt(liveVsOffline.rho_offline_b)} |

If offline h15 still beats HML on this set but live ρ is weak, the gap is **live/ATM context** (not the item sample). If offline also collapses, the original bake-off sample was optimistic.
`
      : '';

  const reportName = matched
    ? 'REPORT_swr_prompt_matched_offline.md'
    : args.source === 'bank'
      ? `REPORT_swr_prompt_bakeoff_bank${args.tag ? `_${args.tag}` : ''}.md`
      : 'REPORT_swr_prompt_bakeoff.md';
  const summaryName = matched
    ? 'swr_prompt_matched_offline_summary.json'
    : args.source === 'bank'
      ? `swr_prompt_bakeoff_bank${args.tag ? `_${args.tag}` : ''}_summary.json`
      : 'swr_prompt_bakeoff_summary.json';

  const report = `# SWR prompt ${matched ? 'matched offline diagnosis' : args.source === 'bank' ? 'bank bake-off (ceiling break)' : 'bake-off (offline)'}

**Date:** ${new Date().toISOString().slice(0, 10)}  
**Model:** \`${args.model}\` · **n words:** ${words.length} · **calls:** ${jobs.length}  
**Source:** ${matched ? `run \`${args.fromRun}\`` : args.source} · **variants:** ${args.variants.join(', ')}  
**Split:** 70/30 by word hash (seed=${args.seed}) · primary = **ρ(b_proxy, b) on test** · also **ceil%** (p≥0.99)

## Results

| Condition | n_test | ρ_test | ρ_all | ceil% | n_p | lex | parse |
|-----------|-------:|-------:|------:|------:|----:|----:|------:|
${ranked
  .map((r) => {
    const m = summary[r.id];
    return `| ${r.id} | ${m.n_test} | **${fmt(m.rho_b_proxy_test)}** | ${fmt(m.rho_b_proxy_all)} | ${fmt(m.frac_ceiling)} | ${m.n_unique_p ?? ''} | ${fmt(m.lex_acc)} | ${fmt(m.parse_rate)} |`;
  })
  .join('\n')}
${liveRow}

## Winner (offline conditions only)

**\`${winner.id}\`** — ρ_test≈**${fmt(winner.rho_test)}**, ceil=${fmt(winner.frac_ceiling)}, n_p=${winner.n_unique_p ?? ''}.
${liveBlock}
${
  winner.id.includes('hml_s')
    ? '**GO** — strict HML won; use for bank ranking / wire as `QA_SWR_PROMPT=v2strict`.'
    : winner.id.startsWith('h15')
      ? '**LEAN-GO** — HARDNESS 1-5 best on this bank draw; prefer over saturated HML for offline ranking.'
      : winner.id.includes('age_avg')
        ? 'Age-averaging helped — keep dual-age ensemble for bank ranking.'
        : '**ITERATE** — baseline HML still wins; tighten further or add features.'
}

CSV: \`out/${csvName}\`
`;

  writeFileSync(join(OUT, reportName), report);
  writeFileSync(
    join(OUT, summaryName),
    JSON.stringify({ summary, ranked, winner, liveVsOffline, args }, null, 2),
  );

  console.log(
    JSON.stringify(
      {
        winner: winner.id,
        rho_test: winner.rho_test,
        frac_ceiling: winner.frac_ceiling,
        report: `tools/vlm-panel/out/${reportName}`,
        csv: `tools/vlm-panel/out/${csvName}`,
        top: ranked.slice(0, 8).map((r) => ({
          id: r.id,
          rho_test: r.rho_test,
          rho_all: r.rho_all,
          ceil: r.frac_ceiling,
          n_p: r.n_unique_p,
        })),
      },
      null,
      2,
    ),
  );
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}