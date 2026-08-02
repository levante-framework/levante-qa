#!/usr/bin/env node
/**
 * Multi-locale TROG panel collector for cross-language translation screening.
 *
 * Runs `run_panel.mjs` sequentially per locale. Locales listed in `--force-langs`
 * get a full `--force` pass (prompt-matched recollect) then a resume mop for
 * failures. Other locales resume only (pending / failed cells).
 *
 * Usage:
 *   node tools/vlm-panel/run_langs_trog.mjs
 *   node tools/vlm-panel/run_langs_trog.mjs --dry-run
 *   node tools/vlm-panel/run_langs_trog.mjs --langs en-US,de-DE --force-langs de-DE
 *   node tools/vlm-panel/run_langs_trog.mjs --langs de-DE --force-langs de-DE --limit 1
 *
 * Progress appends to tools/vlm-panel/out/recollect_xlang.log
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, 'out');
const LOG = join(OUT_DIR, 'recollect_xlang.log');
const RUN_PANEL = join(HERE, 'run_panel.mjs');
const GRID = join(HERE, 'panel_grid.json');

const DEFAULT_LANGS = ['en-US', 'de-DE', 'es-CO', 'nl-NL'];
/** Locales whose existing panels pre-date current prompts and need a full redo. */
const DEFAULT_FORCE_LANGS = ['de-DE', 'es-CO'];

function parseList(s) {
  return String(s || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const args = {
    langs: DEFAULT_LANGS,
    forceLangs: DEFAULT_FORCE_LANGS,
    dryRun: false,
    limit: null,
    grid: GRID,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--langs') args.langs = parseList(argv[++i]);
    else if (a === '--force-langs') args.forceLangs = parseList(argv[++i]);
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--grid') args.grid = argv[++i];
    else if (a === '--no-force') args.forceLangs = [];
  }
  return args;
}

function log(line) {
  const msg = typeof line === 'string' ? line : String(line);
  console.log(msg);
  appendFileSync(LOG, msg + '\n', 'utf-8');
}

function runPanel({ lang, force, dryRun, limit, grid }) {
  const parts = ['node', JSON.stringify(RUN_PANEL), '--grid', JSON.stringify(grid), '--lang', JSON.stringify(lang)];
  if (force) parts.push('--force');
  if (dryRun) parts.push('--dry-run');
  if (Number.isFinite(limit)) parts.push('--limit', String(limit));
  const shell = `set -o pipefail; ${parts.join(' ')} 2>&1 | tee -a ${JSON.stringify(LOG)}`;

  log(`\n$ ${parts.join(' ').replace(/"/g, '')}`);
  const res = spawnSync('bash', ['-c', shell], {
    cwd: join(HERE, '..', '..'),
    env: process.env,
    stdio: 'inherit',
  });
  log(`  exit=${res.status ?? 1}${force ? ' (force)' : ' (resume)'}`);
  return res.status ?? 1;
}

function main() {
  const args = parseArgs(process.argv);
  mkdirSync(OUT_DIR, { recursive: true });
  const forceSet = new Set(args.forceLangs);

  log(`=== run_langs_trog START ${new Date().toISOString()} ===`);
  log(`langs=${args.langs.join(',')} force-langs=${args.forceLangs.join(',') || '(none)'}`);
  if (args.dryRun) log('(dry-run)');
  if (Number.isFinite(args.limit)) log(`limit=${args.limit}`);

  let worst = 0;
  for (const lang of args.langs) {
    const needForce = forceSet.has(lang);
    log(`\n-------- ${lang} ${needForce ? 'FORCE then RESUME' : 'RESUME'} --------`);

    if (needForce) {
      const st = runPanel({
        lang,
        force: true,
        dryRun: args.dryRun,
        limit: args.limit,
        grid: args.grid,
      });
      worst = Math.max(worst, st);
    }

    // Resume mop (also the only pass for non-force langs). Skipped as no-op
    // dry-run detail after a force dry-run, but still useful for plan visibility.
    const st2 = runPanel({
      lang,
      force: false,
      dryRun: args.dryRun,
      limit: args.limit,
      grid: args.grid,
    });
    worst = Math.max(worst, st2);
  }

  log(`\n=== run_langs_trog END ${new Date().toISOString()} worst_cell_exit=${worst} ===`);
  log('Next: node tools/vlm-panel/analyze.mjs --task trog --human-source=bench');
  // Cell-level Cypress failures are expected; progress lives in manifest.json.
  // Only treat a missing/crashed runner as fatal (status null → we used 1).
  process.exit(0);
}

main();
