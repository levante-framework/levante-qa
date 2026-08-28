#!/usr/bin/env node
/**
 * Apply hybrid d_est as initial bank-d prior for items that lack established d.
 *
 * Policy:
 *   - Finite bank d (or difficulty) → preserve forever (never overwrite).
 *   - Blank / NaN d → fill from d_est when available, except:
 *       • screen flag BROKEN
 *       • UIDs listed in known_issues.json for this task
 *   - HARD/OK/CEILING blanks may still receive a prior.
 *
 * Does NOT upload to GCS. Writes a draft bank CSV + markdown report under out/.
 *
 * Usage:
 *   node tools/vlm-panel/apply_d_est_prior.mjs --task trog --lang en
 *   node tools/vlm-panel/apply_d_est_prior.mjs --task vocab --lang en \
 *     --bank cypress/cache/sim-item-bank-vocab.csv \
 *     --d-est out/d_est_vocab_en.csv
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catVocabD, vocabCorpusFile } from './vocab_bank_d.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const OUT_DIR = join(HERE, 'out');
const CACHE_DIR = join(REPO, 'cypress', 'cache');
const KNOWN_ISSUES_PATH = join(HERE, 'known_issues.json');

const TASK_CFG = {
  trog: {
    bankFile: 'sim-item-bank-trog.csv',
    dEstFile: (lang) => `d_est_trog_${lang}.csv`,
    /** Prefer writing filled values into bank column `d`. */
    fillColumn: 'd',
  },
  vocab: {
    bankFile: 'sim-item-bank-vocab.csv',
    bankPath: (lang) => join(HERE, 'corpora', 'vocab', vocabCorpusFile(lang)),
    dEstFile: (lang) => `d_est_vocab_${lang}.csv`,
    fillColumn: 'd',
  },
  stories: {
    bankFile: 'sim-item-bank-theory-of-mind.csv',
    dEstFile: (lang) => `d_est_stories_${lang}.csv`,
    /** ToM CAT bank uses `difficulty` (no `d` column). */
    fillColumn: 'difficulty',
  },
  matrix: {
    bankFile: 'sim-item-bank-matrix-reasoning.csv',
    dEstFile: (lang) => `d_est_matrix_${lang}.csv`,
    /** Matrix bank keeps numeric difficulty in `difficulty` (`d` column blank). */
    fillColumn: 'difficulty',
  },
};

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

function readCsvWithHeader(path) {
  const text = readFileSync(path, 'utf-8').replace(/^\uFEFF/, '');
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 1) return { header: [], rows: [] };
  const header = splitCsv(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const cols = splitCsv(line);
    const row = {};
    header.forEach((h, i) => {
      row[h] = cols[i] ?? '';
    });
    return row;
  });
  return { header, rows };
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeCsv(path, header, rows) {
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(header.map((h) => csvEscape(row[h] ?? '')).join(','));
  }
  writeFileSync(path, lines.join('\n') + '\n', 'utf-8');
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Established difficulty from bank row (trog/vocab use `d`; some CAT banks use `difficulty`). */
function establishedD(row, task) {
  if (task === 'vocab') return catVocabD(row);
  const dStr = String(row.d ?? '').trim() || String(row.difficulty ?? '').trim();
  if (!dStr || /^nan$/i.test(dStr) || dStr === 'NA' || dStr === 'None' || dStr === 'null') {
    return null;
  }
  return num(dStr);
}

function rowUid(row) {
  return String(row.item_uid || row.bank_uid || row.item_id || '').trim();
}

function isScoredBlankCandidate(row, task) {
  const answer = String(row.answer ?? '').trim();
  if (!answer) return false;
  const stage = String(row.assessment_stage || row.trial_type || '').toLowerCase();
  if (stage.includes('instruction')) return false;
  return establishedD(row, task) == null;
}

function loadKnownIssueUids(task) {
  if (!existsSync(KNOWN_ISSUES_PATH)) return new Map();
  try {
    const raw = JSON.parse(readFileSync(KNOWN_ISSUES_PATH, 'utf-8'));
    const block = raw?.[task];
    if (!block || typeof block !== 'object') return new Map();
    return new Map(
      Object.entries(block)
        .filter(([k]) => !k.startsWith('_'))
        .map(([uid, reason]) => [uid, String(reason ?? '')]),
    );
  } catch {
    return new Map();
  }
}

/** Skip priors when panel flag is BROKEN or UID is in known_issues.json. */
function skipPriorReason(uid, prior, knownIssues) {
  const flag = String(prior?.flag || '').trim().toUpperCase();
  if (flag === 'BROKEN' || flag.startsWith('BROKEN')) {
    return `screen flag=${prior.flag || 'BROKEN'}`;
  }
  if (knownIssues.has(uid)) {
    const why = knownIssues.get(uid);
    return `known_issues.json${why ? `: ${why}` : ''}`;
  }
  return null;
}

function fmt(n, d = 3) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(d);
}

function main() {
  const argv = process.argv.slice(2);
  const task = parseArg(argv, 'task', 'trog');
  const lang = parseArg(argv, 'lang', 'en');
  const cfg = TASK_CFG[task];
  if (!cfg) {
    console.error(`Unknown --task ${task} (supported: ${Object.keys(TASK_CFG).join(', ')})`);
    process.exit(1);
  }

  const bankPath = resolve(
    parseArg(
      argv,
      'bank',
      typeof cfg.bankPath === 'function' ? cfg.bankPath(lang) : join(CACHE_DIR, cfg.bankFile),
    ),
  );
  const dEstPath = resolve(parseArg(argv, 'd-est', join(OUT_DIR, cfg.dEstFile(lang))));

  if (!existsSync(bankPath)) {
    console.error(`Bank CSV not found: ${bankPath}`);
    process.exit(1);
  }
  if (!existsSync(dEstPath)) {
    console.error(`d_est CSV not found: ${dEstPath}`);
    process.exit(1);
  }

  const knownIssues = loadKnownIssueUids(task);
  const { header, rows } = readCsvWithHeader(bankPath);
  if (!header.includes(cfg.fillColumn) && !header.includes('difficulty')) {
    console.error(`Bank has neither '${cfg.fillColumn}' nor 'difficulty' columns`);
    process.exit(1);
  }
  const fillCol = header.includes(cfg.fillColumn) ? cfg.fillColumn : 'difficulty';

  const dEstRows = readCsvWithHeader(dEstPath).rows;
  const byUid = new Map();
  for (const r of dEstRows) {
    const dEst = num(r.d_est);
    if (dEst == null) continue;
    const prior = {
      d_est: dEst,
      p_pred_child: num(r.p_pred_child),
      p_vlm: num(r.p_vlm),
      flag: String(r.flag || '').trim(),
      transcript: String(r.transcript || '').trim(),
    };
    const uid = rowUid(r);
    const bankUid = String(r.bank_uid || '').trim();
    // Index panel item_uid and bank_uid (vocab: vocab_word_* vs vocab__*).
    if (uid) byUid.set(uid, prior);
    if (bankUid && bankUid !== uid) byUid.set(bankUid, prior);
  }

  let preserved = 0;
  let filled = 0;
  let blankNoMatch = 0;
  let blankNoAnswer = 0;
  let skippedBlocked = 0;
  const filledList = [];
  const skippedList = [];
  const unmatchedBlanks = [];

  const outRows = rows.map((row) => {
    const next = { ...row };
    const est = establishedD(row, task);
    if (est != null) {
      preserved += 1;
      return next;
    }

    const answer = String(row.answer ?? '').trim();
    if (!answer) {
      blankNoAnswer += 1;
      return next;
    }

    const uid = rowUid(row);
    const prior = uid ? byUid.get(uid) : null;
    if (!prior) {
      if (isScoredBlankCandidate(row, task)) {
        blankNoMatch += 1;
        unmatchedBlanks.push(uid || `(answer=${answer})`);
      }
      return next;
    }

    const skipWhy = skipPriorReason(uid, prior, knownIssues);
    if (skipWhy) {
      skippedBlocked += 1;
      skippedList.push({
        item_uid: uid,
        d_est: prior.d_est,
        p_pred_child: prior.p_pred_child,
        flag: prior.flag,
        reason: skipWhy,
        transcript: prior.transcript,
      });
      return next;
    }

    next[fillCol] = String(prior.d_est);
    filled += 1;
    filledList.push({
      item_uid: uid,
      answer,
      d_est: prior.d_est,
      p_pred_child: prior.p_pred_child,
      flag: prior.flag,
      transcript: prior.transcript,
    });
    return next;
  });

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const outBank = join(OUT_DIR, `item_bank_${task}_${lang}_d_est_prior.csv`);
  const outReport = join(OUT_DIR, `d_est_prior_report_${task}_${lang}.md`);
  writeCsv(outBank, header, outRows);

  const lines = [
    `# d_est prior apply — ${task} / ${lang}`,
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '## Policy',
    '',
    '- Established bank `d` (finite) is **never** overwritten.',
    '- Blank / NaN `d` is filled from hybrid `d_est` when a UID match exists.',
    '- **Skip** fill when screen `flag=BROKEN` or UID is in `known_issues.json` (leave blank).',
    '- This script does **not** upload to GCS; copy the draft CSV manually if promoting.',
    '',
    '## Inputs',
    '',
    `- Bank: \`${bankPath}\``,
    `- d_est: \`${dEstPath}\``,
    `- known_issues: \`${KNOWN_ISSUES_PATH}\` (${knownIssues.size} ${task} UID(s))`,
    `- Fill column: \`${fillCol}\``,
    '',
    '## Counts',
    '',
    `| Metric | n |`,
    `|--------|---|`,
    `| Bank rows | ${rows.length} |`,
    `| Preserved (established d) | ${preserved} |`,
    `| Filled from d_est | ${filled} |`,
    `| Skipped (BROKEN / known_issue) | ${skippedBlocked} |`,
    `| Blank scored, no d_est match | ${blankNoMatch} |`,
    `| Blank / non-scored (no answer) | ${blankNoAnswer} |`,
    '',
  ];

  if (filledList.length) {
    lines.push('## Filled items', '');
    lines.push('| item_uid | d_est | p_pred_child | flag | transcript |');
    lines.push('|----------|-------|--------------|------|------------|');
    for (const r of filledList) {
      const tr = (r.transcript || '').replace(/\|/g, '\\|').slice(0, 80);
      lines.push(
        `| ${r.item_uid} | ${fmt(r.d_est)} | ${fmt(r.p_pred_child)} | ${r.flag || ''} | ${tr} |`,
      );
    }
    lines.push('');
  }

  if (skippedList.length) {
    lines.push('## Skipped (left blank)', '');
    lines.push('| item_uid | d_est (unused) | flag | skip reason |');
    lines.push('|----------|----------------|------|-------------|');
    for (const r of skippedList) {
      const why = (r.reason || '').replace(/\|/g, '\\|').slice(0, 100);
      lines.push(
        `| ${r.item_uid} | ${fmt(r.d_est)} | ${r.flag || ''} | ${why} |`,
      );
    }
    lines.push('');
  }

  if (unmatchedBlanks.length) {
    lines.push('## Blank scored items without d_est', '');
    for (const u of unmatchedBlanks.slice(0, 50)) lines.push(`- ${u}`);
    if (unmatchedBlanks.length > 50) {
      lines.push(`- … and ${unmatchedBlanks.length - 50} more`);
    }
    lines.push('');
  }

  lines.push('## Outputs', '');
  lines.push(`- Draft bank: \`${outBank}\``);
  lines.push(`- This report: \`${outReport}\``);
  lines.push('');

  writeFileSync(outReport, lines.join('\n'), 'utf-8');

  console.log(
    `apply_d_est_prior ${task}/${lang}: preserved=${preserved} filled=${filled} ` +
      `skipped_blocked=${skippedBlocked} blank_no_match=${blankNoMatch}`,
  );
  console.log(`Wrote ${outBank}`);
  console.log(`Wrote ${outReport}`);

  // Operator signal: scored blanks exist but nothing could be filled from d_est.
  if (filled === 0 && blankNoMatch > 0 && skippedBlocked === 0) {
    console.error(
      `No fills applied but ${blankNoMatch} blank scored item(s) lack a d_est match. ` +
        `Run analyze + estimate_difficulty for those UIDs first.`,
    );
    process.exit(2);
  }
}

main();
