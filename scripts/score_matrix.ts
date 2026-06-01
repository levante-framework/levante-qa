/**
 * Post-hoc scoring for Matrix Reasoning runs. Reads every Matrix run log under
 * cypress/logs (oracle_matrix_*.jsonl / vlm_matrix_*.jsonl), applies the Matrix
 * scoreTrials, and writes one row per run to results/matrix_reasoning_summary.csv.
 *
 * Accuracy is over scored items (the app `.correct` key); the analogy can't be
 * recomputed, so the key is the only ground truth for both agents.
 *
 * Usage: pnpm score:matrix   (or: tsx scripts/score_matrix.ts)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

import { scoreTrials } from '../cypress/support/tasks/matrixReasoning';
import { agentFromRunId } from './logAgent';
import {
  MatrixReasoningTrialRecordSchema,
  type MatrixReasoningTrialRecord,
} from '../cypress/support/tasks/types';

const LOGS_DIR = 'cypress/logs';
const RESULTS_DIR = 'results';
const OUTPUT = join(RESULTS_DIR, 'matrix_reasoning_summary.csv');

const HEADER = [
  'run_id',
  'agent',
  'provider',
  'task',
  'n_items',
  'accuracy',
  'rt_mean',
  'timeout_rate',
  'n_with_audio',
] as const;

function num(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(Number(value.toFixed(4)));
}

function readRecords(filePath: string): MatrixReasoningTrialRecord[] {
  const raw = readFileSync(filePath, 'utf-8').trim();
  const candidates: unknown[] = raw.startsWith('[')
    ? (JSON.parse(raw) as unknown[])
    : raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as unknown);

  const records: MatrixReasoningTrialRecord[] = [];
  for (const candidate of candidates) {
    const parsed = MatrixReasoningTrialRecordSchema.safeParse(candidate);
    if (parsed.success) records.push(parsed.data);
  }
  return records;
}

function main(): void {
  if (!existsSync(LOGS_DIR)) {
    console.error(`No logs directory at ${LOGS_DIR}; nothing to score.`);
    return;
  }

  const files = readdirSync(LOGS_DIR)
    .filter((f) => /^(oracle|vlm|wrong)_matrix_.*\.jsonl?$/.test(f))
    .sort();

  if (files.length === 0) {
    console.error(`No Matrix Reasoning log files found in ${LOGS_DIR}.`);
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
    const task = records[0]?.task ?? 'matrix-reasoning';

    rows.push(
      [
        runId,
        agent,
        provider,
        task,
        String(stats.nItems),
        num(stats.accuracy),
        num(stats.rtMean),
        num(stats.timeoutRate),
        String(stats.nWithAudio),
      ].join(','),
    );
  }

  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(OUTPUT, rows.join('\n') + '\n', 'utf-8');
  console.log(`Wrote ${rows.length - 1} Matrix Reasoning run row(s) to ${OUTPUT}`);
}

main();
