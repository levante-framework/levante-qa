#!/usr/bin/env node
/**
 * Eval-only SWR EN/DE difficulty report from raw panel jsonl (avoids screen CSV
 * unicode stripping). No roar-swr bank writes.
 *
 *   node tools/vlm-panel/eval_swr_b_est.mjs [--en-suffix langfix] [--aoa-blend 0.5] [--aoa-age 6]
 *
 * AoA blend (default w=0.5): on EN reals with Kuperman AoA, mix p_know(AoA,age)
 * into p_vlm before z / b_proxy. Pseudos unchanged. Use --aoa-blend 0 to disable.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { lookupAoa, blendPChild } from './lib/aoa.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');
const RUNS = join(HERE, '..', '..', 'cypress', 'logs', 'runs');
const BANK_EN = '/home/david/levante/roar-swr/src/wordlist/en/item_bank_v5.csv';
const BANK_DE = '/home/david/levante/roar-swr/src/wordlist/de/preliminary-item-bank_de.csv';
const RUN_RE = /^panel_swr_(en|de)_(35flashlite|36flash)_/;

function parseArgs(argv) {
  const out = { enSuffix: 'langfix', aoaBlend: 'auto', aoaAge: 6 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--en-suffix') out.enSuffix = String(argv[++i] || '').trim();
    else if (a === '--aoa-blend') out.aoaBlend = argv[++i];
    else if (a === '--aoa-age') out.aoaAge = Number(argv[++i]);
    else if (a === '--no-aoa-blend') out.aoaBlend = 0;
    else if (a === '--help') {
      console.log(
        'Usage: node tools/vlm-panel/eval_swr_b_est.mjs [--en-suffix SUFFIX] [--aoa-blend W|auto] [--aoa-age Y]',
      );
      process.exit(0);
    }
  }
  if (!Number.isFinite(out.aoaAge)) out.aoaAge = 6;
  return out;
}

function resolveAoaWeight(raw, items) {
  if (raw === 'auto' || raw == null || raw === '') {
    const nChild = items.filter((i) => i.p_source === 'pChild').length;
    // Only blend when graded v2/v3 pChild dominates (play-accuracy panels regress).
    return nChild >= Math.max(10, items.length * 0.5) ? 0.5 : 0;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0.5;
}
function parseCSV(text) {
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  function split(line) {
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
  }
  const hdr = split(lines[0]);
  return lines.slice(1).filter(Boolean).map((line) => {
    const cols = split(line);
    const o = {};
    hdr.forEach((h, i) => {
      o[h] = cols[i] ?? '';
    });
    delete o[''];
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

function pearson(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
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

function zFromP(p) {
  // Plain logit — soft pChild (0.25/0.5/1) must not use 2AFC chance-correction
  // (that clips all p≤0.5 to the same z).
  return logit(Math.min(1 - 1e-6, Math.max(1e-6, p)));
}

function toCsv(rows, cols) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

function loadBank(path) {
  const rows = parseCSV(readFileSync(path, 'utf8'));
  const by = new Map();
  for (const r of rows) {
    const w = String(r.word || '').trim();
    if (!w) continue;
    by.set(w.toLowerCase(), {
      word: w,
      a: parseFloat(r.a),
      b: parseFloat(r.b),
      c: parseFloat(r.c),
      d: parseFloat(r.d),
      realpseudo: r.realpseudo,
    });
  }
  return by;
}

function pChildFromRaw(rec) {
  if (rec.pChild != null && Number.isFinite(Number(rec.pChild))) return Number(rec.pChild);
  if (rec.confidence) {
    const c = String(rec.confidence).toLowerCase();
    if (c === 'high') return 1;
    if (c === 'med') return 0.5;
    if (c === 'low') return 0.25;
  }
  const text = String(rec.modelRaw || '').trim().toUpperCase();
  if (!text) return null;
  // v3 HARDNESS 1-5
  const hm = text.match(/\b([1-5])\b/);
  if (hm && (/\bREAL\b/.test(text) || /\bPSEUDO\b/.test(text))) {
    return (6 - Number(hm[1])) / 5;
  }
  // v2 HIGH|MED|LOW
  if (/\bHIGH\b/.test(text)) return 1;
  if (/\bMED\b/.test(text)) return 0.5;
  if (/\bLOW\b/.test(text)) return 0.25;
  return null;
}

function loadLangPanel(lang, { preferSuffix } = {}) {
  let dirs = readdirSync(RUNS).filter((d) => RUN_RE.test(d) && d.includes(`_swr_${lang}_`));
  if (preferSuffix) {
    const preferred = dirs.filter((d) => d.includes(`_${preferSuffix}`));
    if (preferred.length) dirs = preferred;
  }
  /** @type {Map<string, {word:string, correct:number, n:number, pChildSum:number, pChildN:number, respondents:Set<string>}>} */
  const byItem = new Map();
  for (const runId of dirs) {
    const dir = join(RUNS, runId);
    const f = readdirSync(dir).find((x) => /^vlm_swr.*\.jsonl$/.test(x));
    if (!f) continue;
    const lines = readFileSync(join(dir, f), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    for (const rec of lines) {
      if (rec.itemType !== 'item') continue;
      if (rec.chosenLr == null || rec.chosenLr === undefined) continue;
      const word = String(rec.promptText || '').trim();
      if (!word || word === '+' || /^[0-9]+$/.test(word)) continue;
      const key = word.toLowerCase();
      let row = byItem.get(key);
      if (!row) {
        row = {
          word,
          correct: 0,
          n: 0,
          pChildSum: 0,
          pChildN: 0,
          respondents: new Set(),
        };
        byItem.set(key, row);
      }
      row.n += 1;
      if (rec.correct) row.correct += 1;
      const pc = pChildFromRaw(rec);
      if (pc != null) {
        row.pChildSum += pc;
        row.pChildN += 1;
      }
      row.respondents.add(runId);
    }
  }
  const items = [...byItem.values()].map((r) => {
    const p_play = r.correct / r.n;
    const p_child = r.pChildN > 0 ? r.pChildSum / r.pChildN : null;
    // Prefer graded child-conf when present (v2/v3); else play accuracy (v1).
    const p_vlm = p_child != null ? p_child : p_play;
    const z = zFromP(p_vlm);
    return {
      word: r.word,
      key: r.word.toLowerCase(),
      n: r.n,
      n_resp_dirs: r.respondents.size,
      p_play,
      p_child,
      p_vlm,
      z,
      b_proxy: -z,
      p_source: p_child != null ? 'pChild' : 'play',
    };
  });
  items.sort((a, b) => a.b_proxy - b.b_proxy);
  return { dirs: dirs.length, runIds: dirs, items };
}

/** Apply Kuperman AoA blend on EN reals; returns new item list + stats. */
function applyAoaBlend(items, bank, { wAoa, ageYears }) {
  let nBlended = 0;
  let nRealAoa = 0;
  const out = items.map((it) => {
    const hum = bank.get(it.key);
    const rp = String(hum?.realpseudo || '').toLowerCase();
    const aoa = lookupAoa(it.word);
    if (rp === 'real' && Number.isFinite(aoa)) nRealAoa += 1;
    const p_raw = it.p_vlm;
    const p_blend = blendPChild({
      pVlm: p_raw,
      aoa,
      ageYears,
      rp,
      wAoa,
    });
    const p = Number.isFinite(p_blend) ? p_blend : p_raw;
    if (rp === 'real' && Number.isFinite(aoa) && wAoa > 0 && p !== p_raw) nBlended += 1;
    const z = zFromP(p);
    return {
      ...it,
      rp,
      aoa: Number.isFinite(aoa) ? aoa : null,
      p_raw,
      p_vlm: p,
      z,
      b_proxy: -z,
      blended: rp === 'real' && Number.isFinite(aoa) && wAoa > 0,
    };
  });
  out.sort((a, b) => a.b_proxy - b.b_proxy);
  return { items: out, nBlended, nRealAoa };
}

function looksGermanHeavy(items) {
  const sample = items.slice(0, 40).map((i) => i.word.toLowerCase());
  const deHints = [
    'der',
    'die',
    'und',
    'ich',
    'wie',
    'schlüssel',
    'gefühl',
    'fühlen',
    'garten',
    'nase',
    'geheimnis',
    'schmetterling',
    'wohnunge',
    'wohnung',
    'zwischen',
    'trampolin',
    'insel',
    'ast',
  ];
  const hits = sample.filter((w) => deHints.some((h) => w.includes(h) || h.includes(w))).length;
  const hasUmlaut = items.some((i) => /[äöüÄÖÜß]/.test(i.word));
  return { hits, hasUmlaut, sample: sample.slice(0, 12) };
}

mkdirSync(OUT, { recursive: true });
const args = parseArgs(process.argv);
const bankEn = loadBank(BANK_EN);
const bankDe = loadBank(BANK_DE);
const enSuffix = args.enSuffix;
const enRaw = loadLangPanel('en', { preferSuffix: enSuffix });
const de = loadLangPanel('de');
const aoaW = resolveAoaWeight(args.aoaBlend, enRaw.items);

const enBlend = applyAoaBlend(enRaw.items, bankEn, {
  wAoa: aoaW,
  ageYears: args.aoaAge,
});
const en = { ...enRaw, items: enBlend.items };
const enBase = {
  ...enRaw,
  items: applyAoaBlend(enRaw.items, bankEn, { wAoa: 0, ageYears: args.aoaAge }).items,
};

console.error(
  `EN runs: preferSuffix=${enSuffix || '(none)'} → ${en.dirs} dirs` +
    (en.runIds?.length ? ` (${en.runIds.slice(0, 3).join(', ')}${en.runIds.length > 3 ? '…' : ''})` : '') +
    ` · aoa-blend=${args.aoaBlend}→${aoaW} age=${args.aoaAge} blended=${enBlend.nBlended}/${enBlend.nRealAoa} reals-with-AoA` +
    ` · pChild items=${enRaw.items.filter((i) => i.p_source === 'pChild').length}/${enRaw.items.length}`,
);

const enLang = looksGermanHeavy(en.items);
const deLang = looksGermanHeavy(de.items);

function matchBank(items, bank) {
  const out = [];
  for (const it of items) {
    const hum = bank.get(it.key);
    if (!hum || !Number.isFinite(hum.b)) continue;
    out.push({ ...it, b_human: hum.b, realpseudo: hum.realpseudo });
  }
  return out;
}

const enToEn = matchBank(en.items, bankEn);
const enToEnBase = matchBank(enBase.items, bankEn);
const enToDe = matchBank(en.items, bankDe);
const deToDe = matchBank(de.items, bankDe);
const deToEn = matchBank(de.items, bankEn);

function fitAffine(matched) {
  const n = matched.length;
  if (n < 5) return null;
  // Only meaningful if human b has variance
  const bs = matched.map((m) => m.b_human);
  const bVar = bs.reduce((s, v) => s + (v - bs.reduce((a, b) => a + b, 0) / n) ** 2, 0) / n;
  if (bVar < 1e-6) {
    return { n, bVar, note: 'human b has no variance (placeholders)' };
  }
  const zs = matched.map((m) => m.z);
  const mz = zs.reduce((a, b) => a + b, 0) / n;
  const mb = bs.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (zs[i] - mz) * (bs[i] - mb);
    den += (zs[i] - mz) ** 2;
  }
  const beta = num / den;
  const alpha = mb - beta * mz;
  const withEst = matched.map((m) => ({ ...m, b_est: alpha + beta * m.z }));
  const resid = withEst.map((m) => m.b_est - m.b_human);
  return {
    n,
    bVar,
    alpha,
    beta,
    mae: resid.reduce((a, b) => a + Math.abs(b), 0) / n,
    rmse: Math.sqrt(resid.reduce((a, b) => a + b * b, 0) / n),
    rho: spearman(
      withEst.map((m) => m.b_est),
      withEst.map((m) => m.b_human),
    ),
    r: pearson(
      withEst.map((m) => m.b_est),
      withEst.map((m) => m.b_human),
    ),
    rhoProxy: spearman(
      withEst.map((m) => m.b_proxy),
      withEst.map((m) => m.b_human),
    ),
    rows: withEst,
  };
}

const fitEn = fitAffine(enToEn);
const fitEnBase = fitAffine(enToEnBase);
const fitDePlacebo = fitAffine(deToDe); // expect null/no variance

writeFileSync(
  join(OUT, 'b_est_swr_de_eval.csv'),
  toCsv(
    de.items.map((m) => {
      const hum = bankDe.get(m.key);
      return {
        word: m.word,
        in_de_bank: hum ? 1 : 0,
        n: m.n,
        p_vlm: m.p_vlm.toFixed(4),
        z: m.z.toFixed(4),
        b_proxy: m.b_proxy.toFixed(4),
        b_bank: hum && Number.isFinite(hum.b) ? hum.b : '',
      };
    }),
    ['word', 'in_de_bank', 'n', 'p_vlm', 'z', 'b_proxy', 'b_bank'],
  ),
);

writeFileSync(
  join(OUT, 'b_est_swr_en_eval.csv'),
  toCsv(
    en.items.map((m) => {
      const humEn = bankEn.get(m.key);
      const humDe = bankDe.get(m.key);
      return {
        word: m.word,
        in_en_bank: humEn ? 1 : 0,
        in_de_bank: humDe ? 1 : 0,
        n: m.n,
        p_source: m.p_source || '',
        p_raw: Number.isFinite(m.p_raw) ? m.p_raw.toFixed(4) : '',
        p_vlm: m.p_vlm.toFixed(4),
        aoa: Number.isFinite(m.aoa) ? m.aoa.toFixed(2) : '',
        blended: m.blended ? 1 : 0,
        z: m.z.toFixed(4),
        b_proxy: m.b_proxy.toFixed(4),
        b_en_bank: humEn && Number.isFinite(humEn.b) ? humEn.b : '',
      };
    }),
    [
      'word',
      'in_en_bank',
      'in_de_bank',
      'n',
      'p_source',
      'p_raw',
      'p_vlm',
      'aoa',
      'blended',
      'z',
      'b_proxy',
      'b_en_bank',
    ],
  ),
);

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const fmt = (m) => `${m.word} (b_proxy=${m.b_proxy.toFixed(2)}, p=${m.p_vlm.toFixed(2)}, n=${m.n})`;

const deEasy = de.items.slice(0, 10);
const deHard = de.items.slice(-10).reverse();
const enEasy = en.items.slice(0, 8);
const enHard = en.items.slice(-8).reverse();

const enOk = enToEn.length >= Math.max(20, Math.floor(en.items.length * 0.5));
const today = new Date().toISOString().slice(0, 10);

const report = `# SWR VLM difficulty eval (EN + DE) — no bank writes

**Date:** ${today}  
**Source:** raw \`cypress/logs/runs/panel_swr_{en|de}_*\` jsonl  
**EN filter:** \`--en-suffix ${enSuffix}\` → ${en.dirs} run dirs  
**PT/IT:** no matching variants (provision refuses silent DE fallback) · **ES:** mostly failed earlier

## Language check

| Panel → bank | Matches |
|--------------|--------:|
| EN panel → EN \`item_bank_v5\` | **${enToEn.length}** / ${en.items.length} |
| EN panel → DE preliminary bank | **${enToDe.length}** / ${en.items.length} |
| DE panel → DE preliminary bank | **${deToDe.length}** / ${de.items.length} |
| DE panel → EN \`item_bank_v5\` | **${deToEn.length}** / ${de.items.length} |

EN language sniff: umlauts=${enLang.hasUmlaut}, de-hint hits=${enLang.hits}, sample=${enLang.sample.join(', ')}

${
  enOk
    ? '**EN lexical content looks correct** after \`pickVariant\` fix (no \`lng\`/\`language\` Firekit inject).'
    : '**EN still does not join the English bank** — recheck provision/variant before trusting \`b_est\`.'
}

Also: \`analyze.mjs\` screen CSVs strip umlauts; this report uses raw jsonl.

## DE panel difficulty (usable ranking)

Respondents: **${de.dirs}** · unique items: **${de.items.length}** · matched DE bank: **${deToDe.length}**

Method: \`z = logit(clip((p_vlm−0.5)/0.5))\`, \`b_proxy = −z\` (higher = harder).  
DE bank \`b\` is uniformly 0 → **no human-IRT gold**; \`b_proxy\` is ranking-only.

| | mean | min | max |
|--|-----:|----:|----:|
| p_vlm | ${mean(de.items.map((i) => i.p_vlm)).toFixed(3)} | ${Math.min(...de.items.map((i) => i.p_vlm)).toFixed(3)} | ${Math.max(...de.items.map((i) => i.p_vlm)).toFixed(3)} |
| b_proxy | ${mean(de.items.map((i) => i.b_proxy)).toFixed(3)} | ${Math.min(...de.items.map((i) => i.b_proxy)).toFixed(3)} | ${Math.max(...de.items.map((i) => i.b_proxy)).toFixed(3)} |

CSV: \`out/b_est_swr_de_eval.csv\`

- Easiest: ${deEasy.map(fmt).join('; ')}
- Hardest: ${deHard.map(fmt).join('; ')}

DE bank human-\`b\` fit: ${
  fitDePlacebo?.note
    ? fitDePlacebo.note
    : fitDePlacebo
      ? `ρ=${fitDePlacebo.rho?.toFixed(3)} (unexpected variance)`
      : 'n/a'
}

## EN panel vs human EN \`b\`

Respondents: **${en.dirs}** · unique items: **${en.items.length}** · EN-bank matches with finite \`b\`: **${enToEn.length}**  
**AoA blend:** requested=\`${args.aoaBlend}\` → w=**${aoaW}** · age=**${args.aoaAge}** · reals blended **${enBlend.nBlended}** / ${enBlend.nRealAoa} with AoA  
**p source:** prefers jsonl \`pChild\` / parsed \`modelRaw\` (v2/v3) else play accuracy; \`auto\` blend only when ≥50% items have pChild

| | ρ(b_est,b) | ρ(b_proxy,b) | MAE | n |
|--|----------:|-------------:|----:|--:|
| No AoA blend | ${fitEnBase && Number.isFinite(fitEnBase.rho) ? fitEnBase.rho.toFixed(3) : 'n/a'} | ${fitEnBase && Number.isFinite(fitEnBase.rhoProxy) ? fitEnBase.rhoProxy.toFixed(3) : 'n/a'} | ${fitEnBase && Number.isFinite(fitEnBase.mae) ? fitEnBase.mae.toFixed(3) : 'n/a'} | ${fitEnBase?.n ?? 'n/a'} |
| AoA blend w=${aoaW} | ${fitEn && Number.isFinite(fitEn.rho) ? `**${fitEn.rho.toFixed(3)}**` : 'n/a'} | ${fitEn && Number.isFinite(fitEn.rhoProxy) ? `**${fitEn.rhoProxy.toFixed(3)}**` : 'n/a'} | ${fitEn && Number.isFinite(fitEn.mae) ? fitEn.mae.toFixed(3) : 'n/a'} | ${fitEn?.n ?? 'n/a'} |

Affine \`b_est = α + β z\` (blended): ${
  fitEn && Number.isFinite(fitEn.rho)
    ? `α=${fitEn.alpha.toFixed(3)}, β=${fitEn.beta.toFixed(3)}, r=${fitEn.r.toFixed(3)}, RMSE=${fitEn.rmse.toFixed(3)}`
    : fitEn?.note || '**not fitted**'
}

CSV: \`out/b_est_swr_en_eval.csv\`

- Easiest: ${enEasy.map(fmt).join('; ')}
- Hardest: ${enHard.map(fmt).join('; ')}

## Verdict

1. **DE:** usable VLM difficulty **ranking** (\`b_proxy\`) over ~${de.items.length} items; not calibrated \`b\` (bank \`b\`=0).  
2. **EN vs human \`b\`:** ${enOk && fitEn && Number.isFinite(fitEn.rho) ? `evaluable — blended Spearman ρ=${fitEn.rho.toFixed(3)} (baseline ${fitEnBase && Number.isFinite(fitEnBase.rho) ? fitEnBase.rho.toFixed(3) : 'n/a'}; n=${fitEn.n}).` : 'still blocked or underpowered — need more \`langfix\` EN cells.'}  
3. **AoA blend:** \`--aoa-blend auto\` (default) uses w=0.5 when graded pChild is present; else 0. Force with \`--aoa-blend 0.5\` / disable with \`0\`.  
4. **IT/PT:** blocked until real variants exist (no DE fallback).  
5. No bank files were modified.

## Fix notes

- Root cause of German EN cells: \`pickVariant\` fell back to registered DE when name/lang match was weak.  
- Injecting \`lng\`/\`language\` into Firekit assessment params broke \`updateTaskParams\` / startTask.  
- roar-swr defaults to English via \`defaultToEnglish\`; DE variants set \`language:"de"\`.
`;

writeFileSync(join(OUT, 'REPORT_swr_en_de_b_est_eval.md'), report);

console.log(
  JSON.stringify(
    {
      de_dirs: de.dirs,
      de_items: de.items.length,
      de_to_de_bank: deToDe.length,
      en_dirs: en.dirs,
      en_items: en.items.length,
      en_to_en_bank: enToEn.length,
      en_to_de_bank: enToDe.length,
      fitEn: fitEn && {
        n: fitEn.n,
        rho: fitEn.rho,
        rhoProxy: fitEn.rhoProxy,
        mae: fitEn.mae,
      },
      fitEnBase: fitEnBase && {
        n: fitEnBase.n,
        rho: fitEnBase.rho,
        rhoProxy: fitEnBase.rhoProxy,
        mae: fitEnBase.mae,
      },
      aoaBlend: {
        requested: args.aoaBlend,
        w: aoaW,
        age: args.aoaAge,
        nBlended: enBlend.nBlended,
        nRealAoa: enBlend.nRealAoa,
      },
      report: 'tools/vlm-panel/out/REPORT_swr_en_de_b_est_eval.md',
    },
    null,
    2,
  ),
);
