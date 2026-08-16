/**
 * Shared helpers for Spanish ROAR-PA (FSM/LSM) offline difficulty work.
 */
import { readFileSync, writeFileSync } from 'fs';

export const PA_ES_CORPUS =
  '/home/david/levante/roar-pa/src/experiment/config/corpus/es/test.csv';
export const PA_TRIALS =
  '/home/david/levante/levante-bench/data/responses/v2/tasks/pa_trials.csv';
export const BOGOTA_SITE = 'pilot_uniandes_co';
export const MIN_N = 100;
export const PA_CHANCE = 1 / 3;

export function parseCSV(text) {
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
  const hdr = split(lines[0]).map((h) => h.replace(/^"+|"+$/g, ''));
  return lines.slice(1).filter(Boolean).map((line) => {
    const cols = split(line);
    const o = {};
    hdr.forEach((h, i) => {
      o[h] = (cols[i] ?? '').replace(/^"+|"+$/g, '');
    });
    return o;
  });
}

export function logit(p) {
  const x = Math.min(1 - 1e-6, Math.max(1e-6, p));
  return Math.log(x / (1 - x));
}

/** IRT-style z from p, guessing-adjusted (PA is 3AFC). */
export function zFromP(p, c = PA_CHANCE) {
  const adj = Math.min(1 - 1e-3, Math.max(1e-3, (p - c) / (1 - c)));
  return logit(adj);
}

export function bFromP(p, c = PA_CHANCE) {
  return -zFromP(p, c);
}

export function spearman(xs, ys) {
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

export function foldWord(w) {
  return String(w || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

export function parseItemUid(uid) {
  const m = String(uid || '').toLowerCase().match(/^pa_(fsm|lsm|del)_(.+)$/);
  if (!m) return null;
  return { subtype: m[1], word: m[2] };
}

export function loadEsCorpus(path = PA_ES_CORPUS) {
  const rows = parseCSV(readFileSync(path, 'utf8')).filter(
    (r) => String(r.task || '').toLowerCase() === 'test',
  );
  return rows.map((r, i) => {
    const subtype = String(r.trial_type || '').toLowerCase();
    return {
      idx: i,
      subtype,
      stim: r.stim,
      goal: r.goal,
      foil1: r.foil1,
      foil2: r.foil2,
      trial_num: r.trial_num,
    };
  });
}

/** Join human item_uid (pa_{subtype}_{word}) to corpus row via goal, then stim. */
export function joinCorpus(humanWord, subtype, corpus) {
  const want = foldWord(humanWord);
  const type = String(subtype || '').toLowerCase();
  const pool = corpus.filter((c) => c.subtype === type);
  return (
    pool.find((c) => foldWord(c.goal) === want) ||
    pool.find((c) => foldWord(c.stim) === want) ||
    null
  );
}

export function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function writeCsv(path, rows, cols) {
  writeFileSync(
    path,
    [cols.join(','), ...rows.map((r) => cols.map((c) => csvEscape(r[c])).join(','))].join('\n') +
      '\n',
  );
}
