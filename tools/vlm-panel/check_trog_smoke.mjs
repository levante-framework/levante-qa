#!/usr/bin/env node
/**
 * Regression check for the spatial/negation TROG smoke item set.
 *
 * Reads curated item_uids from trog_smoke_items.json and compares against
 * out/screen_en.csv (+ optional xlang review CSVs). Exit 1 on threshold fail.
 *
 *   node tools/vlm-panel/check_trog_smoke.mjs
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');
const SPEC = JSON.parse(readFileSync(join(HERE, 'trog_smoke_items.json'), 'utf8'));

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length) return [];
  const headers = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cols = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        q = !q;
        continue;
      }
      if (c === ',' && !q) {
        cols.push(cur);
        cur = '';
        continue;
      }
      cur += c;
    }
    cols.push(cur);
    const row = {};
    headers.forEach((h, i) => {
      row[h] = cols[i] ?? '';
    });
    return row;
  });
}

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function main() {
  const enPath = join(HERE, SPEC.en_screen);
  if (!existsSync(enPath)) {
    console.error(`Missing ${enPath}; run analyze first.`);
    process.exit(2);
  }
  const byUid = new Map(parseCsv(readFileSync(enPath, 'utf8')).map((r) => [r.item_uid, r]));
  const thr = SPEC.thresholds || {};
  const rows = [];
  let missing = 0;
  let absSum = 0;
  let absN = 0;
  let failItem = false;

  for (const it of SPEC.items) {
    const r = byUid.get(it.item_uid);
    if (!r) {
      missing += 1;
      rows.push({ item_uid: it.item_uid, status: 'MISSING', tags: (it.tags || []).join('+') });
      continue;
    }
    const pVlm = num(r.p_vlm);
    const pHuman = num(r.p_human);
    const pPred = num(r.p_pred_child);
    const absCal =
      pPred != null && pHuman != null ? Math.abs(pPred - pHuman) : null;
    if (absCal != null) {
      absSum += absCal;
      absN += 1;
      if (thr.en_item_abs_cal_max != null && absCal > thr.en_item_abs_cal_max) failItem = true;
    }
    rows.push({
      item_uid: it.item_uid,
      status: 'ok',
      tags: (it.tags || []).join('+'),
      p_vlm: pVlm,
      p_human: pHuman,
      p_pred_child: pPred,
      abs_cal: absCal,
      flag: r.flag,
      note: it.note || '',
    });
  }

  const mae = absN ? absSum / absN : null;
  const failMissing = thr.fail_on_missing_en && missing > 0;
  const failMae = thr.en_mae_cal_max != null && mae != null && mae > thr.en_mae_cal_max;
  const ok = !(failMissing || failMae || failItem);

  const report = {
    ok,
    mae_cal: mae,
    missing,
    n: SPEC.items.length,
    thresholds: thr,
    failMissing,
    failMae,
    failItem,
    rows,
  };

  const outJson = join(OUT, 'trog_smoke_report.json');
  const outMd = join(OUT, 'trog_smoke_report.md');
  writeFileSync(outJson, JSON.stringify(report, null, 2) + '\n');

  const md = [
    `# TROG smoke regression`,
    '',
    `- Status: **${ok ? 'PASS' : 'FAIL'}**`,
    `- Items: ${SPEC.items.length} (missing EN: ${missing})`,
    `- Mean |p_pred_child − p_human|: ${mae == null ? 'n/a' : mae.toFixed(3)} (max ${thr.en_mae_cal_max ?? '—'})`,
    '',
    '| item_uid | tags | |cal err| | p_vlm | p_human | p_pred | flag |',
    '|---|---|---:|---:|---:|---:|---|',
    ...rows.map((r) => {
      if (r.status === 'MISSING') return `| ${r.item_uid} | ${r.tags} | — | — | — | — | MISSING |`;
      return `| ${r.item_uid} | ${r.tags} | ${r.abs_cal?.toFixed(2) ?? '—'} | ${r.p_vlm?.toFixed(2) ?? '—'} | ${r.p_human?.toFixed(2) ?? '—'} | ${r.p_pred_child?.toFixed(2) ?? '—'} | ${r.flag} |`;
    }),
    '',
  ];
  writeFileSync(outMd, md.join('\n'));

  // Optional: note strong xlang deltas for smoke items when review files exist.
  for (const rel of SPEC.xlang_reviews || []) {
    const p = join(HERE, rel);
    if (!existsSync(p)) continue;
    const want = new Set(SPEC.items.map((i) => i.item_uid));
    const hits = parseCsv(readFileSync(p, 'utf8')).filter(
      (r) => want.has(r.item_uid) && String(r.strong_delta || '').toLowerCase() === 'yes',
    );
    console.log(`${rel}: ${hits.length} smoke item(s) with strong_delta=yes`);
    for (const h of hits) console.log(`  ${h.item_uid}`);
  }

  console.log(`Wrote ${outMd}`);
  console.log(`smoke ${ok ? 'PASS' : 'FAIL'} mae_cal=${mae?.toFixed(3) ?? 'n/a'} missing=${missing}`);
  process.exit(ok ? 0 : 1);
}

main();
