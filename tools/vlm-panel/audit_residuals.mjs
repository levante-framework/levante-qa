#!/usr/bin/env node
/**
 * Residual audit: where ungated p_vlm disagrees with human p_correct.
 * Use after analyze.mjs (and preferably fit_bench_calibrator.mjs) to find
 * systematic prompt/input failure modes before rewriting personas.
 *
 * Usage:
 *   node tools/vlm-panel/audit_residuals.mjs --task vocab
 *   node tools/vlm-panel/audit_residuals.mjs --task trog --top 20
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, 'out');

function parseArg(argv, name, fallback = null) {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return fallback;
}

function splitCsv(line) {
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
}

function readCsv(path) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf-8').trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = splitCsv(lines[0]);
  return lines.slice(1).map((line) => {
    const cols = splitCsv(line);
    const row = {};
    header.forEach((h, i) => {
      row[h] = cols[i] ?? '';
    });
    return row;
  });
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmt(x, d = 3) {
  if (x == null || Number.isNaN(x)) return '—';
  return Number(x).toFixed(d);
}

/** Construction / phenomenon tags from item_uid + transcript. */
export function tagResidual(itemUid, transcript) {
  const u = String(itemUid ?? '').toLowerCase();
  const t = String(transcript ?? '').toLowerCase();
  const tags = new Set();
  const rules = [
    ['negation', /xnot|neither|_not_|negation|\bnot\b|but not|no one|nobody/],
    ['relative_clause', /relative|embed|postmod|preploc|that the|who /],
    ['reverse_agent', /revactive|push|chase|follow/],
    ['spatial', /above|below|prep|in_|on_|under|beside/],
    ['comparative', /comparative|taller|longer|bigger|smaller/],
    ['adjective', /adjective|_tall|_big|_red|_blue/],
    ['passive', /passive/],
    ['temporal', /temporal|before|after|while /],
    ['disjunctive', /disjunctive|despite|although|however/],
    ['rare_vocab', /vocab_word_/],
  ];
  for (const [name, re] of rules) {
    if (re.test(u) || re.test(t)) tags.add(name);
  }
  if (!tags.size) tags.add('other');
  return [...tags];
}

function screenPath(task) {
  const tag = task === 'trog' ? '' : `_${task}`;
  return join(OUT_DIR, `screen${tag}_en.csv`);
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function main() {
  const task = parseArg(process.argv, 'task', 'trog');
  const topN = Number(parseArg(process.argv, 'top', '20'));
  const path = screenPath(task);
  if (!existsSync(path)) {
    console.error(`Missing ${path}. Run analyze.mjs --task ${task} first.`);
    process.exit(1);
  }

  const rows = readCsv(path);
  const pairs = [];
  for (const r of rows) {
    const pv = num(r.p_vlm);
    const ph = num(r.p_human);
    if (pv == null || ph == null) continue;
    const pp = num(r.p_pred_child);
    pairs.push({
      item_uid: r.item_uid,
      transcript: r.transcript,
      p_vlm: pv,
      p_human: ph,
      p_pred_child: pp,
      raw_err: pv - ph,
      abs_raw: Math.abs(pv - ph),
      cal_err: pp != null ? pp - ph : null,
      abs_cal: pp != null ? Math.abs(pp - ph) : null,
      tags: tagResidual(r.item_uid, r.transcript),
    });
  }

  if (!pairs.length) {
    console.error('No matched p_vlm/p_human rows.');
    process.exit(1);
  }

  pairs.sort((a, b) => b.abs_raw - a.abs_raw);
  const byTag = new Map();
  for (const p of pairs) {
    for (const tag of p.tags) {
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push(p);
    }
  }

  const md = [];
  md.push(`# Residual audit — ${task} / en`);
  md.push('');
  md.push(`Generated: ${new Date().toISOString()}`);
  md.push(`Source: \`${path}\``);
  md.push('');
  md.push('## Summary');
  md.push(`- Matched items: **${pairs.length}**`);
  md.push(`- Mean |p_vlm − p_human|: **${fmt(mean(pairs.map((p) => p.abs_raw)))}**`);
  md.push(`- Mean bias (vlm − human): **${fmt(mean(pairs.map((p) => p.raw_err)))}** (positive = VLM too easy)`);
  const withCal = pairs.filter((p) => p.abs_cal != null);
  if (withCal.length) {
    md.push(`- Mean |p_pred_child − p_human|: **${fmt(mean(withCal.map((p) => p.abs_cal)))}**`);
  }
  md.push('');
  md.push('## By construction tag (mean |raw err|)');
  md.push('| tag | n | mae_raw | bias_raw |');
  md.push('|---|---:|---:|---:|');
  const tagRows = [...byTag.entries()]
    .map(([tag, xs]) => ({
      tag,
      n: xs.length,
      mae: mean(xs.map((p) => p.abs_raw)),
      bias: mean(xs.map((p) => p.raw_err)),
    }))
    .sort((a, b) => b.mae - a.mae);
  for (const t of tagRows) {
    md.push(`| ${t.tag} | ${t.n} | ${fmt(t.mae)} | ${fmt(t.bias)} |`);
  }
  md.push('');
  md.push(`## Top ${topN} raw residuals`);
  md.push('| |err| | bias | p_vlm | p_human | item_uid | tags | transcript |');
  md.push('|---:|---:|---:|---:|---|---|---|');
  for (const p of pairs.slice(0, topN)) {
    const tr = String(p.transcript ?? '').replace(/\|/g, '/').slice(0, 50);
    md.push(
      `| ${fmt(p.abs_raw, 2)} | ${fmt(p.raw_err, 2)} | ${fmt(p.p_vlm, 2)} | ${fmt(p.p_human, 2)} | ${p.item_uid} | ${p.tags.join('+')} | ${tr} |`,
    );
  }
  md.push('');
  md.push('## Prompt / input guidance');
  if (task === 'trog') {
    md.push(
      '- High |err| on negation / reverse_agent / spatial / comparative → strengthen literal grammar checklist in `trogVlmAgent` SYSTEM_PROMPT.',
    );
    md.push(
      '- Negative bias (VLM harder than kids) is common on TROG — model misses structure kids get; not fixed by age persona.',
    );
  } else if (task === 'vocab') {
    md.push(
      '- Positive bias on rare words (VLM too easy) is adult lexical knowledge — calibration absorbs most; prompts only help for sense-ambiguity.',
    );
    md.push('- If report marks TOOL-failure INCONCLUSIVE, recollect the panel before trusting residual tags.');
  }
  md.push('');

  mkdirSync(OUT_DIR, { recursive: true });
  const outMd = join(OUT_DIR, `residuals_${task}.md`);
  writeFileSync(outMd, md.join('\n'), 'utf-8');

  // Machine-readable top residuals for CI / follow-ups
  writeFileSync(
    join(OUT_DIR, `residuals_${task}.json`),
    JSON.stringify(
      {
        task,
        n: pairs.length,
        maeRaw: mean(pairs.map((p) => p.abs_raw)),
        biasRaw: mean(pairs.map((p) => p.raw_err)),
        byTag: tagRows,
        top: pairs.slice(0, topN),
      },
      null,
      2,
    ) + '\n',
  );

  console.log(md.join('\n'));
  console.error(`Wrote ${outMd}`);
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) main();
