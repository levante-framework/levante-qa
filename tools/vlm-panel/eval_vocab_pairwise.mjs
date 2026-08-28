#!/usr/bin/env node
/**
 * Offline pairwise “which word is harder?” for English vocab.
 *
 * Hypothesis: YES|NO / percent-correct cannot split CEILING words (panel ~100%).
 * Comparative judgments might recover kids IRT order on that subset.
 *
 * Text-only (no 4-ups). Requires GEMINI_API_KEY.
 *
 *   node tools/vlm-panel/eval_vocab_pairwise.mjs
 *   node tools/vlm-panel/eval_vocab_pairwise.mjs --k 4 --concurrency 4
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { askGeminiText } from './aig_trog_lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
loadDotenv({ path: join(REPO, '.env') });

const OUT = join(HERE, 'out');
const EST_PATH = join(OUT, 'd_est_vocab_en.csv');
const BANK_PATH = join(HERE, 'corpora', 'vocab', 'vocab-item-bank-en-US.csv');

const SYSTEM = [
  'You help estimate picture-vocabulary difficulty for children.',
  'A child hears one English word and picks 1 of 4 pictures.',
  'Decide which of two words would be harder for a typical child of the given age.',
  'Harder = fewer children that age would know the word well enough to pick the right picture.',
  'Reply with only A or B.',
].join(' ');

function parseArg(argv, name, fallback) {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return fallback;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  const parseLine = (line) => {
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
  };
  const header = parseLine(lines[0]).map((h) => h.replace(/^\ufeff/, ''));
  return lines.slice(1).map((line) => {
    const parts = parseLine(line);
    const o = {};
    header.forEach((h, i) => {
      o[h] = parts[i] ?? '';
    });
    return o;
  });
}

function num(raw) {
  const s = String(raw ?? '').trim();
  if (!s || /^(na|nan|none|null)$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function aliases(uid, item) {
  const out = new Set();
  const add = (x) => {
    if (x) out.add(String(x).trim());
  };
  add(uid);
  add(item);
  const u = String(uid || '');
  add(u.replace(/^vocab__/, 'vocab_word_'));
  add(u.replace(/^vocab_word_/, 'vocab__'));
  return [...out];
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function spearman(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const rank = (a) => {
    const idx = a.map((v, i) => ({ v, i })).sort((x, y) => x.v - y.v);
    const r = new Array(n);
    for (let i = 0; i < n; ) {
      let j = i;
      while (j < n && idx[j].v === idx[i].v) j++;
      const avg = (i + j - 1) / 2;
      for (let k = i; k < j; k++) r[idx[k].i] = avg;
      i = j;
    }
    return r;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  for (let i = 0; i < n; i++) {
    const dx = rx[i] - mx;
    const dy = ry[i] - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const den = Math.sqrt(sxx * syy);
  return den ? sxy / den : null;
}

function fmt(x, d = 3) {
  return x == null || Number.isNaN(x) ? '—' : Number(x).toFixed(d);
}

function parseAB(raw) {
  const t = String(raw || '')
    .trim()
    .toUpperCase();
  const m = t.match(/\b([AB])\b/);
  return m ? m[1] : null;
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

function fitBradleyTerry(ids, comparisons, iters = 40) {
  const s = Object.fromEntries(ids.map((id) => [id, 0]));
  const W = Object.fromEntries(ids.map((id) => [id, 0]));
  const nPair = Object.fromEntries(ids.map((id) => [id, {}]));
  for (const c of comparisons) {
    if (!c.winner || !ids.includes(c.i) || !ids.includes(c.j)) continue;
    W[c.winner] += 1;
    nPair[c.i][c.j] = (nPair[c.i][c.j] || 0) + 1;
    nPair[c.j][c.i] = (nPair[c.j][c.i] || 0) + 1;
  }
  for (let iter = 0; iter < iters; iter++) {
    const next = {};
    for (const i of ids) {
      let den = 0;
      for (const [j, nij] of Object.entries(nPair[i])) {
        den += nij / (Math.exp(s[i]) + Math.exp(s[j]));
      }
      next[i] = Math.log(Math.max(W[i], 0.5) / Math.max(den, 1e-9));
    }
    const mean = ids.reduce((a, id) => a + next[id], 0) / ids.length;
    for (const id of ids) s[id] = next[id] - mean;
  }
  return s;
}

function loadItems() {
  if (!existsSync(EST_PATH)) throw new Error(`Missing ${EST_PATH}`);
  if (!existsSync(BANK_PATH)) throw new Error(`Missing ${BANK_PATH}`);
  const bankBy = new Map();
  for (const r of parseCsv(readFileSync(BANK_PATH, 'utf8'))) {
    const difficulty = num(r.difficulty);
    const rec = {
      item: String(r.item || '').trim(),
      difficulty: difficulty != null && Math.abs(difficulty) !== 5 ? difficulty : null,
    };
    for (const k of aliases(r.item_uid, r.item)) bankBy.set(k, rec);
  }
  const items = [];
  for (const r of parseCsv(readFileSync(EST_PATH, 'utf8'))) {
    if (r.flag === 'BROKEN') continue;
    let b = null;
    for (const k of aliases(r.item_uid, r.bank_uid)) {
      if (bankBy.has(k)) {
        b = bankBy.get(k);
        break;
      }
    }
    if (b?.difficulty == null) continue;
    const word = (b.item || r.transcript || '').replace(/^the\s+/i, '').trim();
    if (!word) continue;
    items.push({
      uid: r.item_uid,
      word,
      flag: r.flag || '',
      difficulty: b.difficulty,
      p_vlm: num(r.p_vlm),
      p_pred: num(r.p_pred_child),
      d_est_cv: num(r.d_est_cv),
    });
  }
  return items;
}

function samplePairs(items, { k, contrast, seed }) {
  const rand = rng(seed);
  const ceil = items.filter((x) => x.flag === 'CEILING');
  const hard = items.filter((x) => x.flag === 'HARD' || x.flag === 'OK');
  const seen = new Set();
  const pairs = [];
  const add = (a, b, kind) => {
    if (a.uid === b.uid) return;
    const key = [a.uid, b.uid].sort().join('|');
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push({ a, b, kind });
  };
  for (const a of ceil) {
    const others = ceil.filter((x) => x.uid !== a.uid);
    for (let t = others.length - 1; t > 0; t--) {
      const j = Math.floor(rand() * (t + 1));
      [others[t], others[j]] = [others[j], others[t]];
    }
    for (let i = 0; i < Math.min(k, others.length); i++) add(a, others[i], 'ceiling-ceiling');
  }
  for (let i = 0; i < contrast && ceil.length && hard.length; i++) {
    const a = ceil[Math.floor(rand() * ceil.length)];
    const b = hard[Math.floor(rand() * hard.length)];
    add(a, b, 'ceiling-contrast');
  }
  return pairs;
}

async function main() {
  const argv = process.argv;
  const k = Number(parseArg(argv, 'k', 4));
  const contrast = Number(parseArg(argv, 'contrast', 40));
  const concurrency = Number(parseArg(argv, 'concurrency', 4));
  const seed = Number(parseArg(argv, 'seed', 42));
  const age = Number(parseArg(argv, 'age', 8));
  const model = String(parseArg(argv, 'model', process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite'));
  const dry = argv.includes('--dry-run');

  if (!process.env.GEMINI_API_KEY && !dry) {
    console.error('GEMINI_API_KEY not set');
    process.exit(1);
  }

  const items = loadItems();
  const pairs = samplePairs(items, { k, contrast, seed });
  console.error(
    `Vocab pairwise: ${items.length} IRT words · ${pairs.length} pairs · age ${age} · ${model}`,
  );
  if (dry) {
    const nCeil = pairs.filter((p) => p.kind === 'ceiling-ceiling').length;
    console.log(JSON.stringify({ items: items.length, pairs: pairs.length, ceilingPairs: nCeil }));
    return;
  }

  mkdirSync(OUT, { recursive: true });
  let done = 0;
  const judged = await mapPool(pairs, concurrency, async (pair) => {
    const flip = (pair.a.uid.localeCompare(pair.b.uid) + seed) % 2 === 0;
    const left = flip ? pair.b : pair.a;
    const right = flip ? pair.a : pair.b;
    const user = [
      `Age: typical ${age}-year-old.`,
      'Which word is harder?',
      `A. ${left.word}`,
      `B. ${right.word}`,
    ].join('\n');
    let raw = '';
    let choice = null;
    for (let attempt = 0; attempt < 2 && !choice; attempt++) {
      raw = await askGeminiText({
        model,
        system: SYSTEM,
        user,
        temperature: 0,
        maxOutputTokens: 8,
      });
      choice = parseAB(raw);
    }
    const winnerUid = choice === 'A' ? left.uid : choice === 'B' ? right.uid : null;
    const irtHarder = pair.a.difficulty >= pair.b.difficulty ? pair.a.uid : pair.b.uid;
    done += 1;
    if (done % 25 === 0 || done === pairs.length) console.error(`  progress ${done}/${pairs.length}`);
    return {
      kind: pair.kind,
      uid_a: pair.a.uid,
      word_a: pair.a.word,
      d_a: pair.a.difficulty,
      uid_b: pair.b.uid,
      word_b: pair.b.word,
      d_b: pair.b.difficulty,
      left: left.word,
      right: right.word,
      raw,
      choice,
      winner: winnerUid,
      irt_agree: winnerUid ? winnerUid === irtHarder : null,
    };
  });

  const ok = judged.filter((r) => r.winner);
  const ids = [...new Set(ok.flatMap((r) => [r.uid_a, r.uid_b]))];
  const bt = fitBradleyTerry(
    ids,
    ok.map((r) => ({ i: r.uid_a, j: r.uid_b, winner: r.winner })),
  );
  const byUid = Object.fromEntries(items.map((x) => [x.uid, x]));

  const scoreRows = ids.map((uid) => {
    const it = byUid[uid];
    return {
      item_uid: uid,
      word: it.word,
      flag: it.flag,
      difficulty: it.difficulty,
      bt: bt[uid],
      p_vlm: it.p_vlm,
      p_pred: it.p_pred,
      d_est_cv: it.d_est_cv,
    };
  });

  function rhoOn(filter, predFn) {
    const xs = [];
    const ys = [];
    for (const r of scoreRows) {
      if (!filter(r)) continue;
      const p = predFn(r);
      if (p == null || r.difficulty == null) continue;
      xs.push(p);
      ys.push(r.difficulty);
    }
    return { n: xs.length, rho: spearman(xs, ys) };
  }

  const pairAcc = (kind) => {
    const rows = judged.filter((r) => (kind ? r.kind === kind : true) && r.irt_agree != null);
    const n = rows.length;
    const hit = rows.filter((r) => r.irt_agree).length;
    return { n, acc: n ? hit / n : null };
  };

  const metrics = {
    generated: new Date().toISOString(),
    model,
    age,
    k,
    n_pairs: judged.length,
    n_parsed: ok.length,
    pair_acc_all: pairAcc(),
    pair_acc_ceiling: pairAcc('ceiling-ceiling'),
    pair_acc_contrast: pairAcc('ceiling-contrast'),
    rho_bt_all: rhoOn(() => true, (r) => r.bt),
    rho_bt_ceiling: rhoOn((r) => r.flag === 'CEILING', (r) => r.bt),
    rho_neg_pvlm_ceiling: rhoOn((r) => r.flag === 'CEILING', (r) => -r.p_vlm),
    rho_neg_ppred_ceiling: rhoOn((r) => r.flag === 'CEILING', (r) => -r.p_pred),
    rho_dest_ceiling: rhoOn((r) => r.flag === 'CEILING', (r) => r.d_est_cv),
    rho_bt_all_vs_ppred: rhoOn(() => true, (r) => -r.p_pred),
  };

  const pairCsv = [
    'kind,uid_a,word_a,d_a,uid_b,word_b,d_b,left,right,choice,winner,irt_agree,raw',
    ...judged.map((r) =>
      [
        r.kind,
        r.uid_a,
        r.word_a,
        r.d_a,
        r.uid_b,
        r.word_b,
        r.d_b,
        r.left,
        r.right,
        r.choice ?? '',
        r.winner ?? '',
        r.irt_agree == null ? '' : r.irt_agree,
        JSON.stringify(r.raw),
      ].join(','),
    ),
  ].join('\n');
  const scoreCsv = [
    'item_uid,word,flag,difficulty,bt,p_vlm,p_pred,d_est_cv',
    ...scoreRows.map((r) =>
      [r.item_uid, r.word, r.flag, r.difficulty, r.bt, r.p_vlm, r.p_pred, r.d_est_cv].join(','),
    ),
  ].join('\n');

  const report = [
    '# Vocab pairwise “which is harder?” (text-only)',
    '',
    `Generated: ${metrics.generated}`,
    `Model: \`${model}\` · age ${age} · k=${k} · pairs ${metrics.n_pairs} (parsed ${metrics.n_parsed})`,
    '',
    'Ask the model which of two words is harder for a typical child, then turn wins into a Bradley–Terry score (`bt`; higher = harder). No pictures — words only.',
    '',
    '| Check | n | Value |',
    '|-------|--:|------:|',
    `| Pair acc (all) | ${metrics.pair_acc_all.n} | ${fmt(metrics.pair_acc_all.acc)} |`,
    `| Pair acc (ceiling–ceiling) | ${metrics.pair_acc_ceiling.n} | ${fmt(metrics.pair_acc_ceiling.acc)} |`,
    `| Pair acc (ceiling vs HARD/OK) | ${metrics.pair_acc_contrast.n} | ${fmt(metrics.pair_acc_contrast.acc)} |`,
    `| ρ(\`bt\`, kids IRT) all | ${metrics.rho_bt_all.n} | **${fmt(metrics.rho_bt_all.rho)}** |`,
    `| ρ(\`bt\`, kids IRT) CEILING | ${metrics.rho_bt_ceiling.n} | **${fmt(metrics.rho_bt_ceiling.rho)}** |`,
    `| ρ(\`−p_vlm\`, IRT) CEILING (old YES\\|NO) | ${metrics.rho_neg_pvlm_ceiling.n} | ${fmt(metrics.rho_neg_pvlm_ceiling.rho)} |`,
    `| ρ(\`−p_pred\`, IRT) CEILING | ${metrics.rho_neg_ppred_ceiling.n} | ${fmt(metrics.rho_neg_ppred_ceiling.rho)} |`,
    `| ρ(\`d_est_cv\`, IRT) CEILING | ${metrics.rho_dest_ceiling.n} | ${fmt(metrics.rho_dest_ceiling.rho)} |`,
    '',
    'Pair acc: 0.5 = coin flip, 1 = always picked the word kids find harder. ρ: 0 = no match, 1 = perfect order.',
    '',
    'Artifacts: `out/vocab_pairwise_en.csv`, `out/vocab_pairwise_en_scores.csv`, `out/vocab_pairwise_en_metrics.json`.',
    '',
  ].join('\n');

  writeFileSync(join(OUT, 'vocab_pairwise_en.csv'), `${pairCsv}\n`);
  writeFileSync(join(OUT, 'vocab_pairwise_en_scores.csv'), `${scoreCsv}\n`);
  writeFileSync(join(OUT, 'vocab_pairwise_en_metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
  writeFileSync(join(OUT, 'REPORT_vocab_pairwise_en.md'), report);
  console.log(report);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
