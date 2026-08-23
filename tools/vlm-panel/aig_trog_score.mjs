#!/usr/bin/env node
/**
 * Score generated TROG 4-ups with the frozen v4 checklist, then map
 * p_vlm → p_pred_child → hybrid d_est and compare to same-construction bank d.
 *
 *   node tools/vlm-panel/aig_trog_score.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCalibrator, predictChild } from './calibration.mjs';
import {
  CHANCE,
  OUT_DIR,
  SYSTEM_PROMPT_CHECKLIST,
  askGeminiVision,
  bankConstructionStats,
  destFromPred,
  ensureOut,
  loadFrozenDestCoefs,
  parseChoiceDigit,
  trogUserText,
} from './aig_trog_lib.mjs';

const CELLS = [
  { model: 'gemini-3.5-flash-lite', temperature: 0.5 },
  { model: 'gemini-3.5-flash-lite', temperature: 1.0 },
  { model: 'gemini-3.6-flash', temperature: 0.5 },
  { model: 'gemini-3.6-flash', temperature: 1.0 },
];

async function main() {
  ensureOut();
  const manifest = JSON.parse(readFileSync(join(OUT_DIR, 'images_manifest.json'), 'utf-8'));
  const cal = loadCalibrator('trog', 'en');
  const coefs = loadFrozenDestCoefs();
  const bank = bankConstructionStats();

  const rows = [];
  for (const item of manifest.items) {
    const quadPath = join(OUT_DIR, item.quad);
    const imageBuf = readFileSync(quadPath);
    const user =
      `${trogUserText(item.sentence)} The sentence is: "${item.sentence}".`;
    const picks = [];
    for (const cell of CELLS) {
      let raw = '';
      let digit = null;
      try {
        raw = await askGeminiVision({
          model: cell.model,
          system: SYSTEM_PROMPT_CHECKLIST,
          user,
          imageBuf,
          temperature: cell.temperature,
        });
        digit = parseChoiceDigit(raw);
      } catch (err) {
        raw = `ERROR: ${err.message}`;
      }
      picks.push({
        model: cell.model,
        temperature: cell.temperature,
        raw: String(raw).slice(0, 80),
        digit,
        correct: digit === item.correct_position,
      });
      console.log(
        `  ${item.item_uid} ${cell.model} t=${cell.temperature} → ${digit ?? '?'} ` +
          `(target ${item.correct_position})`,
      );
    }
    const scored = picks.filter((p) => p.digit != null);
    const nOk = scored.filter((p) => p.correct).length;
    const p_vlm = scored.length ? nOk / scored.length : null;
    const p_pred = p_vlm == null ? null : predictChild(cal?.model, p_vlm, CHANCE);
    const { z, d_est, tags } = destFromPred(item.item_uid, item.sentence, p_pred, coefs);
    const band = bank[item.construction];
    const inBand =
      d_est != null && band?.min != null && d_est >= band.min - 0.5 && d_est <= band.max + 0.5;
    rows.push({
      item_uid: item.item_uid,
      construction: item.construction,
      sentence: item.sentence,
      correct_position: item.correct_position,
      n_cells: scored.length,
      n_correct: nOk,
      p_vlm,
      p_pred_child: p_pred,
      z,
      d_est,
      tags,
      bank_d_min: band?.min ?? null,
      bank_d_max: band?.max ?? null,
      bank_d_mean: band?.mean ?? null,
      in_construction_band: inBand,
      ceiling: p_vlm != null && p_vlm >= 0.99,
      floor: p_vlm != null && p_vlm <= 0.01,
      picks,
    });
  }

  const summary = {
    generated: new Date().toISOString(),
    n_items: rows.length,
    n_ceiling: rows.filter((r) => r.ceiling).length,
    n_floor: rows.filter((r) => r.floor).length,
    n_in_band: rows.filter((r) => r.in_construction_band).length,
    mean_p_vlm: mean(rows.map((r) => r.p_vlm)),
    mean_d_est: mean(rows.map((r) => r.d_est)),
    bank,
    items: rows,
  };
  writeFileSync(join(OUT_DIR, 'score.json'), JSON.stringify(summary, null, 2) + '\n');
  const csv = [
    [
      'item_uid',
      'construction',
      'sentence',
      'p_vlm',
      'p_pred_child',
      'd_est',
      'bank_d_min',
      'bank_d_max',
      'in_band',
      'tags',
    ].join(','),
    ...rows.map((r) =>
      [
        r.item_uid,
        r.construction,
        `"${r.sentence.replace(/"/g, '""')}"`,
        fmt(r.p_vlm),
        fmt(r.p_pred_child),
        fmt(r.d_est),
        fmt(r.bank_d_min),
        fmt(r.bank_d_max),
        r.in_construction_band ? 'yes' : 'no',
        r.tags.join('+'),
      ].join(','),
    ),
  ].join('\n');
  writeFileSync(join(OUT_DIR, 'score.csv'), csv + '\n');
  console.log(
    `Scored ${rows.length}: mean p_vlm=${fmt(summary.mean_p_vlm)} ` +
      `in-band ${summary.n_in_band}/${rows.length} → ${join(OUT_DIR, 'score.json')}`,
  );
}

function mean(xs) {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function fmt(x) {
  return Number.isFinite(x) ? x.toFixed(3) : '';
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
