#!/usr/bin/env node
/**
 * Sync the child-age persona artifacts (the age->task accuracy profile and the
 * prompt template) from the canonical copies in levante-bench into this repo.
 *
 * These two files are the SINGLE SOURCE OF TRUTH shared between levante-bench
 * (Python) and levante-qa (TypeScript) so both produce identical persona
 * prompts. levante-bench owns them because that is where the child trial data
 * (trials.csv) and the generator (scripts/build_age_accuracy_profile.py) live.
 *
 * Usage:
 *   node scripts/sync_persona.mjs                 # copies from ../levante-bench
 *   LEVANTE_BENCH_DIR=/path/to/levante-bench node scripts/sync_persona.mjs
 */
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const BENCH_DIR = process.env.LEVANTE_BENCH_DIR
  ? resolve(process.env.LEVANTE_BENCH_DIR)
  : resolve(REPO_ROOT, '..', 'levante-bench');

const SRC = join(BENCH_DIR, 'shared', 'persona');
const DEST = join(REPO_ROOT, 'cypress', 'support', 'persona');
const FILES = [
  'age_task_accuracy.json',
  'age_task_ability.json',
  'age_task_accuracy_by_country.json',
  'age_task_ability_by_country.json',
  'persona_template.txt',
];

async function main() {
  await mkdir(DEST, { recursive: true });
  for (const f of FILES) {
    await copyFile(join(SRC, f), join(DEST, f));
    console.log(`synced ${f}  ←  ${join(SRC, f)}`);
  }
  console.log('persona artifacts up to date.');
}

main().catch((err) => {
  console.error(`[sync_persona] ERROR: ${err?.message || err}`);
  console.error(`  expected canonical files under ${SRC}`);
  console.error('  set LEVANTE_BENCH_DIR if your levante-bench checkout is elsewhere.');
  process.exit(1);
});
