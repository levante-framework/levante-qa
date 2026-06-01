/**
 * Post-hoc scoring. Reads every run log under cypress/logs (*.jsonl and *.json),
 * applies scoreTrials, and writes one row per run to results/summary.csv.
 *
 * Usage: pnpm score   (or: tsx scripts/score.ts)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

import { scoreTrials } from '../cypress/support/tasks/heartsAndFlowers';
import { agentFromRunId } from './logAgent';
import { TrialRecordSchema, type TrialRecord } from '../cypress/support/tasks/types';

const LOGS_DIR = 'cypress/logs';
const RESULTS_DIR = 'results';
const OUTPUT = join(RESULTS_DIR, 'summary.csv');

const HEADER = [
  'run_id',
  'agent',
  'provider',
  'task',
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

function num(value: number | null): string {
  return value === null ? '' : String(Number(value.toFixed(4)));
}

function readRecords(filePath: string): TrialRecord[] {
  const raw = readFileSync(filePath, 'utf-8');
  const records: TrialRecord[] = [];
  // Support both newline-delimited JSON and a single JSON array.
  const trimmed = raw.trim();
  const candidates: unknown[] = trimmed.startsWith('[')
    ? (JSON.parse(trimmed) as unknown[])
    : trimmed
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as unknown);

  for (const candidate of candidates) {
    const parsed = TrialRecordSchema.safeParse(candidate);
    if (parsed.success) {
      records.push(parsed.data);
    }
  }
  return records;
}

function main(): void {
  if (!existsSync(LOGS_DIR)) {
    console.error(`No logs directory at ${LOGS_DIR}; nothing to score.`);
    return;
  }

  const files = readdirSync(LOGS_DIR)
    .filter((f) => f.endsWith('.jsonl') || f.endsWith('.json'))
    .sort();

  if (files.length === 0) {
    console.error(`No log files found in ${LOGS_DIR}.`);
    return;
  }

  const rows: string[] = [HEADER.join(',')];

  for (const file of files) {
    const filePath = join(LOGS_DIR, file);
    const records = readRecords(filePath);
    if (records.length === 0) continue;

    const stats = scoreTrials(records);
    const runId = basename(file, extname(file));
    const agent = agentFromRunId(runId, records);
    const provider = records.find((r) => r.provider)?.provider ?? '';
    const task = records[0]?.task ?? '';

    rows.push(
      [
        runId,
        agent,
        provider,
        task,
        String(stats.nTrials),
        num(stats.accHearts),
        num(stats.accFlowers),
        num(stats.accMixed),
        num(stats.accCongruent),
        num(stats.accIncongruent),
        num(stats.rtMeanMixed),
        num(stats.timeoutRate),
        num(stats.efComposite),
      ].join(','),
    );
  }

  if (!existsSync(RESULTS_DIR)) {
    mkdirSync(RESULTS_DIR, { recursive: true });
  }
  writeFileSync(OUTPUT, rows.join('\n') + '\n', 'utf-8');
  console.log(`Wrote ${rows.length - 1} run row(s) to ${OUTPUT}`);
}

main();
