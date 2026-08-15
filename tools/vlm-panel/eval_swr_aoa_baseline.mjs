#!/usr/bin/env node
/**
 * Offline SWR baseline: Kuperman AoA (+ simple ortho) vs human bank `b`,
 * compared to matched prompt bake-off (v2 HML / v3 HARDNESS).
 *
 *   node tools/vlm-panel/eval_swr_aoa_baseline.mjs \
 *     [--from-run panel_swr_en_35flashlite_a6_r1_v3smoke2] \
 *     [--age 6]
 *
 * No Gemini calls. Uses tools/vlm-panel/data/aoa_kuperman.csv (Kuperman et al. 2012).
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const OUT = join(HERE, 'out');
const RUNS = join(REPO, 'cypress', 'logs', 'runs');
const BANK_EN = '/home/david/levante/roar-swr/src/wordlist/en/item_bank_v5.csv';
const AOA_PATH = join(HERE, 'data', 'aoa_kuperman.csv');
const MATCHED_CSV = join(OUT, 'swr_prompt_matched_offline.csv');

function parseArgs(argv) {
  const out = {
    fromRun: 'panel_swr_en_35flashlite_a6_r1_v3smoke2',
    age: 6,
    /** 'run' | 'langfix' */
    source: 'run',
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from-run') {
      out.fromRun = String(argv[++i] || '').trim();
      out.source = 'run';
    } else if (a === '--langfix') {
      out.source = 'langfix';
    } else if (a === '--age') out.age = Number(argv[++i]);
    else if (a === '--help') {
      console.log(
        'Usage: node tools/vlm-panel/eval_swr_aoa_baseline.mjs [--from-run RUN_ID | --langfix] [--age Y]',
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

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

/** Crude orthographic difficulty for pseudowords / missing AoA. */
function orthoHardness(word) {
  const w = String(word || '').toLowerCase();
  const len = w.length;
  const vowels = (w.match(/[aeiouy]/g) || []).length;
  const clusters = (w.match(/[bcdfghjklmnpqrstvwxz]{3,}/g) || []).length;
  // Higher = harder.
  return len * 0.35 + Math.max(0, len - vowels - 2) * 0.4 + clusters * 0.8;
}

function loadAoa() {
  if (!existsSync(AOA_PATH)) {
    throw new Error(`Missing AoA file: ${AOA_PATH}`);
  }
  const by = new Map();
  for (const r of parseCSV(readFileSync(AOA_PATH, 'utf8'))) {
    const w = String(r.word || r.Word || '')
      .trim()
      .toLowerCase();
    const aoa = parseFloat(r.aoa || r.AoA_Kup || r.AoA || '');
    if (!w || !Number.isFinite(aoa)) continue;
    by.set(w, aoa);
  }
  return by;
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
  return [...by.values()];
}

function loadRunWords(runId) {
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
    const row = by.get(key) || { word, n: 0 };
    row.n += 1;
    by.set(key, row);
  }
  return [...by.values()];
}

function loadMatchedPromptScores() {
  if (!existsSync(MATCHED_CSV)) return null;
  const rows = parseCSV(readFileSync(MATCHED_CSV, 'utf8'));
  /** condition -> Map(key -> pChild) */
  const byCond = new Map();
  for (const r of rows) {
    const cond = r.condition;
    const key = String(r.word || '')
      .replace(/^"|"$/g, '')
      .toLowerCase();
    const p = parseFloat(r.p_child);
    if (!cond || !key || !Number.isFinite(p)) continue;
    if (!byCond.has(cond)) byCond.set(cond, new Map());
    byCond.get(cond).set(key, p);
  }
  return byCond;
}

function metrics(label, pairs) {
  const xs = pairs.map((p) => p.x);
  const ys = pairs.map((p) => p.y);
  return {
    label,
    n: pairs.length,
    rho: spearman(xs, ys),
  };
}

function main() {
  const args = parseArgs(process.argv);
  const aoa = loadAoa();
  const bank = loadBank();
  const runWords =
    args.source === 'langfix' ? loadLangfixWords() : loadRunWords(args.fromRun);
  const age = args.age;
  const sourceLabel = args.source === 'langfix' ? 'langfix panel words' : args.fromRun;

  const items = [];
  for (const it of runWords) {
    const hum = bank.get(it.word.toLowerCase());
    if (!hum) continue;
    const key = it.word.toLowerCase();
    const aoaVal = aoa.has(key) ? aoa.get(key) : null;
    const ortho = orthoHardness(key);
    items.push({
      word: it.word,
      key,
      b: hum.b,
      rp: hum.rp,
      aoa: aoaVal,
      ortho,
      hasAoa: aoaVal != null,
    });
  }

  const realsWithAoa = items.filter((i) => i.rp === 'real' && i.hasAoa);
  const allWithAoa = items.filter((i) => i.hasAoa);

  // Predictors (higher x = harder expected → should correlate + with b)
  const mAoaReals = metrics(
    'aoa_reals',
    realsWithAoa.map((i) => ({ x: i.aoa, y: i.b })),
  );
  const mAoaAllHit = metrics(
    'aoa_any_hit',
    allWithAoa.map((i) => ({ x: i.aoa, y: i.b })),
  );
  const mOrthoAll = metrics(
    'ortho_all',
    items.map((i) => ({ x: i.ortho, y: i.b })),
  );

  // p_know at persona age → b_proxy = -z(p); higher b_proxy = harder
  const scale = 1.5; // years; soft threshold around AoA
  const knowPairs = [];
  const hybridPairs = [];
  for (const i of items) {
    let pKnow;
    if (i.hasAoa) {
      pKnow = sigmoid((age - i.aoa) / scale);
    } else {
      // Missing AoA (typical for pseudos): map ortho into ~[0.15, 0.85]
      const o = Math.min(8, Math.max(1, i.ortho));
      pKnow = 1 - (o - 1) / 7 * 0.7 - 0.15;
    }
    const bProxy = -zFromP(pKnow);
    knowPairs.push({ x: bProxy, y: i.b, pKnow, word: i.word });

    // Hybrid: reals with AoA use AoA; else ortho-as-difficulty
    const hard = i.hasAoa && i.rp === 'real' ? i.aoa : i.ortho;
    hybridPairs.push({ x: hard, y: i.b });
  }
  const mKnowProxy = metrics(`aoa_pknow_a${age}_bproxy`, knowPairs.map((p) => ({ x: p.x, y: p.y })));
  const mHybrid = metrics('hybrid_aoa_real_ortho_else', hybridPairs);

  // Prompt conditions from matched offline CSV (same words) — only for run mode.
  const promptByCond = args.source === 'run' ? loadMatchedPromptScores() : null;
  const promptMetrics = [];
  if (promptByCond) {
    for (const [cond, map] of promptByCond) {
      const pairs = [];
      for (const i of items) {
        const p = map.get(i.key);
        if (!Number.isFinite(p)) continue;
        pairs.push({ x: -zFromP(p), y: i.b });
      }
      promptMetrics.push(metrics(`prompt_${cond}`, pairs));
    }
    promptMetrics.sort((a, b) => (b.rho || -1) - (a.rho || -1));
  }

  const coverage = {
    n_items: items.length,
    n_real: items.filter((i) => i.rp === 'real').length,
    n_pseudo: items.filter((i) => i.rp === 'pseudo').length,
    aoa_hit_all: allWithAoa.length,
    aoa_hit_reals: realsWithAoa.length,
    aoa_hit_pseudos: items.filter((i) => i.rp === 'pseudo' && i.hasAoa).length,
  };

  const baselines = [mAoaReals, mAoaAllHit, mOrthoAll, mKnowProxy, mHybrid].sort(
    (a, b) => (b.rho || -1) - (a.rho || -1),
  );

  const outCsv = args.source === 'langfix' ? 'swr_aoa_baseline_langfix.csv' : 'swr_aoa_baseline.csv';
  const outReport =
    args.source === 'langfix' ? 'REPORT_swr_aoa_baseline_langfix.md' : 'REPORT_swr_aoa_baseline.md';
  const outSummary =
    args.source === 'langfix'
      ? 'swr_aoa_baseline_langfix_summary.json'
      : 'swr_aoa_baseline_summary.json';

  mkdirSync(OUT, { recursive: true });
  const rowCsv = [
    'word,rp,b,aoa,ortho,has_aoa,p_know,b_proxy_aoa',
    ...items.map((i) => {
      const pKnow = i.hasAoa
        ? sigmoid((age - i.aoa) / scale)
        : 1 - (Math.min(8, Math.max(1, i.ortho)) - 1) / 7 * 0.7 - 0.15;
      return [
        JSON.stringify(i.word),
        i.rp,
        i.b,
        i.aoa ?? '',
        i.ortho.toFixed(3),
        i.hasAoa ? 1 : 0,
        pKnow.toFixed(4),
        (-zFromP(pKnow)).toFixed(4),
      ].join(',');
    }),
  ].join('\n');
  writeFileSync(join(OUT, outCsv), rowCsv);

  const fmt = (x) => (Number.isFinite(x) ? x.toFixed(3) : 'n/a');
  const bestBase = baselines[0];
  const bestPrompt = promptMetrics[0] || null;

  const report = `# SWR AoA baseline (Kuperman) vs prompts

**Date:** ${new Date().toISOString().slice(0, 10)}  
**Words:** \`${sourceLabel}\` ∩ EN bank (\`n=${coverage.n_items}\`)  
**AoA:** \`tools/vlm-panel/data/aoa_kuperman.csv\` (Kuperman et al. 2012; local copy from levante-bench)  
**Persona age for p_know:** ${age}

## Coverage

| | n |
|--|--:|
| Items | ${coverage.n_items} |
| Real / pseudo | ${coverage.n_real} / ${coverage.n_pseudo} |
| AoA hit (all) | ${coverage.aoa_hit_all} |
| AoA hit (reals) | ${coverage.aoa_hit_reals} |
| AoA hit (pseudos) | ${coverage.aoa_hit_pseudos} |

## Baselines — ρ(predictor, human \`b\`)

Higher predictor = harder.

| Predictor | n | ρ |
|-----------|--:|--:|
${baselines.map((m) => `| ${m.label} | ${m.n} | **${fmt(m.rho)}** |`).join('\n')}

## Matched prompt conditions (same words)

| Condition | n | ρ(b_proxy, b) |
|-----------|--:|--:|
${
  promptMetrics.length
    ? promptMetrics.map((m) => `| ${m.label.replace(/^prompt_/, '')} | ${m.n} | **${fmt(m.rho)}** |`).join('\n')
    : '| *(no matched CSV / skipped)* | | |'
}

## Verdict

Best lexicon baseline: **\`${bestBase.label}\`** ρ≈**${fmt(bestBase.rho)}** (n=${bestBase.n}).  
${
  bestPrompt
    ? `Best prompt on same set: **\`${bestPrompt.label.replace(/^prompt_/, '')}\`** ρ≈**${fmt(bestPrompt.rho)}**.`
    : 'No prompt comparison CSV found.'
}

- AoA only applies cleanly to **real** words; pseudos need ortho / model judgment.
- If AoA ρ ≫ prompt ρ on reals, inject AoA into the prompt or post-hoc blend.
- If AoA ρ is weak even on reals, SWR \`b\` is mostly decoding — lexicon alone won't save age-6 ranking.

CSV: \`out/${outCsv}\`
`;

  writeFileSync(join(OUT, outReport), report);
  writeFileSync(
    join(OUT, outSummary),
    JSON.stringify(
      { coverage, baselines, promptMetrics, age, source: sourceLabel, fromRun: args.fromRun },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        coverage,
        bestBase,
        bestPrompt,
        baselines,
        promptTop: promptMetrics.slice(0, 4),
        report: `tools/vlm-panel/out/${outReport}`,
      },
      null,
      2,
    ),
  );
}

main();
