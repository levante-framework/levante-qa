/**
 * Post-hoc scoring for Vocab runs. Reads every Vocab run log under
 * cypress/logs (oracle_vocab_*.jsonl / vlm_vocab_*.jsonl), applies the Vocab
 * scoreTrials, and writes one row per run to results/vocab_summary.csv.
 *
 * Usage: pnpm score:vocab   (or: tsx scripts/score_vocab.ts)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

import { scoreTrials } from '../cypress/support/tasks/vocab';
import { agentFromRunId } from './logAgent';
import { VocabTrialRecordSchema, type VocabTrialRecord } from '../cypress/support/tasks/types';

const LOGS_DIR = 'cypress/logs';
const RESULTS_DIR = 'results';
const OUTPUT = join(RESULTS_DIR, 'vocab_summary.csv');

const HEADER = [
  'run_id',
  'agent',
  'provider',
  'task',
  'n_trials',
  'accuracy',
  'rt_mean',
  'timeout_rate',
  'n_with_audio',
] as const;

function num(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(Number(value.toFixed(4)));
}

function readRecords(filePath: string): VocabTrialRecord[] {
  const raw = readFileSync(filePath, 'utf-8').trim();
  const candidates: unknown[] = raw.startsWith('[')
    ? (JSON.parse(raw) as unknown[])
    : raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as unknown);

  const records: VocabTrialRecord[] = [];
  for (const candidate of candidates) {
    const parsed = VocabTrialRecordSchema.safeParse(candidate);
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
    .filter((f) => /^(oracle|vlm|wrong)_vocab_.*\.jsonl?$/.test(f))
    .sort();

  if (files.length === 0) {
    console.error(`No Vocab log files found in ${LOGS_DIR}.`);
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
    const task = records[0]?.task ?? 'vocab';

    rows.push(
      [
        runId,
        agent,
        provider,
        task,
        String(stats.nTrials),
        num(stats.accuracy),
        num(stats.rtMean),
        num(stats.timeoutRate),
        String(stats.nWithAudio),
      ].join(','),
    );
  }

  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(OUTPUT, rows.join('\n') + '\n', 'utf-8');
  console.log(`Wrote ${rows.length - 1} Vocab run row(s) to ${OUTPUT}`);
}

main();
