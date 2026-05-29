/**
 * Aggregates the per-run rows in results/summary.csv across runs, grouping by
 * (agent, provider, task) and averaging the numeric metrics. Writes
 * results/aggregate.csv with a run count per group.
 *
 * Usage: pnpm summarize   (or: tsx scripts/summarize_runs.ts)
 *
 * Run `pnpm score` first to (re)generate results/summary.csv.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const RESULTS_DIR = 'results';
const INPUT = join(RESULTS_DIR, 'summary.csv');
const OUTPUT = join(RESULTS_DIR, 'aggregate.csv');

const NUMERIC_COLUMNS = [
  'n_trials',
  'acc_hearts',
  'acc_flowers',
  'acc_mixed',
  'acc_congruent',
  'acc_incongruent',
  'rt_mean_mixed',
  'timeout_rate',
  'ef_composite',
] as const;

type Row = Record<string, string>;

function parseCsv(text: string): Row[] {
  const lines = text.trim().split('\n').filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const header = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row: Row = {};
    header.forEach((h, i) => {
      row[h] = cells[i] ?? '';
    });
    return row;
  });
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function num(value: number | null): string {
  return value === null ? '' : String(Number(value.toFixed(4)));
}

function main(): void {
  if (!existsSync(INPUT)) {
    console.error(`No ${INPUT} found. Run \`pnpm score\` first.`);
    return;
  }

  const rows = parseCsv(readFileSync(INPUT, 'utf-8'));
  const groups = new Map<string, Row[]>();

  for (const row of rows) {
    const key = `${row.agent}|${row.provider}|${row.task}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }

  const header = ['agent', 'provider', 'task', 'n_runs', ...NUMERIC_COLUMNS];
  const out: string[] = [header.join(',')];

  for (const [key, bucket] of groups) {
    const [agent, provider, task] = key.split('|');
    const averages = NUMERIC_COLUMNS.map((col) => {
      const values = bucket
        .map((r) => Number(r[col]))
        .filter((v) => Number.isFinite(v));
      return num(mean(values));
    });
    out.push([agent, provider, task, String(bucket.length), ...averages].join(','));
  }

  writeFileSync(OUTPUT, out.join('\n') + '\n', 'utf-8');
  console.log(`Wrote ${out.length - 1} aggregate row(s) to ${OUTPUT}`);
}

main();
