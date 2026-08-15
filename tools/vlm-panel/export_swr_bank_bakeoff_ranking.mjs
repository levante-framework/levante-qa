#!/usr/bin/env node
/**
 * Export bank bake-off rankings (age-avg ± AoA) after ceiling-break run.
 *   node tools/vlm-panel/export_swr_bank_bakeoff_ranking.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { lookupAoa, blendPChild, bProxyFromP } from './lib/aoa.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');
const CSV_DEFAULT = join(OUT, 'swr_prompt_bakeoff_bank_full.csv');

function parseArgs(argv) {
  let csv = CSV_DEFAULT;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--csv') csv = String(argv[++i] || CSV_DEFAULT);
  }
  return { csv };
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

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(path, rows, cols) {
  writeFileSync(
    path,
    [cols.join(','), ...rows.map((r) => cols.map((c) => csvEscape(r[c])).join(','))].join('\n') +
      '\n',
  );
}

function ageAvg(rows, variant) {
  const by = new Map();
  for (const r of rows) {
    if (r.variant !== variant) continue;
    const p = Number(r.p_child);
    if (!Number.isFinite(p)) continue;
    const k = String(r.word).toLowerCase();
    const row = by.get(k) || { word: r.word, rp: r.rp, b: Number(r.b), ps: [] };
    row.ps.push(p);
    by.set(k, row);
  }
  return [...by.values()]
    .map((r) => {
      const p_avg = r.ps.reduce((a, b) => a + b, 0) / r.ps.length;
      const aoa = lookupAoa(r.word);
      const p_blend = blendPChild({
        pVlm: p_avg,
        aoa,
        ageYears: 6,
        rp: r.rp,
        wAoa: 0.5,
      });
      const b_proxy = bProxyFromP(p_blend);
      const b_plain = bProxyFromP(p_avg);
      return {
        word: r.word,
        rp: r.rp,
        b_human: r.b,
        p_avg: +p_avg.toFixed(4),
        aoa: Number.isFinite(aoa) ? +aoa.toFixed(2) : '',
        p_blend: +p_blend.toFixed(4),
        b_proxy: +b_proxy.toFixed(4),
        b_proxy_no_aoa: +b_plain.toFixed(4),
        _bp: b_proxy,
        _bp0: b_plain,
        _bh: r.b,
        _pavg: p_avg,
      };
    })
    .sort((a, b) => a._bp - b._bp)
    .map((r, i) => ({ ...r, rank_proxy: i + 1 }));
}

const { csv: CSV } = parseArgs(process.argv);
if (!existsSync(CSV)) {
  console.error(`Missing ${CSV}`);
  process.exit(1);
}

const rows = parseCSV(readFileSync(CSV, 'utf8'));
const present = [...new Set(rows.map((r) => r.variant).filter(Boolean))];
const stats = {};
const outFiles = [];
for (const v of present) {
  const list = ageAvg(rows, v);
  if (!list.length) continue;
  stats[v] = {
    n: list.length,
    rho_aoa: spearman(
      list.map((r) => r._bp),
      list.map((r) => r._bh),
    ),
    rho_plain: spearman(
      list.map((r) => r._bp0),
      list.map((r) => r._bh),
    ),
    ceil: list.filter((r) => r._pavg >= 0.99).length / Math.max(1, list.length),
  };
  const outName = `swr_draft_rank_bank_${v}_ageavg_full.csv`;
  writeCsv(join(OUT, outName), list, [
    'rank_proxy',
    'word',
    'rp',
    'p_avg',
    'aoa',
    'p_blend',
    'b_proxy',
    'b_proxy_no_aoa',
    'b_human',
  ]);
  outFiles.push(outName);
}

const lines = Object.entries(stats).map(
  ([v, s]) =>
    `| ${v} | ${s.n} | ${s.rho_plain?.toFixed(3)} | ${s.rho_aoa?.toFixed(3)} | ${(s.ceil * 100).toFixed(1)}% |`,
);
const report = `# SWR full-bank ranking (\`hml_s\` age-avg)

**Date:** ${new Date().toISOString().slice(0, 10)}  
**Source:** \`${CSV.split('/').pop()}\` (offline text-only, no ATM / no browser)

## Age-avg ± AoA (w=0.5)

| Variant | n | ρ plain | ρ +AoA | ceil% |
|---------|--:|--------:|-------:|------:|
${lines.join('\n')}

CSVs: ${outFiles.map((f) => `\`${f}\``).join(', ')}

Prefer **plain** \`b_proxy_no_aoa\` / \`p_avg\` ranks when AoA does not improve ρ.
`;

writeFileSync(join(OUT, 'REPORT_swr_bank_ranking_full.md'), report);
console.log(
  JSON.stringify(
    { stats, outFiles, report: 'tools/vlm-panel/out/REPORT_swr_bank_ranking_full.md' },
    null,
    2,
  ),
);
