#!/usr/bin/env node
/**
 * Offline: does Kuperman age-of-acquisition (when kids typically learn a word)
 * sort English vocab better than Zipf on CEILING / blank words?
 *
 *   node tools/vlm-panel/eval_vocab_aoa.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookupAoa } from './lib/aoa.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');
const EST_PATH = join(OUT, 'd_est_vocab_en.csv');
const BANK_PATH = join(HERE, 'corpora', 'vocab', 'vocab-item-bank-en-US.csv');

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

function lookupWordAoa(word) {
  const w = String(word || '')
    .trim()
    .toLowerCase();
  if (!w) return { aoa: null, key: '' };
  const direct = lookupAoa(w);
  if (direct != null) return { aoa: direct, key: w };
  const last = w.split(/\s+/).pop();
  if (last && last !== w) {
    const hit = lookupAoa(last);
    if (hit != null) return { aoa: hit, key: last };
  }
  return { aoa: null, key: '' };
}

function loadRows() {
  const bankBy = new Map();
  for (const r of parseCsv(readFileSync(BANK_PATH, 'utf8'))) {
    const difficulty = num(r.difficulty);
    const rec = {
      item: String(r.item || '').trim(),
      d: num(r.d),
      difficulty: difficulty != null && Math.abs(difficulty) !== 5 ? difficulty : null,
      placeholder: difficulty != null && Math.abs(difficulty) === 5 ? difficulty : null,
    };
    for (const k of aliases(r.item_uid, r.item)) bankBy.set(k, rec);
  }
  const rows = [];
  for (const r of parseCsv(readFileSync(EST_PATH, 'utf8'))) {
    let b = null;
    for (const k of aliases(r.item_uid, r.bank_uid)) {
      if (bankBy.has(k)) {
        b = bankBy.get(k);
        break;
      }
    }
    const word = (b?.item || r.transcript || '').replace(/^the\s+/i, '').trim();
    const { aoa, key } = lookupWordAoa(word);
    rows.push({
      uid: r.item_uid,
      word,
      aoa,
      aoa_key: key,
      flag: r.flag || '',
      zipf: num(r.zipf),
      difficulty: b?.difficulty ?? null,
      d: b?.d ?? null,
      placeholder: b?.placeholder ?? null,
      p_pred: num(r.p_pred_child),
      d_est: num(r.d_est),
      d_est_cv: num(r.d_est_cv),
    });
  }
  return rows;
}

function rho(rows, predFn, truthFn = (r) => r.difficulty) {
  const xs = [];
  const ys = [];
  for (const r of rows) {
    const p = predFn(r);
    const t = truthFn(r);
    if (p == null || t == null) continue;
    xs.push(p);
    ys.push(t);
  }
  return { n: xs.length, rho: spearman(xs, ys) };
}

const rows = loadRows();
const withIrt = rows.filter((r) => r.flag !== 'BROKEN' && r.difficulty != null);
const ceil = withIrt.filter((r) => r.flag === 'CEILING');
const noIrt = rows.filter((r) => r.flag !== 'BROKEN' && r.difficulty == null);

const checks = [
  ['AoA vs IRT (all)', rho(withIrt, (r) => r.aoa)],
  ['Zipf vs IRT (all; −zipf = harder)', rho(withIrt, (r) => (r.zipf == null ? null : -r.zipf))],
  ['−p_pred vs IRT (all)', rho(withIrt, (r) => (r.p_pred == null ? null : -r.p_pred))],
  ['AoA vs IRT (CEILING)', rho(ceil, (r) => r.aoa)],
  ['Zipf vs IRT (CEILING)', rho(ceil, (r) => (r.zipf == null ? null : -r.zipf))],
  ['−p_pred vs IRT (CEILING)', rho(ceil, (r) => (r.p_pred == null ? null : -r.p_pred))],
  ['AoA vs Zipf (all with both)', rho(withIrt.filter((r) => r.aoa != null && r.zipf != null), (r) => r.aoa, (r) => -r.zipf)],
];

const aoaHit = rows.filter((r) => r.aoa != null).length;
const aoaHitIrt = withIrt.filter((r) => r.aoa != null).length;
const aoaHitCeil = ceil.filter((r) => r.aoa != null).length;
const aoaHitBlank = noIrt.filter((r) => r.aoa != null).length;

mkdirSync(OUT, { recursive: true });
const csv = [
  'item_uid,word,aoa,aoa_key,flag,zipf,difficulty,d,placeholder,p_pred,d_est',
  ...rows.map((r) =>
    [
      r.uid,
      r.word,
      r.aoa ?? '',
      r.aoa_key,
      r.flag,
      r.zipf ?? '',
      r.difficulty ?? '',
      r.d ?? '',
      r.placeholder ?? '',
      r.p_pred ?? '',
      r.d_est ?? '',
    ].join(','),
  ),
].join('\n');

const blankLines = noIrt
  .slice()
  .sort((a, b) => (b.aoa ?? -1) - (a.aoa ?? -1))
  .map(
    (r) =>
      `| ${r.word} | ${r.flag} | ${fmt(r.aoa, 2)} | ${fmt(r.zipf, 2)} | ${fmt(r.d_est, 2)} | ${r.placeholder ?? '—'} |`,
  );

const metrics = {
  generated: new Date().toISOString(),
  n: rows.length,
  aoa_hit: aoaHit,
  aoa_hit_irt: aoaHitIrt,
  aoa_hit_ceiling: aoaHitCeil,
  aoa_hit_no_irt: aoaHitBlank,
  checks: Object.fromEntries(checks.map(([k, v]) => [k, v])),
};

const report = [
  '# Vocab option (b) — Kuperman age-of-acquisition vs Zipf',
  '',
  `Generated: ${metrics.generated}`,
  '',
  '**Age of acquisition (AoA)** = typical age (years) when people say they learned the word (Kuperman 2012). Higher AoA ≈ learned later ≈ should be harder for kids. **Zipf** = how common the word is in adult text (higher = more common).',
  '',
  `Coverage: **${aoaHit}/${rows.length}** words hit Kuperman (${aoaHitIrt}/${withIrt.length} with kids IRT; ${aoaHitCeil}/${ceil.length} CEILING; **${aoaHitBlank}/${noIrt.length}** with no IRT).`,
  '',
  '| Check | n | ρ |',
  '|-------|--:|--:|',
  ...checks.map(([name, v]) => `| ${name} | ${v.n} | ${v.rho == null ? '—' : `**${fmt(v.rho)}**`} |`),
  '',
  'ρ: 0 = no match, 1 = perfect order. CEILING = panel always got the word right (YES|NO is flat).',
  '',
  '## Words with no kids IRT (the prior we would ship)',
  '',
  '| word | flag | AoA | Zipf | current `d_est` | placeholder |',
  '|------|------|----:|-----:|----------------:|-------------|',
  ...blankLines,
  '',
  'If AoA spreads these while `d_est` is stuck near −1.5, AoA is the missing sort key for new/easy words.',
  '',
  'Artifacts: `out/vocab_aoa_en.csv`, `out/vocab_aoa_en_metrics.json`.',
  '',
].join('\n');

writeFileSync(join(OUT, 'vocab_aoa_en.csv'), `${csv}\n`);
writeFileSync(join(OUT, 'vocab_aoa_en_metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
writeFileSync(join(OUT, 'REPORT_vocab_aoa_en.md'), report);
console.log(report);
