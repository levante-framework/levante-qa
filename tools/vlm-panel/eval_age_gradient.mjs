#!/usr/bin/env node
/**
 * Measure TROG panel age gradient from run logs (respondent totals + item spreads).
 *
 * Usage:
 *   node tools/vlm-panel/eval_age_gradient.mjs --lang en --ages 6,12 \
 *     --run-id-re 'panel_trog_en_(35flashlite|36flash)_a(6|12)_r[12]$'
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const RUNS_DIR = join(REPO, 'cypress', 'logs', 'runs');

function parseArg(argv, name, fallback = null) {
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === `--${name}`) return argv[i + 1] ?? fallback;
    if (argv[i].startsWith(`--${name}=`)) return argv[i].slice(name.length + 3);
  }
  return fallback;
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function pickVlmLog(runDir) {
  const files = readdirSync(runDir).filter((f) => /^vlm_.*\.jsonl?$/.test(f));
  if (!files.length) return null;
  let best = null;
  let bestSize = -1;
  for (const f of files) {
    const size = statSync(join(runDir, f)).size;
    if (size > bestSize) {
      bestSize = size;
      best = f;
    }
  }
  return best;
}

function main() {
  const lang = (parseArg(process.argv, 'lang', 'en') || 'en').toLowerCase();
  const ages = String(parseArg(process.argv, 'ages', '6,12') || '6,12')
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isFinite(n));
  const reRaw = parseArg(process.argv, 'run-id-re', null);
  const re = reRaw ? new RegExp(reRaw) : null;
  const prefix = `panel_trog_${lang}_`;

  const runDirs = readdirSync(RUNS_DIR)
    .filter((d) => d.startsWith(prefix))
    .filter((d) => (re ? re.test(d) : true));

  /** age -> respondent total accuracies */
  const byAgeTotals = new Map(ages.map((a) => [a, []]));
  /** key(transcript) -> age -> {n,c} */
  const byItem = new Map();

  for (const runId of runDirs) {
    const m = /_a(\d+)_/.exec(runId);
    if (!m) continue;
    const age = Number(m[1]);
    if (!ages.includes(age)) continue;
    const dir = join(RUNS_DIR, runId);
    const log = pickVlmLog(dir);
    if (!log) continue;
    let correct = 0;
    let n = 0;
    for (const line of readFileSync(join(dir, log), 'utf-8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.itemType !== 'item' || typeof rec.correct !== 'boolean') continue;
      if (rec.chosenIndex === null || rec.chosenIndex === undefined) continue;
      const key = String(rec.audioTranscript ?? '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
      if (!key) continue;
      n++;
      correct += rec.correct ? 1 : 0;
      if (!byItem.has(key)) byItem.set(key, new Map());
      const am = byItem.get(key);
      if (!am.has(age)) am.set(age, { n: 0, c: 0 });
      const cell = am.get(age);
      cell.n++;
      cell.c += rec.correct ? 1 : 0;
    }
    if (n > 0) byAgeTotals.get(age).push(correct / n);
  }

  const ageSummary = {};
  for (const age of ages) {
    const xs = byAgeTotals.get(age) || [];
    ageSummary[age] = {
      n_resp: xs.length,
      mean_p: mean(xs),
      med_p: median(xs),
    };
  }
  const lo = ages[0];
  const hi = ages[ages.length - 1];
  const deltaMed =
    ageSummary[hi]?.med_p != null && ageSummary[lo]?.med_p != null
      ? ageSummary[hi].med_p - ageSummary[lo].med_p
      : null;

  const spreads = [];
  for (const [, am] of byItem) {
    const ps = [];
    for (const age of ages) {
      const cell = am.get(age);
      if (cell && cell.n > 0) ps.push(cell.c / cell.n);
    }
    if (ps.length >= 2) spreads.push(Math.max(...ps) - Math.min(...ps));
  }
  spreads.sort((a, b) => a - b);
  const pct = (q) =>
    spreads.length
      ? spreads[Math.min(spreads.length - 1, Math.floor(q * (spreads.length - 1)))]
      : null;

  const out = {
    lang,
    ages,
    run_id_re: reRaw,
    n_runs: runDirs.length,
    age_summary: ageSummary,
    delta_med_p: deltaMed,
    item_spread: {
      n_items: spreads.length,
      median: pct(0.5),
      p90: pct(0.9),
      mean: mean(spreads),
    },
  };
  console.log(JSON.stringify(out, null, 2));
  if (deltaMed != null) {
    console.error(
      `Δ med_p(a${hi}−a${lo})=${deltaMed.toFixed(3)} · item median spread=${pct(0.5)?.toFixed(3) ?? '—'} · runs=${runDirs.length}`,
    );
  }
}

main();
