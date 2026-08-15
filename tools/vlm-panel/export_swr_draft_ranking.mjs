#!/usr/bin/env node
/**
 * Draft EN SWR rankings (eval-only — not for bank `b` writes).
 *
 *   node tools/vlm-panel/export_swr_draft_ranking.mjs
 *
 * Outputs:
 *   out/swr_draft_rank_v2full_a10.csv      — live age-10 v2full (no AoA)
 *   out/swr_draft_rank_dual_age_aoa.csv    — offline dual-age + AoA w=0.5
 *   out/swr_draft_rank_side_by_side.csv    — outer join on word
 *   out/REPORT_swr_draft_ranking.md
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { lookupAoa, blendPChild, bProxyFromP } from './lib/aoa.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const OUT = join(HERE, 'out');
const RUNS = join(REPO, 'cypress', 'logs', 'runs');
const BANK_EN = '/home/david/levante/roar-swr/src/wordlist/en/item_bank_v5.csv';
const DUAL_FRESH = join(OUT, 'swr_dual_age_fresh.csv');

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

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(path, rows, cols) {
  const lines = [cols.join(',')];
  for (const r of rows) {
    lines.push(cols.map((c) => csvEscape(r[c])).join(','));
  }
  writeFileSync(path, lines.join('\n') + '\n');
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

function loadBank(path) {
  const map = new Map();
  for (const r of parseCSV(readFileSync(path, 'utf8'))) {
    const w = String(r.Word || r.word || '')
      .trim()
      .toLowerCase();
    const b = Number(r.b);
    if (!w || !Number.isFinite(b)) continue;
    map.set(w, {
      b,
      rp: String(r.realpseudo || r.Realpseudo || '').toLowerCase(),
    });
  }
  return map;
}

function pChildFromRaw(rec) {
  if (Number.isFinite(rec.pChild)) return rec.pChild;
  const raw = String(rec.modelRaw || '');
  const m = raw.match(/\b(HIGH|MED|LOW)\b/i);
  if (!m) return null;
  const w = { high: 1, med: 0.5, low: 0.25 };
  return w[m[1].toLowerCase()] ?? null;
}

function loadLiveAge10() {
  const dirs = readdirSync(RUNS).filter((d) => /^panel_swr_en_.*_a10_.*_v2full$/.test(d));
  /** @type {Map<string, {word:string, pSum:number, pN:number, n:number, dirs:Set<string>}>} */
  const by = new Map();
  for (const runId of dirs) {
    const dir = join(RUNS, runId);
    const f = readdirSync(dir).find((x) => /^vlm_swr.*\.jsonl$/.test(x));
    if (!f) continue;
    for (const rec of readFileSync(join(dir, f), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))) {
      if (rec.itemType !== 'item') continue;
      const word = String(rec.promptText || '').trim();
      if (!word || word === '+' || /^[0-9]+$/.test(word)) continue;
      const key = word.toLowerCase();
      let row = by.get(key);
      if (!row) {
        row = { word, pSum: 0, pN: 0, n: 0, dirs: new Set() };
        by.set(key, row);
      }
      const pc = pChildFromRaw(rec);
      if (pc == null) continue;
      row.pSum += pc;
      row.pN += 1;
      row.n += 1;
      row.dirs.add(runId);
    }
  }
  return { dirs, items: [...by.values()] };
}

function fmt(n, d = 4) {
  return Number.isFinite(n) ? n.toFixed(d) : '';
}

function main() {
  mkdirSync(OUT, { recursive: true });
  const bank = loadBank(BANK_EN);
  const live = loadLiveAge10();

  const a10 = live.items
    .map((r) => {
      const hum = bank.get(r.word.toLowerCase());
      const p_child = r.pSum / r.pN;
      const b_proxy = bProxyFromP(p_child);
      return {
        word: r.word,
        rp: hum?.rp ?? '',
        n_obs: r.n,
        n_cells: r.dirs.size,
        p_child: fmt(p_child),
        b_proxy: fmt(b_proxy),
        b_human: hum && Number.isFinite(hum.b) ? fmt(hum.b) : '',
        rank_proxy: 0,
        source: 'v2full_a10_live',
        _p: p_child,
        _bp: b_proxy,
        _bh: hum?.b,
      };
    })
    .sort((a, b) => a._bp - b._bp);
  a10.forEach((r, i) => {
    r.rank_proxy = i + 1;
  });

  const a10Rho = spearman(
    a10.filter((r) => Number.isFinite(r._bh)).map((r) => r._bp),
    a10.filter((r) => Number.isFinite(r._bh)).map((r) => r._bh),
  );

  writeCsv(
    join(OUT, 'swr_draft_rank_v2full_a10.csv'),
    a10,
    ['rank_proxy', 'word', 'rp', 'n_obs', 'n_cells', 'p_child', 'b_proxy', 'b_human', 'source'],
  );

  if (!existsSync(DUAL_FRESH)) {
    throw new Error(`Missing ${DUAL_FRESH} — run eval_swr_dual_age_ensemble.mjs --fresh first`);
  }
  const dualRaw = parseCSV(readFileSync(DUAL_FRESH, 'utf8'));
  const dual = dualRaw
    .map((r) => {
      const word = String(r.word || '').trim();
      const key = word.toLowerCase();
      const hum = bank.get(key);
      const rp = String(r.rp || hum?.rp || '').toLowerCase();
      const p6 = Number(r.p6);
      const p10 = Number(r.p10);
      const p_avg = Number(r.p_avg);
      const pAvg = Number.isFinite(p_avg)
        ? p_avg
        : Number.isFinite(p6) && Number.isFinite(p10)
          ? (p6 + p10) / 2
          : null;
      const aoa = lookupAoa(word);
      const p_blend = blendPChild({
        pVlm: pAvg,
        aoa,
        ageYears: 6,
        rp,
        wAoa: 0.5,
      });
      const b_proxy = bProxyFromP(p_blend);
      const b_human = Number(r.b);
      return {
        word,
        rp,
        p6: fmt(p6),
        p10: fmt(p10),
        p_avg: fmt(pAvg),
        aoa: Number.isFinite(aoa) ? fmt(aoa, 2) : '',
        p_blend: fmt(p_blend),
        b_proxy: fmt(b_proxy),
        b_human: Number.isFinite(b_human) ? fmt(b_human) : hum && Number.isFinite(hum.b) ? fmt(hum.b) : '',
        rank_proxy: 0,
        source: 'dual_age_offline_aoa0.5',
        _bp: b_proxy,
        _bh: Number.isFinite(b_human) ? b_human : hum?.b,
      };
    })
    .filter((r) => Number.isFinite(r._bp))
    .sort((a, b) => a._bp - b._bp);
  dual.forEach((r, i) => {
    r.rank_proxy = i + 1;
  });

  const dualRho = spearman(
    dual.filter((r) => Number.isFinite(r._bh)).map((r) => r._bp),
    dual.filter((r) => Number.isFinite(r._bh)).map((r) => r._bh),
  );

  writeCsv(
    join(OUT, 'swr_draft_rank_dual_age_aoa.csv'),
    dual,
    ['rank_proxy', 'word', 'rp', 'p6', 'p10', 'p_avg', 'aoa', 'p_blend', 'b_proxy', 'b_human', 'source'],
  );

  const dualBy = new Map(dual.map((r) => [r.word.toLowerCase(), r]));
  const a10By = new Map(a10.map((r) => [r.word.toLowerCase(), r]));
  const keys = [...new Set([...a10By.keys(), ...dualBy.keys()])].sort();
  const side = keys.map((k) => {
    const a = a10By.get(k);
    const d = dualBy.get(k);
    const hum = bank.get(k);
    return {
      word: a?.word || d?.word || k,
      rp: a?.rp || d?.rp || hum?.rp || '',
      b_human: a?.b_human || d?.b_human || (hum && Number.isFinite(hum.b) ? fmt(hum.b) : ''),
      live_a10_rank: a?.rank_proxy ?? '',
      live_a10_b_proxy: a?.b_proxy ?? '',
      live_a10_p_child: a?.p_child ?? '',
      dual_aoa_rank: d?.rank_proxy ?? '',
      dual_aoa_b_proxy: d?.b_proxy ?? '',
      dual_aoa_p_blend: d?.p_blend ?? '',
      in_both: a && d ? 1 : 0,
    };
  });
  writeCsv(
    join(OUT, 'swr_draft_rank_side_by_side.csv'),
    side,
    [
      'word',
      'rp',
      'b_human',
      'live_a10_rank',
      'live_a10_b_proxy',
      'live_a10_p_child',
      'dual_aoa_rank',
      'dual_aoa_b_proxy',
      'dual_aoa_p_blend',
      'in_both',
    ],
  );

  const overlap = side.filter((r) => r.in_both === 1);
  const rankRho =
    overlap.length >= 3
      ? spearman(
          overlap.map((r) => Number(r.live_a10_rank)),
          overlap.map((r) => Number(r.dual_aoa_rank)),
        )
      : null;

  const report = `# SWR draft EN ranking export

**Date:** 2026-08-15  
**Purpose:** Draft **rank order** only — not calibrated ATM bank \`b\`.

## Artifacts

| File | What |
|------|------|
| \`out/swr_draft_rank_v2full_a10.csv\` | Live age-10 \`v2full\` (4 cells), **no AoA** |
| \`out/swr_draft_rank_dual_age_aoa.csv\` | Offline dual-age HML + AoA w=0.5 (\`swr_dual_age_fresh.csv\`) |
| \`out/swr_draft_rank_side_by_side.csv\` | Outer join on word |

## Metrics

| Source | n words | ρ(b_proxy, human b) |
|--------|--------:|--------------------:|
| Live age-10 \`v2full\` | ${a10.length} | ${a10Rho == null ? 'n/a' : a10Rho.toFixed(3)} |
| Offline dual-age+AoA | ${dual.length} | ${dualRho == null ? 'n/a' : dualRho.toFixed(3)} |
| Rank agreement (overlap) | ${overlap.length} | ρ(ranks)=${rankRho == null ? 'n/a' : rankRho.toFixed(3)} |

Live cells: ${live.dirs.sort().join(', ')}.

## Usage

- Prefer **dual-age+AoA** when you need one offline ranking list (higher ρ on langfix set).
- Prefer **live age-10** when ranking the ATM items actually seen in \`v2full\`.
- **Do not** write these \`b_proxy\` values into the bank without a held-out calibration step.
`;

  writeFileSync(join(OUT, 'REPORT_swr_draft_ranking.md'), report);
  console.log(
    JSON.stringify(
      {
        a10_n: a10.length,
        a10_rho: a10Rho,
        dual_n: dual.length,
        dual_rho: dualRho,
        overlap: overlap.length,
        rank_rho: rankRho,
        report: 'tools/vlm-panel/out/REPORT_swr_draft_ranking.md',
      },
      null,
      2,
    ),
  );
}

main();
