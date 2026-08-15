#!/usr/bin/env node
/**
 * Post-hoc blend: VLM p_child × Kuperman AoA p_know on reals.
 *
 *   node tools/vlm-panel/eval_swr_aoa_blend.mjs
 *
 * Reads out/swr_prompt_bakeoff.csv + out/swr_prompt_matched_offline.csv.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { lookupAoa, blendPChild, bProxyFromP } from './lib/aoa.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');

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

function loadPromptCsv(path) {
  if (!existsSync(path)) return [];
  return parseCSV(readFileSync(path, 'utf8')).map((r) => ({
    condition: r.condition,
    variant: r.variant,
    age: Number(r.age),
    word: String(r.word || '').replace(/^"|"$/g, ''),
    rp: String(r.rp || '').toLowerCase(),
    b: parseFloat(r.b),
    pChild: parseFloat(r.p_child),
  }));
}

function evalBlend(rows, wAoa) {
  const pairs = [];
  let nBlended = 0;
  for (const r of rows) {
    if (!Number.isFinite(r.pChild) || !Number.isFinite(r.b) || !Number.isFinite(r.age)) continue;
    const aoa = lookupAoa(r.word);
    const p = blendPChild({
      pVlm: r.pChild,
      aoa,
      ageYears: r.age,
      rp: r.rp,
      wAoa,
    });
    if (!Number.isFinite(p)) continue;
    if (r.rp === 'real' && Number.isFinite(aoa) && wAoa > 0) nBlended += 1;
    pairs.push({ x: bProxyFromP(p), y: r.b });
  }
  return {
    n: pairs.length,
    nBlended,
    rho: spearman(
      pairs.map((p) => p.x),
      pairs.map((p) => p.y),
    ),
  };
}

function sweepDataset(name, rows) {
  const byCond = new Map();
  for (const r of rows) {
    if (!byCond.has(r.condition)) byCond.set(r.condition, []);
    byCond.get(r.condition).push(r);
  }
  const weights = [0, 0.25, 0.5, 0.75, 1];
  const out = [];
  for (const [cond, rs] of byCond) {
    const age = rs[0]?.age;
    for (const w of weights) {
      const m = evalBlend(rs, w);
      out.push({ dataset: name, condition: cond, age, wAoa: w, ...m });
    }
  }
  return out;
}

function main() {
  const bakeoff = loadPromptCsv(join(OUT, 'swr_prompt_bakeoff.csv'));
  const matched = loadPromptCsv(join(OUT, 'swr_prompt_matched_offline.csv'));
  const results = [
    ...sweepDataset('bakeoff', bakeoff),
    ...sweepDataset('matched_v3smoke2', matched),
  ];

  // Per dataset×condition, pick best w by ρ
  const bestBy = new Map();
  for (const r of results) {
    const k = `${r.dataset}::${r.condition}`;
    const prev = bestBy.get(k);
    if (!prev || (r.rho || -1) > (prev.rho || -1)) bestBy.set(k, r);
  }
  const bests = [...bestBy.values()].sort((a, b) => (b.rho || -1) - (a.rho || -1));

  mkdirSync(OUT, { recursive: true });
  const fmt = (x) => (Number.isFinite(x) ? x.toFixed(3) : 'n/a');

  const table = (dataset) => {
    const conds = [...new Set(results.filter((r) => r.dataset === dataset).map((r) => r.condition))];
    const header =
      '| Condition | w=0 (VLM) | w=0.25 | w=0.5 | w=0.75 | w=1 (AoA) | best w | best ρ |';
    const sep = '|-----------|----------:|-------:|------:|-------:|----------:|-------:|-------:|';
    const lines = conds.map((cond) => {
      const rows = results.filter((r) => r.dataset === dataset && r.condition === cond);
      const byW = Object.fromEntries(rows.map((r) => [r.wAoa, r]));
      const best = bestBy.get(`${dataset}::${cond}`);
      return `| ${cond} | ${fmt(byW[0]?.rho)} | ${fmt(byW[0.25]?.rho)} | ${fmt(byW[0.5]?.rho)} | ${fmt(byW[0.75]?.rho)} | ${fmt(byW[1]?.rho)} | ${best?.wAoa} | **${fmt(best?.rho)}** |`;
    });
    return [header, sep, ...lines].join('\n');
  };

  const overallBest = bests[0];
  const report = `# SWR AoA × VLM post-hoc blend

**Date:** ${new Date().toISOString().slice(0, 10)}  
**Method:** \`p = w·p_know(AoA, age) + (1−w)·p_vlm\` on **reals with AoA**; pseudos / misses stay VLM-only. Score = ρ(\`−z(p)\`, human \`b\`).

## Bake-off sample (stratified ~120 words)

${table('bakeoff')}

## Matched ATM \`v3smoke2\` (84 words)

${table('matched_v3smoke2')}

## Verdict

Top cell: **\`${overallBest.dataset} / ${overallBest.condition}\`** at w=**${overallBest.wAoa}** ρ≈**${fmt(overallBest.rho)}** (n=${overallBest.n}, blended=${overallBest.nBlended}).

- If best w>0 on bakeoff age-6/10 HML, ship **post-hoc blend** in \`d_est\` / eval (no live change needed for ranking).
- If w=0 wins everywhere on matched ATM, AoA still won’t fix that cell — use blend on broader pools.

JSON: \`out/swr_aoa_blend_summary.json\`
`;

  writeFileSync(join(OUT, 'REPORT_swr_aoa_blend.md'), report);
  writeFileSync(
    join(OUT, 'swr_aoa_blend_summary.json'),
    JSON.stringify({ results, bests, overallBest }, null, 2),
  );
  console.log(JSON.stringify({ overallBest, bests: bests.slice(0, 8), report: 'tools/vlm-panel/out/REPORT_swr_aoa_blend.md' }, null, 2));
}

main();
