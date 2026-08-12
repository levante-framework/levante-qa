#!/usr/bin/env node
/**
 * Build age-binned PA accuracy + RT norms for the timed_child agent from
 * levante-bench pa_trials.csv.
 *
 * Usage:
 *   node scripts/build_pa_timed_child_norms.mjs
 *   LEVANTE_BENCH_DIR=/path/to/levante-bench node scripts/build_pa_timed_child_norms.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const BENCH =
  process.env.LEVANTE_BENCH_DIR ||
  path.resolve(REPO, '..', 'levante-bench');
const CSV = path.join(BENCH, 'data', 'responses', 'v2', 'tasks', 'pa_trials.csv');
const OUT = path.join(REPO, 'cypress', 'support', 'persona', 'pa_timed_child_norms.json');

const RT_MIN = 200;
const RT_MAX = 60_000;

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function main() {
  if (!fs.existsSync(CSV)) {
    throw new Error(`pa_trials.csv not found at ${CSV} (set LEVANTE_BENCH_DIR)`);
  }
  const text = fs.readFileSync(CSV, 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error('pa_trials.csv is empty');
  const header = parseCsvLine(lines[0]);
  const iAge = header.indexOf('age');
  const iCorrect = header.indexOf('correct');
  const iRt = header.indexOf('rt_numeric') >= 0 ? header.indexOf('rt_numeric') : header.indexOf('rt');
  if (iAge < 0 || iCorrect < 0 || iRt < 0) {
    throw new Error(`missing columns age/correct/rt in ${CSV}: ${header.join(',')}`);
  }

  /** @type {Map<number, { correct: number, n: number, rts: number[] }>} */
  const byAge = new Map();
  for (let li = 1; li < lines.length; li++) {
    const cols = parseCsvLine(lines[li]);
    const age = Number(cols[iAge]);
    if (!Number.isFinite(age) || age < 3 || age > 18) continue;
    const ageKey = Math.round(age);
    const correctRaw = String(cols[iCorrect] ?? '').trim().toLowerCase();
    const correct =
      correctRaw === '1' || correctRaw === 'true' || correctRaw === 'yes'
        ? 1
        : correctRaw === '0' || correctRaw === 'false' || correctRaw === 'no'
          ? 0
          : Number(correctRaw);
    if (correct !== 0 && correct !== 1) continue;
    const rt = Number(cols[iRt]);
    let bucket = byAge.get(ageKey);
    if (!bucket) {
      bucket = { correct: 0, n: 0, rts: [] };
      byAge.set(ageKey, bucket);
    }
    bucket.n += 1;
    bucket.correct += correct;
    if (Number.isFinite(rt) && rt >= RT_MIN && rt <= RT_MAX) bucket.rts.push(rt);
  }

  /** @type {Record<string, { n: number, pCorrect: number, rtP25: number, rtP50: number, rtP75: number, nRt: number }>} */
  const ages = {};
  for (const [age, b] of [...byAge.entries()].sort((a, b) => a[0] - b[0])) {
    if (b.n < 20) continue;
    b.rts.sort((a, c) => a - c);
    const p25 = percentile(b.rts, 25);
    const p50 = percentile(b.rts, 50);
    const p75 = percentile(b.rts, 75);
    if (p25 == null || p50 == null || p75 == null) continue;
    ages[String(age)] = {
      n: b.n,
      pCorrect: b.correct / b.n,
      rtP25: Math.round(p25),
      rtP50: Math.round(p50),
      rtP75: Math.round(p75),
      nRt: b.rts.length,
    };
  }

  const payload = {
    task: 'pa',
    source: path.relative(REPO, CSV),
    builtAt: new Date().toISOString(),
    rtFilterMs: { min: RT_MIN, max: RT_MAX },
    ages,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`Wrote ${OUT} (${Object.keys(ages).length} ages)`);
}

main();
