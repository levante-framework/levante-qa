/**
 * Post-hoc scoring for Memory Game (Corsi) runs. Reads every run log under
 * cypress/logs (oracle_memory_*.jsonl), applies the Memory Game scoreTrials, and
 * writes one row per run to results/memory_game_summary.csv.
 *
 * The headline numbers are `observe_key_agreement` (did the observed flash
 * sequence match the app's internal key on every item — the authentic check) and
 * `accuracy` (did the app accept every reproduction), plus the max span reached.
 *
 * Usage: pnpm score:memory   (or: tsx scripts/score_memory.ts)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

import { scoreTrials } from '../cypress/support/tasks/memoryGame';
import {
  MemoryGameTrialRecordSchema,
  type MemoryGameTrialRecord,
} from '../cypress/support/tasks/types';

const LOGS_DIR = 'cypress/logs';
const RESULTS_DIR = 'results';
const OUTPUT = join(RESULTS_DIR, 'memory_game_summary.csv');

const HEADER = [
  'run_id',
  'agent',
  'task',
  'n_sequences',
  'n_forward',
  'n_backward',
  'accuracy',
  'observe_key_agreement',
  'max_span',
  'rt_mean',
  'n_with_audio',
] as const;

function num(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(Number(value.toFixed(4)));
}

function readRecords(filePath: string): MemoryGameTrialRecord[] {
  const raw = readFileSync(filePath, 'utf-8').trim();
  const candidates: unknown[] = raw.startsWith('[')
    ? (JSON.parse(raw) as unknown[])
    : raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as unknown);

  const records: MemoryGameTrialRecord[] = [];
  for (const candidate of candidates) {
    const parsed = MemoryGameTrialRecordSchema.safeParse(candidate);
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
    .filter((f) => /^oracle_memory_.*\.jsonl?$/.test(f))
    .sort();

  if (files.length === 0) {
    console.error(`No Memory Game log files found in ${LOGS_DIR}.`);
    return;
  }

  const rows: string[] = [HEADER.join(',')];

  for (const file of files) {
    const records = readRecords(join(LOGS_DIR, file));
    if (records.length === 0) continue;

    const stats = scoreTrials(records);
    const task = records[0]?.task ?? 'memory-game';
    const runId = basename(file, extname(file));

    rows.push(
      [
        runId,
        'oracle',
        task,
        String(stats.nSequences),
        String(stats.nForward),
        String(stats.nBackward),
        num(stats.accuracy),
        num(stats.observeKeyAgreement),
        num(stats.maxSpan),
        num(stats.rtMean),
        String(stats.nWithAudio),
      ].join(','),
    );
  }

  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(OUTPUT, rows.join('\n') + '\n', 'utf-8');
  console.log(`Wrote ${rows.length - 1} Memory Game run row(s) to ${OUTPUT}`);
}

main();
