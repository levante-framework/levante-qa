/**
 * Post-hoc scoring for EGMA math runs. Reads every EGMA run log under
 * cypress/logs (oracle_egma_*.jsonl / vlm_egma_*.jsonl), applies the EGMA
 * scoreTrials, and writes one row per run to results/egma_summary.csv.
 *
 * Usage: pnpm score:egma   (or: tsx scripts/score_egma.ts)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

import { scoreTrials } from '../cypress/support/tasks/egmaMath';
import { agentFromRunId } from './logAgent';
import { EgmaTrialRecordSchema, type EgmaTrialRecord } from '../cypress/support/tasks/types';

const LOGS_DIR = 'cypress/logs';
const RESULTS_DIR = 'results';
const OUTPUT = join(RESULTS_DIR, 'egma_summary.csv');

const HEADER = [
  'run_id',
  'agent',
  'provider',
  'task',
  'n_trials',
  'acc_choice',
  'acc_number_id',
  'acc_comparison',
  'acc_missing_number',
  'acc_arithmetic',
  'number_line_mean_error',
  'rt_mean',
  'timeout_rate',
  'item_types',
] as const;

function num(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(Number(value.toFixed(4)));
}

function readRecords(filePath: string): EgmaTrialRecord[] {
  const raw = readFileSync(filePath, 'utf-8').trim();
  const candidates: unknown[] = raw.startsWith('[')
    ? (JSON.parse(raw) as unknown[])
    : raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as unknown);

  const records: EgmaTrialRecord[] = [];
  for (const candidate of candidates) {
    const parsed = EgmaTrialRecordSchema.safeParse(candidate);
    if (parsed.success) records.push(parsed.data);
  }
  return records;
}

function main(): void {
  if (!existsSync(LOGS_DIR)) {
    console.error(`No logs directory at ${LOGS_DIR}; nothing to score.`);
    return;
  }

  // Only EGMA run logs (skip the H&F logs and the live/diagnostic scratch files).
  const files = readdirSync(LOGS_DIR)
    .filter((f) => /^(oracle|vlm|wrong)_egma_.*\.jsonl?$/.test(f))
    .sort();

  if (files.length === 0) {
    console.error(`No EGMA log files found in ${LOGS_DIR}.`);
    return;
  }

  const rows: string[] = [HEADER.join(',')];

  for (const file of files) {
    const records = readRecords(join(LOGS_DIR, file));
    if (records.length === 0) continue;

    const stats = scoreTrials(records);
    const runId = basename(file, extname(file));
    const agent = agentFromRunId(runId, records);
    const provider = records.find((r) => r.provider)?.provider ?? '';
    const task = records[0]?.task ?? 'egma-math';

    rows.push(
      [
        runId,
        agent,
        provider,
        task,
        String(stats.nTrials),
        num(stats.accChoice),
        num(stats.accByType['number-identification']),
        num(stats.accByType['number-comparison']),
        num(stats.accByType['missing-number']),
        num(stats.accByType.arithmetic),
        num(stats.numberLineMeanError),
        num(stats.rtMean),
        num(stats.timeoutRate),
        `"${stats.itemTypesObserved.join(' ')}"`,
      ].join(','),
    );
  }

  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(OUTPUT, rows.join('\n') + '\n', 'utf-8');
  console.log(`Wrote ${rows.length - 1} EGMA run row(s) to ${OUTPUT}`);
}

main();
