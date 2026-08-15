#!/usr/bin/env node
/**
 * Offline SWR prompt-v2 smoke: text-only Gemini vs human EN bank `b`.
 * No Cypress, no bank writes. Uses unique words from langfix panel jsonl.
 *
 *   node tools/vlm-panel/eval_swr_prompt_v2.mjs [--limit 40] [--age 8] [--model gemini-3.5-flash-lite]
 *
 * Requires GEMINI_API_KEY. Sets QA_SWR_PROMPT=v2 for prompt builders.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config as loadDotenv } from 'dotenv';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
loadDotenv({ path: join(REPO, '.env') });

process.env.QA_SWR_PROMPT = process.env.QA_SWR_PROMPT || 'v2';

// Prompt/parse kept in sync with cypress/support/agents/prompts/swrPrompts.ts (JS harness).
const SWR_CONFIDENCE_WEIGHT = { high: 1, med: 0.5, low: 0.25 };

function swrSystemPrompt(ageYears) {
  const ageLine =
    ageYears != null && Number.isFinite(ageYears)
      ? `Judge how a typical ${Math.round(ageYears)}-year-old child reader would do.`
      : 'Judge how a typical early-elementary child (about age 8) would do.';
  return [
    'You help estimate difficulty for SWR (Single Word Recognition).',
    'Each trial shows one letter string. Decide two things:',
    '  (1) REAL or PSEUDO — is this an English word? (common misspellings / nonsense = PSEUDO)',
    '  (2) HIGH, MED, or LOW — would a child at the age below usually get (1) correct?',
    '        HIGH = trivial for that age (very common short words / obvious nonsense)',
    '        MED  = doable but not automatic for that age (default when unsure)',
    '        LOW  = hard for that age (rare, long, academic, or subtle pseudowords)',
    'Do not default to HIGH. Use the full scale; many school-age items should be MED.',
    ageLine,
    'Look carefully at every letter. Short common words (cat, open, night) are REAL.',
    'Made-up letter strings (blans, youx, plissars) are PSEUDO.',
    'Reply with exactly two tokens, e.g. "REAL HIGH" or "PSEUDO MED" or "REAL LOW".',
    'No other words or punctuation.',
  ].join('\n');
}

function swrUserText(word, ageYears) {
  const age =
    ageYears != null && Number.isFinite(ageYears) ? `${Math.round(ageYears)}-year-old` : 'child';
  return `Reply with exactly two tokens: REAL or PSEUDO, then HIGH, MED, or LOW (would a typical ${age} correctly judge this string?). Example: "REAL HIGH" or "PSEUDO LOW". The letter string is: "${word}".`;
}

function parseSwrReply(raw) {
  const text = String(raw ?? '').trim().toUpperCase();
  let confidence = null;
  if (/\bHIGH\b/.test(text)) confidence = 'high';
  else if (/\bMED\b/.test(text)) confidence = 'med';
  else if (/\bLOW\b/.test(text)) confidence = 'low';
  let lexical = null;
  if (/\bREAL\b/.test(text)) lexical = 'real';
  else if (/\bPSEUDO\b/.test(text)) lexical = 'pseudo';
  else if (/\bRIGHT\b/.test(text)) lexical = 'real';
  else if (/\bLEFT\b/.test(text)) lexical = 'pseudo';
  return {
    lexical,
    confidence,
    pChild: confidence ? SWR_CONFIDENCE_WEIGHT[confidence] : null,
    raw: String(raw ?? ''),
  };
}

const OUT = join(HERE, 'out');
const RUNS = join(REPO, 'cypress', 'logs', 'runs');
const BANK_EN = '/home/david/levante/roar-swr/src/wordlist/en/item_bank_v5.csv';

function parseArgs(argv) {
  const out = { limit: 40, age: 8, model: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--age') out.age = Number(argv[++i]);
    else if (a === '--model') out.model = argv[++i];
    else if (a === '--help') {
      console.log('Usage: node tools/vlm-panel/eval_swr_prompt_v2.mjs [--limit N] [--age Y] [--model id]');
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

function loadBank(path) {
  const by = new Map();
  for (const r of parseCSV(readFileSync(path, 'utf8'))) {
    const w = String(r.word || '').trim().toLowerCase();
    if (!w) continue;
    const b = parseFloat(r.b);
    by.set(w, {
      word: r.word,
      b: Number.isFinite(b) ? b : NaN,
      realpseudo: String(r.realpseudo || '').toLowerCase(),
    });
  }
  return by;
}

function loadLangfixWords() {
  const dirs = readdirSync(RUNS).filter(
    (d) => /^panel_swr_en_/.test(d) && d.includes('_langfix') && !/_langfix\d/.test(d),
  );
  /** @type {Map<string, {word:string, n:number}>} */
  const by = new Map();
  for (const runId of dirs) {
    const dir = join(RUNS, runId);
    const f = readdirSync(dir).find((x) => /^vlm_swr.*\.jsonl$/.test(x));
    if (!f) continue;
    for (const line of readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean)) {
      const rec = JSON.parse(line);
      if (rec.itemType !== 'item') continue;
      const word = String(rec.promptText || '').trim();
      if (!word || word === '+') continue;
      const key = word.toLowerCase();
      const row = by.get(key) || { word, n: 0 };
      row.n += 1;
      by.set(key, row);
    }
  }
  return { dirs: dirs.length, items: [...by.values()] };
}

async function askGeminiText({ model, system, user }) {
  const { GoogleGenAI } = await import('@google/genai');
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');
  const client = new GoogleGenAI({ apiKey });
  const base = {
    model,
    contents: [{ text: user }],
    config: {
      systemInstruction: system,
      temperature: 0,
      maxOutputTokens: 16,
    },
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

async function main() {
  const args = parseArgs(process.argv);
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY not set (.env)');
    process.exit(1);
  }

  const bank = loadBank(BANK_EN);
  const panel = loadLangfixWords();
  const candidates = panel.items
    .map((it) => {
      const hum = bank.get(it.word.toLowerCase());
      if (!hum || !Number.isFinite(hum.b)) return null;
      return { word: it.word, key: it.word.toLowerCase(), n_panel: it.n, b: hum.b, rp: hum.realpseudo };
    })
    .filter(Boolean)
    // Prefer items seen more often in panel, then spread by |b|
    .sort((a, b) => b.n_panel - a.n_panel || Math.abs(b.b) - Math.abs(a.b));

  const sample = candidates.slice(0, Math.max(1, args.limit));
  console.error(
    `SWR prompt v2 offline: ${sample.length}/${candidates.length} words from ${panel.dirs} langfix dirs · age=${args.age} · model=${args.model}`,
  );

  const rows = [];
  let parseOk = 0;
  let lexOk = 0;
  for (let i = 0; i < sample.length; i++) {
    const it = sample[i];
    let raw = '';
    try {
      raw = await askGeminiText({
        model: args.model,
        system: swrSystemPrompt(args.age),
        user: swrUserText(it.word, args.age),
      });
    } catch (e) {
      console.error(`  [${i + 1}/${sample.length}] FAIL ${it.word}: ${e.message || e}`);
      rows.push({ ...it, raw: '', lexical: '', confidence: '', p_child: '', parse_ok: 0, lex_match: '' });
      continue;
    }
    const parsed = parseSwrReply(raw);
    const lexMatch =
      parsed.lexical && it.rp && (parsed.lexical === 'real' || parsed.lexical === 'pseudo')
        ? parsed.lexical === it.rp
          ? 1
          : 0
        : '';
    if (parsed.pChild != null) parseOk += 1;
    if (lexMatch === 1) lexOk += 1;
    if (lexMatch === 0) {
      /* count misses below */
    }
    rows.push({
      ...it,
      raw,
      lexical: parsed.lexical || '',
      confidence: parsed.confidence || '',
      p_child: parsed.pChild != null ? parsed.pChild : '',
      parse_ok: parsed.pChild != null ? 1 : 0,
      lex_match: lexMatch,
    });
    if ((i + 1) % 10 === 0 || i === sample.length - 1) {
      console.error(`  [${i + 1}/${sample.length}] last=${it.word} → ${JSON.stringify(raw)}`);
    }
  }

  const scored = rows.filter((r) => typeof r.p_child === 'number' || (r.p_child !== '' && Number.isFinite(+r.p_child)));
  const scoredN = scored.map((r) => ({
    ...r,
    p: typeof r.p_child === 'number' ? r.p_child : +r.p_child,
  }));
  for (const r of scoredN) {
    r.z = zFromP(r.p);
    r.b_proxy = -r.z;
  }

  const rhoP = spearman(
    scoredN.map((r) => r.p),
    scoredN.map((r) => r.b),
  );
  const rhoProxy = spearman(
    scoredN.map((r) => r.b_proxy),
    scoredN.map((r) => r.b),
  );
  const lexN = rows.filter((r) => r.lex_match === 0 || r.lex_match === 1).length;
  const lexHits = rows.filter((r) => r.lex_match === 1).length;

  mkdirSync(OUT, { recursive: true });
  const csvPath = join(OUT, 'swr_prompt_v2_offline.csv');
  const cols = ['word', 'rp', 'b', 'n_panel', 'lexical', 'confidence', 'p_child', 'b_proxy', 'lex_match', 'raw'];
  const csv = [
    cols.join(','),
    ...rows.map((r) => {
      const bp =
        r.p_child !== '' && Number.isFinite(+r.p_child) ? (-zFromP(+r.p_child)).toFixed(4) : '';
      return [
        JSON.stringify(r.word),
        r.rp,
        r.b,
        r.n_panel,
        r.lexical,
        r.confidence,
        r.p_child,
        bp,
        r.lex_match,
        JSON.stringify(r.raw),
      ].join(',');
    }),
  ].join('\n');
  writeFileSync(csvPath, csv);

  const confMix = { high: 0, med: 0, low: 0, none: 0 };
  for (const r of rows) {
    if (r.confidence === 'high' || r.confidence === 'med' || r.confidence === 'low') confMix[r.confidence] += 1;
    else confMix.none += 1;
  }

  const report = `# SWR prompt v2 offline smoke

**Date:** ${new Date().toISOString().slice(0, 10)}  
**Model:** \`${args.model}\` · **age:** ${args.age} · **n:** ${sample.length} (from ${panel.dirs} langfix dirs)  
**Prompt:** \`QA_SWR_PROMPT=v2\` (REAL|PSEUDO + HIGH|MED|LOW child-success)

## Metrics vs human EN \`b\`

| Signal | n | Spearman ρ |
|--------|--:|----------:|
| p_child vs b | ${scoredN.length} | **${Number.isFinite(rhoP) ? rhoP.toFixed(3) : 'n/a'}** |
| b_proxy (−z) vs b | ${scoredN.length} | **${Number.isFinite(rhoProxy) ? rhoProxy.toFixed(3) : 'n/a'}** |

Baseline live v1 (panel P(correct)): ρ(b_proxy,b) ≈ **−0.18** / ρ(p,b) ≈ **+0.20** (anti-signal).  
Target: ρ(p_child, b) **negative** and |ρ| ≫ 0.2 (harder items → lower child-success).

## Diagnostics

- Conf parse rate: **${parseOk}/${rows.length}**
- Lexicality vs bank real/pseudo: **${lexHits}/${lexN}** (${lexN ? ((100 * lexHits) / lexN).toFixed(1) : 'n/a'}%)
- Conf mix: HIGH ${confMix.high} · MED ${confMix.med} · LOW ${confMix.low} · none ${confMix.none}

CSV: \`out/swr_prompt_v2_offline.csv\`

## Verdict

${
  Number.isFinite(rhoP) && rhoP < -0.35
    ? '**LEAN-GO** — child-conf tracks human b better than v1 play accuracy; proceed to live \`QA_SWR_PROMPT=v2\` smoke.'
    : Number.isFinite(rhoP) && rhoP < -0.2
      ? '**WEAK-POSITIVE** — direction OK but small; try age mix / wording tweak before full panel.'
      : '**NO-GO / iterate** — prompt still not aligning with human b; inspect CSV conf mix + lexicality errors.'
}
`;

  const reportPath = join(OUT, 'REPORT_swr_prompt_v2_offline.md');
  writeFileSync(reportPath, report);
  console.log(
    JSON.stringify(
      {
        n: sample.length,
        scored: scoredN.length,
        rho_p_child_vs_b: rhoP,
        rho_b_proxy_vs_b: rhoProxy,
        lex_acc: lexN ? lexHits / lexN : null,
        conf_mix: confMix,
        csv: 'tools/vlm-panel/out/swr_prompt_v2_offline.csv',
        report: 'tools/vlm-panel/out/REPORT_swr_prompt_v2_offline.md',
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
