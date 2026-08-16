#!/usr/bin/env node
/**
 * Separate-track SWR ranking: reals keep AoA-blend b_proxy; pseudos get
 * VLM p + orthographic features (length, real-bank bigrams, neighborhood).
 *
 *   node tools/vlm-panel/eval_swr_pseudo_features.mjs
 *   node tools/vlm-panel/eval_swr_pseudo_features.mjs --csv out/swr_draft_rank_bank_hml_s_ageavg_full.csv
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');
const CSV_DEFAULT = join(OUT, 'swr_draft_rank_bank_hml_s_ageavg_full.csv');
const VOWELS = new Set('aeiouy');
const PSEUDO_KEYS = ['p', 'len', 'logBg', 'neigh', 'maxCluster', 'vowelRatio', 'doubles', 'startsV'];
const REAL_KEYS = ['bp'];
const RIDGE = 0.5;

function parseArgs(argv) {
  const out = { csv: CSV_DEFAULT, seed: 42, testFrac: 0.3 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--csv') out.csv = String(argv[++i] || CSV_DEFAULT);
    else if (a === '--seed') out.seed = Number(argv[++i]);
    else if (a === '--test-frac') out.testFrac = Number(argv[++i]);
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
  if (n < 3) return null;
  const rank = (arr) => {
    const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = Array(n);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j += 1;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  let sxy = 0;
  let sx = 0;
  let sy = 0;
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  for (let i = 0; i < n; i++) {
    const dx = rx[i] - mx;
    const dy = ry[i] - my;
    sxy += dx * dy;
    sx += dx * dx;
    sy += dy * dy;
  }
  return sx && sy ? sxy / Math.sqrt(sx * sy) : null;
}

function mae(xs, ys) {
  const n = xs.length;
  if (!n) return null;
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.abs(xs[i] - ys[i]);
  return s / n;
}

function hashWord(w, seed) {
  let h = seed >>> 0;
  const s = String(w);
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x9e3779b1) >>> 0;
  return h;
}

function lev1(a, b) {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    let d = 0;
    for (let i = 0; i < la; i++) if (a[i] !== b[i] && ++d > 1) return false;
    return d === 1;
  }
  const [s, l] = la < lb ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let d = 0;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if (++d > 1) return false;
    j += 1;
  }
  return true;
}

function buildLexicon(realWords) {
  const bg = new Map();
  let bgN = 0;
  for (const w of realWords) {
    const s = `^${w}$`;
    for (let i = 0; i < s.length - 1; i++) {
      const k = s.slice(i, i + 2);
      bg.set(k, (bg.get(k) || 0) + 1);
      bgN += 1;
    }
  }
  return { reals: realWords, bg, bgN: Math.max(1, bgN) };
}

function logBigram(w, lex) {
  const s = `^${w}$`;
  let ll = 0;
  let n = 0;
  for (let i = 0; i < s.length - 1; i++) {
    const c = lex.bg.get(s.slice(i, i + 2)) || 0.5;
    ll += Math.log(c / lex.bgN);
    n += 1;
  }
  return n ? ll / n : 0;
}

function neighCount(w, lex) {
  let n = 0;
  for (const r of lex.reals) {
    if (r === w) continue;
    if (Math.abs(r.length - w.length) > 1) continue;
    if (lev1(w, r)) n += 1;
  }
  return n;
}

function orthoFeats(word, lex) {
  const s = String(word || '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  const len = s.length;
  let vowels = 0;
  let maxCl = 0;
  let cl = 0;
  let doubles = 0;
  for (let i = 0; i < s.length; i++) {
    if (VOWELS.has(s[i])) {
      vowels += 1;
      cl = 0;
    } else {
      cl += 1;
      if (cl > maxCl) maxCl = cl;
    }
    if (i && s[i] === s[i - 1]) doubles += 1;
  }
  return {
    len,
    vowelRatio: len ? vowels / len : 0,
    maxCluster: maxCl,
    doubles,
    logBg: logBigram(s, lex),
    neigh: neighCount(s, lex),
    startsV: VOWELS.has(s[0]) ? 1 : 0,
  };
}

function getFeat(r, k) {
  if (k === 'p') return r.p;
  if (k === 'bp') return r.bp;
  if (k === 'bp0') return r.bp0;
  return r.f[k];
}

function zfit(trainX) {
  const p = trainX[0].length;
  const mu = [];
  const sd = [];
  for (let j = 0; j < p; j++) {
    const col = trainX.map((r) => r[j]);
    const m = col.reduce((a, b) => a + b, 0) / col.length;
    const v = col.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, col.length - 1);
    mu.push(m);
    sd.push(Math.sqrt(v) || 1);
  }
  return { mu, sd };
}

function zapply(X, zs) {
  return X.map((r) => r.map((v, j) => (v - zs.mu[j]) / zs.sd[j]));
}

function ridge(X, y, lambda) {
  const n = X.length;
  const p = X[0].length;
  const A = Array.from({ length: p + 1 }, () => Array(p + 1).fill(0));
  const b = Array(p + 1).fill(0);
  for (let i = 0; i < n; i++) {
    const xi = [1, ...X[i]];
    for (let j = 0; j <= p; j++) {
      b[j] += xi[j] * y[i];
      for (let k = 0; k <= p; k++) A[j][k] += xi[j] * xi[k];
    }
  }
  for (let j = 1; j <= p; j++) A[j][j] += lambda;
  return solve(A, b);
}

function solve(A, b) {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < n; i++) {
    let piv = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[piv][i])) piv = r;
    [M[i], M[piv]] = [M[piv], M[i]];
    const d = M[i][i] || 1e-12;
    for (let c = i; c <= n; c++) M[i][c] /= d;
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = M[r][i];
      for (let c = i; c <= n; c++) M[r][c] -= f * M[i][c];
    }
  }
  return M.map((r) => r[n]);
}

function pred(beta, x) {
  return beta[0] + x.reduce((s, v, i) => s + beta[i + 1] * v, 0);
}

function fitTrack(trainRows, keys) {
  const X0 = trainRows.map((r) => keys.map((k) => getFeat(r, k)));
  const zs = zfit(X0);
  const beta = ridge(zapply(X0, zs), trainRows.map((r) => r.b), RIDGE);
  return { keys, zs, beta };
}

function applyTrack(fit, r) {
  const x = zapply([fit.keys.map((k) => getFeat(r, k))], fit.zs)[0];
  return pred(fit.beta, x);
}

function metrics(subset, predOf) {
  const xs = subset.map(predOf);
  const ys = subset.map((r) => r.b);
  return { n: subset.length, rho: spearman(xs, ys), mae: mae(xs, ys) };
}

function fmt(x, d = 3) {
  return Number.isFinite(x) ? x.toFixed(d) : 'n/a';
}

const args = parseArgs(process.argv);
if (!existsSync(args.csv)) {
  console.error(`Missing ${args.csv}`);
  process.exit(1);
}

const raw = parseCSV(readFileSync(args.csv, 'utf8'))
  .map((r) => {
    const word = String(r.word || '').trim();
    const rp = String(r.rp || '').toLowerCase();
    const b = Number(r.b_human);
    const bp = Number(r.b_proxy);
    const bp0 = Number(r.b_proxy_no_aoa);
    const p = Number(r.p_avg);
    if (!word || !Number.isFinite(b) || !Number.isFinite(p)) return null;
    return {
      word,
      rp,
      b,
      p,
      bp: Number.isFinite(bp) ? bp : bp0,
      bp0: Number.isFinite(bp0) ? bp0 : bp,
      split: hashWord(word.toLowerCase(), args.seed) % 100 < args.testFrac * 100 ? 'test' : 'train',
    };
  })
  .filter(Boolean);

const lex = buildLexicon(
  raw.filter((r) => r.rp === 'real').map((r) => r.word.toLowerCase().replace(/[^a-z]/g, '')),
);
for (const r of raw) r.f = orthoFeats(r.word, lex);

const train = raw.filter((r) => r.split === 'train');
const test = raw.filter((r) => r.split === 'test');
const fitReal = fitTrack(train.filter((r) => r.rp === 'real'), REAL_KEYS);
const fitPseudo = fitTrack(train.filter((r) => r.rp === 'pseudo'), PSEUDO_KEYS);

const hat = (r) => (r.rp === 'real' ? applyTrack(fitReal, r) : applyTrack(fitPseudo, r));
const base = (r) => r.bp;

const slices = {
  all: test,
  real: test.filter((r) => r.rp === 'real'),
  pseudo: test.filter((r) => r.rp === 'pseudo'),
};

const uniKeys = ['len', 'logBg', 'neigh', 'maxCluster', 'vowelRatio', 'doubles', 'startsV'];
const uni = {};
for (const k of uniKeys) {
  uni[k] = {
    all: spearman(raw.map((r) => r.f[k]), raw.map((r) => r.b)),
    real: spearman(raw.filter((r) => r.rp === 'real').map((r) => r.f[k]), raw.filter((r) => r.rp === 'real').map((r) => r.b)),
    pseudo: spearman(raw.filter((r) => r.rp === 'pseudo').map((r) => r.f[k]), raw.filter((r) => r.rp === 'pseudo').map((r) => r.b)),
  };
}

const held = {
  baseline: {
    all: metrics(slices.all, base),
    real: metrics(slices.real, base),
    pseudo: metrics(slices.pseudo, base),
  },
  separate: {
    all: metrics(slices.all, hat),
    real: metrics(slices.real, hat),
    pseudo: metrics(slices.pseudo, hat),
  },
};

const liftP = (held.separate.pseudo.rho ?? 0) - (held.baseline.pseudo.rho ?? 0);
const liftA = (held.separate.all.rho ?? 0) - (held.baseline.all.rho ?? 0);
const verdict =
  liftP >= 0.08 && (held.separate.pseudo.rho ?? 0) >= 0.35
    ? '**LEAN-GO** separate-track for draft ranks (pseudo ρ up; do not write bank `b`).'
    : liftP > 0
      ? '**ITERATE** — small pseudo lift; keep as research overlay, not default export.'
      : '**NO-GO** — ortho features did not beat AoA-blend `b_proxy` on pseudos.';

const uniRows = uniKeys
  .map((k) => `| ${k} | ${fmt(uni[k].all)} | ${fmt(uni[k].real)} | ${fmt(uni[k].pseudo)} |`)
  .join('\n');

const report = `# SWR separate-track pseudo features

**Date:** ${new Date().toISOString().slice(0, 10)}  
**Source:** \`${args.csv.split('/').pop()}\` · n=${raw.length} · same hash split as \`eval_swr_b_proxy_calibrate.mjs\` (seed=${args.seed}, test≈${args.testFrac})

**Tracks:** real → ridge on AoA-blend \`b_proxy\`. Pseudo → ridge on VLM \`p_avg\` + ortho (len, real-bank bigram LL, edit-1 neighborhood, max consonant cluster, vowel ratio, doubles, starts-vowel). Lexicon = all EN bank reals (not labels).

## Univariate ρ vs human \`b\` (all data)

| Feat | all | real | pseudo |
|------|----:|-----:|-------:|
${uniRows}
| \`b_proxy\` | ${fmt(spearman(raw.map((r) => r.bp), raw.map((r) => r.b)))} | ${fmt(spearman(raw.filter((r) => r.rp === 'real').map((r) => r.bp), raw.filter((r) => r.rp === 'real').map((r) => r.b)))} | ${fmt(spearman(raw.filter((r) => r.rp === 'pseudo').map((r) => r.bp), raw.filter((r) => r.rp === 'pseudo').map((r) => r.b)))} |

## Held-out test

| Method | slice | n | ρ | MAE |
|--------|-------|--:|--:|----:|
| \`b_proxy\` (AoA blend) | all | ${held.baseline.all.n} | ${fmt(held.baseline.all.rho)} | ${fmt(held.baseline.all.mae)} |
| \`b_proxy\` (AoA blend) | real | ${held.baseline.real.n} | ${fmt(held.baseline.real.rho)} | ${fmt(held.baseline.real.mae)} |
| \`b_proxy\` (AoA blend) | pseudo | ${held.baseline.pseudo.n} | ${fmt(held.baseline.pseudo.rho)} | ${fmt(held.baseline.pseudo.mae)} |
| separate-track | all | ${held.separate.all.n} | **${fmt(held.separate.all.rho)}** | ${fmt(held.separate.all.mae)} |
| separate-track | real | ${held.separate.real.n} | ${fmt(held.separate.real.rho)} | ${fmt(held.separate.real.mae)} |
| separate-track | pseudo | ${held.separate.pseudo.n} | **${fmt(held.separate.pseudo.rho)}** | ${fmt(held.separate.pseudo.mae)} |

Δρ all **${fmt(liftA)}** · Δρ pseudo **${fmt(liftP)}**.

## Verdict

${verdict}

CSV: \`out/swr_pseudo_features_heldout.csv\`.
`;

const csvLines = [
  'word,rp,split,b_human,b_proxy,b_hat,len,logBg,neigh,maxCluster,vowelRatio,doubles,startsV,p_avg',
  ...raw.map((r) =>
    [
      r.word,
      r.rp,
      r.split,
      r.b.toFixed(4),
      r.bp.toFixed(4),
      hat(r).toFixed(4),
      r.f.len,
      r.f.logBg.toFixed(4),
      r.f.neigh,
      r.f.maxCluster,
      r.f.vowelRatio.toFixed(3),
      r.f.doubles,
      r.f.startsV,
      r.p.toFixed(4),
    ].join(','),
  ),
];

writeFileSync(join(OUT, 'REPORT_swr_pseudo_features.md'), report);
writeFileSync(join(OUT, 'swr_pseudo_features_heldout.csv'), `${csvLines.join('\n')}\n`);
writeFileSync(
  join(OUT, 'swr_pseudo_features_summary.json'),
  JSON.stringify({ held, uni, liftA, liftP, args, realKeys: REAL_KEYS, pseudoKeys: PSEUDO_KEYS }, null, 2),
);

console.log(
  JSON.stringify(
    {
      baseline_all: held.baseline.all,
      separate_all: held.separate.all,
      baseline_pseudo: held.baseline.pseudo,
      separate_pseudo: held.separate.pseudo,
      lift_all: liftA,
      lift_pseudo: liftP,
      report: 'tools/vlm-panel/out/REPORT_swr_pseudo_features.md',
    },
    null,
    2,
  ),
);
