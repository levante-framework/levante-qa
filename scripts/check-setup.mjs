#!/usr/bin/env node
/**
 * Quick preflight for the local QA dashboard.
 * Run: node scripts/check-setup.mjs
 */
import { existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const support = resolve(root, '..', 'levante-support');
const provisioner = resolve(support, 'scripts/e2e-init/provision-participant.mjs');
const cypress = resolve(root, 'node_modules/.bin/cypress');

const checks = [
  ['levante-qa node_modules (Cypress)', cypress],
  ['levante-support checkout', support],
  ['provision-participant.mjs', provisioner],
  ['setup-qa-site.mjs', resolve(support, 'scripts/e2e-init/setup-qa-site.mjs')],
];

let ok = true;
for (const [label, path] of checks) {
  const pass = existsSync(path);
  console.log(`${pass ? '✓' : '✗'} ${label}`);
  if (!pass) ok = false;
}

const credPath = process.env.LEVANTE_ADMIN_FIREBASE_CREDENTIALS;
if (credPath) {
  try {
    await access(credPath);
    console.log(`✓ LEVANTE_ADMIN_FIREBASE_CREDENTIALS (${credPath})`);
  } catch {
    console.log(`✗ LEVANTE_ADMIN_FIREBASE_CREDENTIALS file not readable: ${credPath}`);
    ok = false;
  }
} else {
  console.log('✗ LEVANTE_ADMIN_FIREBASE_CREDENTIALS not set (see levante-support/.env)');
  ok = false;
}

process.exit(ok ? 0 : 1);
