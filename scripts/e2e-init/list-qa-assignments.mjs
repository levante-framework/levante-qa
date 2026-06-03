#!/usr/bin/env node
/**
 * Read-only enumeration of assignments (administrations) on the QA testing site
 * so the levante-qa dashboard can run agents over whatever tasks a user put in an
 * assignment.
 *
 * Vendored from levante-support/scripts/e2e-init so CI does not need to check out
 * the private levante-support repo. Keep behavior in sync with the canonical copy.
 *
 * Prints exactly one machine-readable line:
 *   ASSIGNMENTS_RESULT=[{ "id", "name", "dateOpened", "dateClosed",
 *                         "tasks": [{ "taskId", "language", "variantId" }] }, ...]
 *
 * Usage:
 *   node scripts/e2e-init/list-qa-assignments.mjs
 *   node scripts/e2e-init/list-qa-assignments.mjs --site-name qa-tests
 */
import 'dotenv/config';

import { cert, applicationDefault, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import fs from 'node:fs/promises';

function parseArgs(argv) {
  const args = {
    siteName: 'qa-tests',
    projectId: undefined,
    credential: process.env.LEVANTE_ADMIN_FIREBASE_CREDENTIALS,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--site-name') args.siteName = argv[++i];
    else if (a === '--project-id') args.projectId = argv[++i];
    else if (a === '--credential') args.credential = argv[++i];
    else if (a === '--force') args.force = true;
  }
  return args;
}

async function getCredentials(credentialPath) {
  if (!credentialPath) return applicationDefault();
  const raw = await fs.readFile(credentialPath, 'utf8');
  return cert(JSON.parse(raw));
}

const normalize = (s) => String(s).trim().toLowerCase();

function isoFromTimestamp(ts) {
  if (!ts) return null;
  try {
    if (typeof ts.toDate === 'function') return ts.toDate().toISOString();
    const seconds = ts.seconds ?? ts._seconds;
    if (typeof seconds === 'number') return new Date(seconds * 1000).toISOString();
  } catch {
    /* ignore */
  }
  return null;
}

async function findDistrictId(db, siteName) {
  const snap = await db.collection('districts').where('normalizedName', '==', normalize(siteName)).get();
  return snap.empty ? null : snap.docs[0].id;
}

function mapAssessments(data) {
  const assessments = Array.isArray(data?.assessments) ? data.assessments : [];
  return assessments
    .map((a) => ({
      taskId: a?.taskId ?? null,
      language: a?.params?.language ?? null,
      variantId: a?.variantId ?? null,
    }))
    .filter((a) => a.taskId);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const envProject =
    process.env.E2E_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
  const viteProject = process.env.VITE_FIREBASE_PROJECT;
  const projectId = args.projectId || envProject || 'hs-levante-admin-dev';
  const isDev = viteProject === 'DEV' || projectId === 'hs-levante-admin-dev';
  if (!args.force && !isDev) {
    throw new Error('Refusing to run outside DEV. Set VITE_FIREBASE_PROJECT=DEV or --project-id hs-levante-admin-dev (or --force).');
  }

  const credential = await getCredentials(args.credential);
  initializeApp({ projectId, credential });
  const db = getFirestore();

  const districtId = await findDistrictId(db, args.siteName);
  if (!districtId) {
    console.log('ASSIGNMENTS_RESULT=[]');
    return;
  }

  const snap = await db.collection('administrations').where('siteId', '==', districtId).get();
  const assignments = snap.docs
    .map((doc) => {
      const data = doc.data() ?? {};
      return {
        id: doc.id,
        name: data.name ?? data.publicName ?? doc.id,
        dateOpened: isoFromTimestamp(data.dateOpened),
        dateClosed: isoFromTimestamp(data.dateClosed),
        tasks: mapAssessments(data),
      };
    })
    .filter((a) => a.tasks.length > 0)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));

  console.log(`ASSIGNMENTS_RESULT=${JSON.stringify(assignments)}`);
}

main().catch((err) => {
  console.error(`[qa-list-assignments] ERROR: ${err?.stack || err?.message || err}`);
  process.exit(1);
});
