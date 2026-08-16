#!/usr/bin/env node
/**
 * CLI wrapper: `node scripts/cypress-run.mjs …` ≡ off-screen `cypress run …`.
 * Pass `--headed` or set QA_CYPRESS_HEADED=1 to show the Electron window.
 */
import { spawnCypressRun, wantCypressHeaded } from './lib/cypressOffscreen.mjs';

const raw = process.argv.slice(2);
const headed = wantCypressHeaded(process.env, raw);
const cyArgs = raw.filter((a) => a !== '--headed');

const child = spawnCypressRun(cyArgs, {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
  headed,
});

child.on('error', (err) => {
  console.error(`[cypress-run] spawn failed: ${err?.message || err}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
