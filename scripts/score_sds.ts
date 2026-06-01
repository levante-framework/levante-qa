/**
 * Post-hoc scoring for Same-Different Selection runs. Reads every SDS run log
 * under cypress/logs (oracle_sds_*.jsonl / vlm_sds_*.jsonl), applies the SDS
 * scoreTrials, and writes one row per run to results/sds_summary.csv.
 *
 * Note: only single-select items carry an answer key, so accuracy is over
 * single-select; match rounds have no key (completion is the regression signal).
 *
 * Usage: pnpm score:sds   (or: tsx scripts/score_sds.ts)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

import { scoreTrials } from '../cypress/support/tasks/sameDifferent';
import { agentFromRunId } from './logAgent';
import { SdsTrialRecordSchema, type SdsTrialRecord } from '../cypress/support/tasks/types';

const LOGS_DIR = 'cypress/logs';
const RESULTS_DIR = 'results';
const OUTPUT = join(RESULTS_DIR, 'sds_summary.csv');

const HEADER = [
  'run_id',
  'agent',
  'provider',
  'task',
  'n_single',
  'n_match',
  'accuracy_single',
  'rt_mean',
  'timeout_rate',
  'n_with_audio',
] as const;

function num(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(Number(value.toFixed(4)));
}

function readRecords(filePath: string): SdsTrialRecord[] {
  const raw = readFileSync(filePath, 'utf-8').trim();
  const candidates: unknown[] = raw.startsWith('[')
    ? (JSON.parse(raw) as unknown[])
    : raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as unknown);

  const records: SdsTrialRecord[] = [];
  for (const candidate of candidates) {
    const parsed = SdsTrialRecordSchema.safeParse(candidate);
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
    .filter((f) => /^(oracle|vlm|wrong)_sds_.*\.jsonl?$/.test(f))
    .sort();

  if (files.length === 0) {
    console.error(`No SDS log files found in ${LOGS_DIR}.`);
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
    const task = records[0]?.task ?? 'same-different-selection';

    rows.push(
      [
        runId,
        agent,
        provider,
        task,
        String(stats.nSingle),
        String(stats.nMatch),
        num(stats.accuracySingle),
        num(stats.rtMean),
        num(stats.timeoutRate),
        String(stats.nWithAudio),
      ].join(','),
    );
  }

  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(OUTPUT, rows.join('\n') + '\n', 'utf-8');
  console.log(`Wrote ${rows.length - 1} SDS run row(s) to ${OUTPUT}`);
}

main();
