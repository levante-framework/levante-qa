#!/usr/bin/env node
/**
 * Replay TROG panel cells from captured viewport PNGs (no Cypress UI).
 *
 * Usage (usually via run_panel.mjs --replay):
 *   npx tsx tools/vlm-panel/replay_panel.ts --grid panel_grid.json --lang en-US
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, appendFileSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

// Run the TypeScript replay body via tsx (Cypress TS modules + Gemini client).
const r = spawnSync(
  'npx',
  ['tsx', join(HERE, 'replay_panel_main.ts'), ...process.argv.slice(2)],
  { cwd: REPO, env: process.env, stdio: 'inherit' },
);
process.exit(r.status ?? 1);
