#!/usr/bin/env node
/**
 * Held-out linear calibration of SWR b_proxy → human b (full-bank hml_s ranking).
 *
 *   node tools/vlm-panel/eval_swr_b_proxy_calibrate.mjs
 *   node tools/vlm-panel/eval_swr_b_proxy_calibrate.mjs --csv out/swr_draft_rank_bank_hml_s_ageavg_full.csv
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');
const CSV_DEFAULT = join(OUT, 'swr_draft_rank_bank_hml_s_ageavg_full.csv');

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

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sx += dx * dx;
    sy += dy * dy;
  }
  return sx && sy ? sxy / Math.sqrt(sx * sy) : null;
}

function hashWord(w, seed) {
  let h = seed >>> 0;
  const s = String(w);
  for (let i = 0; i < s.length; i++) h = (Math.imul(h ^ s.charCodeAt(i), 0x9e3779b1) >>> 0);
  return h;
}

function fitLinear(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const slope = den ? num / den : 0;
  const intercept = my - slope * mx;
  return { slope, intercept };
}

function mae(xs, ys) {
  const n = xs.length;
  if (!n) return null;
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.abs(xs[i] - ys[i]);
  return s / n;
}

function rmse(xs, ys) {
  const n = xs.length;
  if (!n) return null;
  let s = 0;
  for (let i = 0; i < n; i++) s += (xs[i] - ys[i]) ** 2;
  return Math.sqrt(s / n);
}

function fmt(x, d = 3) {
  return Number.isFinite(x) ? x.toFixed(d) : 'n/a';
}

const args = parseArgs(process.argv);
if (!existsSync(args.csv)) {
  console.error(`Missing ${args.csv}`);
  process.exit(1);
}

const rows = parseCSV(readFileSync(args.csv, 'utf8'))
  .map((r) => {
    const word = String(r.word || '').trim();
    const rp = String(r.rp || '').toLowerCase();
    // Prefer AoA-blended b_proxy when present; also keep plain.
    const b_proxy = Number(r.b_proxy);
    const b_plain = Number(r.b_proxy_no_aoa);
    const b = Number(r.b_human);
    if (!word || !Number.isFinite(b_proxy) || !Number.isFinite(b)) return null;
    return {
      word,
      rp,
      b,
      b_proxy,
      b_plain: Number.isFinite(b_plain) ? b_plain : b_proxy,
      split: hashWord(word.toLowerCase(), args.seed) % 100 < args.testFrac * 100 ? 'test' : 'train',
    };
  })
  .filter(Boolean);

function evalProxy(label, getX) {
  const train = rows.filter((r) => r.split === 'train');
  const test = rows.filter((r) => r.split === 'test');
  const fit = fitLinear(
    train.map(getX),
    train.map((r) => r.b),
  );
  const predTrain = train.map((r) => fit.slope * getX(r) + fit.intercept);
  const predTest = test.map((r) => fit.slope * getX(r) + fit.intercept);
  const slice = (subset, pred) => {
    const reals = subset.filter((r) => r.rp === 'real');
    const pseudos = subset.filter((r) => r.rp === 'pseudo');
    const predOf = (arr) =>
      arr.map((r) => {
        const i = subset.indexOf(r);
        return pred[i];
      });
    // indexOf is O(n^2); rebuild with map instead
    return { reals, pseudos };
  };
  // rebuild preds keyed by word
  const predBy = new Map();
  train.forEach((r, i) => predBy.set(r.word, predTrain[i]));
  test.forEach((r, i) => predBy.set(r.word, predTest[i]));

  const metrics = (subset) => {
    const xs = subset.map(getX);
    const ys = subset.map((r) => r.b);
    const ps = subset.map((r) => predBy.get(r.word));
    return {
      n: subset.length,
      rho_proxy: spearman(xs, ys),
      r_proxy: pearson(xs, ys),
      rho_cal: spearman(ps, ys),
      mae_cal: mae(ps, ys),
      rmse_cal: rmse(ps, ys),
      mae_raw: mae(xs, ys),
    };
  };

  const all = rows;
  const out = {
    label,
    fit,
    all: metrics(all),
    train: metrics(train),
    test: metrics(test),
    test_real: metrics(test.filter((r) => r.rp === 'real')),
    test_pseudo: metrics(test.filter((r) => r.rp === 'pseudo')),
  };
  void slice;
  return out;
}

const blended = evalProxy('b_proxy (AoA blend)', (r) => r.b_proxy);
const plain = evalProxy('b_proxy_no_aoa (plain)', (r) => r.b_plain);

const best = (blended.test.mae_cal ?? 99) <= (plain.test.mae_cal ?? 99) ? blended : plain;

const report = `# SWR b_proxy → human b calibration

**Date:** ${new Date().toISOString().slice(0, 10)}  
**Source:** \`${args.csv.split('/').pop()}\` · n=${rows.length} · train/test by word hash (seed=${args.seed}, test≈${args.testFrac})

Linear map fit on **train**: \`b_hat = slope * b_proxy + intercept\`.

## Held-out test

| Proxy | n_test | ρ(proxy,b) | MAE raw | slope | intercept | ρ(cal,b) | **MAE cal** | RMSE cal |
|-------|-------:|-----------:|--------:|------:|----------:|---------:|------------:|---------:|
| AoA-blend | ${blended.test.n} | ${fmt(blended.test.rho_proxy)} | ${fmt(blended.test.mae_raw)} | ${fmt(blended.fit.slope, 4)} | ${fmt(blended.fit.intercept, 4)} | ${fmt(blended.test.rho_cal)} | **${fmt(blended.test.mae_cal)}** | ${fmt(blended.test.rmse_cal)} |
| Plain | ${plain.test.n} | ${fmt(plain.test.rho_proxy)} | ${fmt(plain.test.mae_raw)} | ${fmt(plain.fit.slope, 4)} | ${fmt(plain.fit.intercept, 4)} | ${fmt(plain.test.rho_cal)} | **${fmt(plain.test.mae_cal)}** | ${fmt(plain.test.rmse_cal)} |

## Test residuals by lexicality (${best.label})

| Slice | n | ρ(cal,b) | MAE cal |
|-------|--:|---------:|--------:|
| real | ${best.test_real.n} | ${fmt(best.test_real.rho_cal)} | ${fmt(best.test_real.mae_cal)} |
| pseudo | ${best.test_pseudo.n} | ${fmt(best.test_pseudo.rho_cal)} | ${fmt(best.test_pseudo.mae_cal)} |

## All-data (descriptive)

| Proxy | n | ρ(proxy,b) | MAE raw |
|-------|--:|-----------:|--------:|
| AoA-blend | ${blended.all.n} | ${fmt(blended.all.rho_proxy)} | ${fmt(blended.all.mae_raw)} |
| Plain | ${plain.all.n} | ${fmt(plain.all.rho_proxy)} | ${fmt(plain.all.mae_raw)} |

## Verdict

${
  (best.test.mae_cal ?? 99) < 0.75
    ? '**LEAN-GO** for draft calibrated ranks (test MAE < 0.75 on human `b` scale) — still review before bank writes.'
    : (best.test.mae_cal ?? 99) < 1.25
      ? '**ITERATE** — ranking OK but calibrated MAE is large for bank `b` replacement.'
      : '**NO-GO** for calibrated bank writes — MAE too large.'
}

Human EN \`b\` typically spans roughly −3…+5; interpret MAE on that scale.
`;

writeFileSync(join(OUT, 'REPORT_swr_b_proxy_calibrate.md'), report);
writeFileSync(
  join(OUT, 'swr_b_proxy_calibrate_summary.json'),
  JSON.stringify({ blended, plain, best: best.label, args }, null, 2),
);

console.log(
  JSON.stringify(
    {
      best: best.label,
      test_mae: best.test.mae_cal,
      test_rho: best.test.rho_cal,
      test_real_mae: best.test_real.mae_cal,
      test_pseudo_mae: best.test_pseudo.mae_cal,
      fit: best.fit,
      report: 'tools/vlm-panel/out/REPORT_swr_b_proxy_calibrate.md',
    },
    null,
    2,
  ),
);
