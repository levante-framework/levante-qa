/**
 * Post-hoc scoring for Mental Rotation runs. Reads every MR run log under
 * cypress/logs (oracle_mr_*.jsonl / vlm_mr_*.jsonl), applies the MR scoreTrials,
 * and writes one row per run to results/mental_rotation_summary.csv.
 *
 * Accuracy is over scored items (the app `.correct` key); rotation can't be
 * recomputed, so the key is the only ground truth for both agents.
 *
 * Usage: pnpm score:mr   (or: tsx scripts/score_mr.ts)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

import { scoreTrials } from '../cypress/support/tasks/mentalRotation';
import {
  MentalRotationTrialRecordSchema,
  type MentalRotationTrialRecord,
} from '../cypress/support/tasks/types';

const LOGS_DIR = 'cypress/logs';
const RESULTS_DIR = 'results';
const OUTPUT = join(RESULTS_DIR, 'mental_rotation_summary.csv');

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

function readRecords(filePath: string): MentalRotationTrialRecord[] {
  const raw = readFileSync(filePath, 'utf-8').trim();
  const candidates: unknown[] = raw.startsWith('[')
    ? (JSON.parse(raw) as unknown[])
    : raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as unknown);

  const records: MentalRotationTrialRecord[] = [];
  for (const candidate of candidates) {
    const parsed = MentalRotationTrialRecordSchema.safeParse(candidate);
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
    .filter((f) => /^(oracle|vlm)_mr_.*\.jsonl?$/.test(f))
    .sort();

  if (files.length === 0) {
    console.error(`No Mental Rotation log files found in ${LOGS_DIR}.`);
    return;
  }

  const rows: string[] = [HEADER.join(',')];

  for (const file of files) {
    const records = readRecords(join(LOGS_DIR, file));
    if (records.length === 0) continue;

    const stats = scoreTrials(records);
    const agent = records.some((r) => r.oracle) ? 'oracle' : 'vlm';
    const provider = records.find((r) => r.provider)?.provider ?? '';
    const task = records[0]?.task ?? 'mental-rotation';
    const runId = basename(file, extname(file));

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
  console.log(`Wrote ${rows.length - 1} Mental Rotation run row(s) to ${OUTPUT}`);
}

main();
