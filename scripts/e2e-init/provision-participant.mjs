#!/usr/bin/env node
/**
 * Provision a unique, age-specific QA participant on hs-levante-admin-dev with a
 * single-task assignment. Used by the levante-qa dashboard (one participant per
 * parallel Cypress run).
 *
 * Vendored from levante-support/scripts/e2e-init so CI does not need to check out
 * the private levante-support repo. Keep behavior in sync with the canonical copy.
 *
 * Prints: PROVISION_RESULT={"email","password","uid"}
 *
 * Usage:
 *   node scripts/e2e-init/provision-participant.mjs \
 *     --task egma-math --language en-US --age-years 8 --age-months 0 --run-id abc12345
 */
import 'dotenv/config';

import { cert, applicationDefault, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';

const SITE_NAME = 'qa-tests';
const DEFAULT_LEGAL = {
  amount: '0',
  assent: null,
  consent: 'I consent to the terms of the Levante Privacy Policy and Terms of Service.',
  expectedTime: '30 minutes',
};

function parseArgs(argv) {
  const args = {
    task: undefined,
    language: 'en-US',
    ageYears: 8,
    ageMonths: 0,
    runId: crypto.randomBytes(4).toString('hex'),
    projectId: undefined,
    credential: process.env.LEVANTE_ADMIN_FIREBASE_CREDENTIALS,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--task') args.task = argv[++i];
    else if (a === '--language') args.language = argv[++i];
    else if (a === '--age-years') args.ageYears = Number(argv[++i]);
    else if (a === '--age-months') args.ageMonths = Number(argv[++i]);
    else if (a === '--run-id') args.runId = argv[++i];
    else if (a === '--project-id') args.projectId = argv[++i];
    else if (a === '--credential') args.credential = argv[++i];
    else if (a === '--force') args.force = true;
  }
  if (!args.task) throw new Error('Missing --task');
  if (!Number.isFinite(args.ageYears) || args.ageYears < 0) throw new Error('Invalid --age-years');
  if (!Number.isFinite(args.ageMonths) || args.ageMonths < 0 || args.ageMonths > 11) {
    throw new Error('Invalid --age-months');
  }
  return args;
}

async function getCredentials(credentialPath) {
  if (!credentialPath) return applicationDefault();
  const raw = await fs.readFile(credentialPath, 'utf8');
  return cert(JSON.parse(raw));
}

const normalize = (s) => String(s).trim().toLowerCase();

function birthFromAge(ageYears, ageMonths) {
  const now = new Date();
  let year = now.getFullYear() - ageYears;
  let month = now.getMonth() + 1 - ageMonths;
  while (month <= 0) {
    month += 12;
    year -= 1;
  }
  return { birthYear: String(year), birthMonth: String(month) };
}

async function getOrCreateDistrict(db, siteName) {
  const normalizedName = normalize(siteName);
  const snap = await db.collection('districts').where('normalizedName', '==', normalizedName).get();
  if (!snap.empty) return snap.docs[0].id;
  const ref = db.collection('districts').doc();
  await ref.set({
    name: siteName,
    normalizedName,
    tags: [],
    schools: [],
    classes: [],
    archivedSchools: [],
    archivedClasses: [],
    subGroups: [],
    type: 'districts',
    createdBy: 'qa-provision',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

function pickVariant(docs, languageCode) {
  const registered = docs.filter((d) => d.data()?.registered === true);
  const pool = registered.length ? registered : docs;
  const want = String(languageCode || 'en-US').toLowerCase();
  const wantBase = want.split('-')[0];
  const score = (d) => {
    const data = d.data() ?? {};
    const lang = String(data.params?.language ?? '').toLowerCase();
    const name = String(data.name ?? '').toLowerCase();
    let s = 0;
    if (lang === want) s += 200;
    else if (lang === wantBase || lang.startsWith(`${wantBase}-`)) s += 120;
    else if (lang.startsWith('en') || /english|united states|north america/.test(name)) s += 40;
    if (/pilot|experimental/.test(name)) s -= 5;
    return s;
  };
  const sorted = [...pool].sort((a, b) => score(b) - score(a));
  return sorted[0] ?? null;
}

async function buildAssessment(db, taskId, languageCode) {
  const taskDoc = await db.collection('tasks').doc(taskId).get();
  if (!taskDoc.exists) throw new Error(`Task "${taskId}" not found on dev`);
  const variants = await db.collection('tasks').doc(taskId).collection('variants').get();
  if (variants.empty) throw new Error(`Task "${taskId}" has no variants`);
  const pick = pickVariant(variants.docs, languageCode);
  if (!pick) throw new Error(`Task "${taskId}" has no usable variant for ${languageCode}`);
  const data = pick.data() ?? {};
  return {
    taskId,
    variantId: pick.id,
    variantName: data.name ?? languageCode,
    params: data.params ?? { language: languageCode },
  };
}

async function createParticipant(db, { districtId, siteName, email, password, birthYear, birthMonth }) {
  const auth = getAuth();
  const user = await auth.createUser({
    email,
    password,
    displayName: `QA ${email.split('@')[0]}`,
    emailVerified: true,
  });
  const uid = user.uid;
  const roles = [{ siteId: districtId, siteName, role: 'participant' }];
  const orgMap = { all: [districtId], current: [districtId], dates: { [districtId]: { from: new Date(), to: null } } };
  const empty = { all: [], current: [], dates: {} };

  await db.collection('users').doc(uid).set(
    {
      uid,
      email,
      displayName: user.displayName,
      username: email.split('@')[0],
      userType: 'student',
      assessmentUid: uid,
      assessmentPid: uid,
      grade: '',
      birthYear,
      birthMonth,
      archived: false,
      districts: orgMap,
      schools: empty,
      classes: empty,
      groups: empty,
      families: empty,
      legal: { assent: {}, tos: {} },
      roles,
      assignments: { assigned: [], completed: [], started: [] },
      testData: true,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      lastUpdated: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  const claims = {
    super_admin: false,
    admin: false,
    useNewPermissions: true,
    roarUid: uid,
    adminUid: uid,
    assessmentUid: uid,
    roles,
    rolesSet: ['participant'],
    siteRoles: { [districtId]: ['participant'] },
    siteNames: { [districtId]: siteName },
  };
  await db.collection('userClaims').doc(uid).set(
    { claims, testData: true, lastUpdated: Date.now(), updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  await auth.setCustomUserClaims(uid, claims);
  return { uid, email, password };
}

async function createAdministration(db, { districtId, name, assessments, createdBy }) {
  const now = new Date();
  const closeDate = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
  const orgs = { districts: [districtId], schools: [], classes: [], groups: [], families: [] };
  const ref = db.collection('administrations').doc();
  const adminId = ref.id;
  const base = {
    assessments,
    classes: [],
    createdBy,
    creatorName: 'qa-provision',
    dateClosed: Timestamp.fromDate(closeDate),
    dateOpened: Timestamp.fromDate(now),
    dateCreated: FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp(),
    districts: [districtId],
    families: [],
    groups: [],
    legal: DEFAULT_LEGAL,
    minimalOrgs: orgs,
    name,
    publicName: name,
    normalizedName: normalize(name),
    readOrgs: orgs,
    schools: [],
    sequential: false,
    tags: ['qa', 'automation'],
    testData: true,
    siteId: districtId,
    updatedAt: FieldValue.serverTimestamp(),
  };
  await ref.set(base);

  const adminRef = db.collection('administrations').doc(adminId);
  for (const sub of ['assignedOrgs', 'readOrgs']) {
    await adminRef.collection(sub).doc(`district_${districtId}`).set(
      {
        administrationId: adminId,
        createdBy,
        dateClosed: base.dateClosed,
        dateCreated: FieldValue.serverTimestamp(),
        dateOpened: base.dateOpened,
        legal: DEFAULT_LEGAL,
        name,
        orgId: districtId,
        orgType: 'district',
        publicName: name,
        testData: true,
        timestamp: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }
  await adminRef
    .collection('stats')
    .doc('summary')
    .set({ assignment: { total: 1, assigned: 1, started: 0, completed: 0 }, survey: { total: 0, completed: 0 } }, { merge: true });

  return { adminId, dateOpened: base.dateOpened, dateClosed: base.dateClosed };
}

async function writeParticipantAssignment(db, { uid, email, districtId, adminId, name, assessments, dateOpened, dateClosed }) {
  const orgs = { districts: [districtId], schools: [], classes: [], groups: [], families: [] };
  const progress = {};
  for (const a of assessments) progress[a.taskId.replace(/-/g, '_')] = 'assigned';
  await db
    .collection('users')
    .doc(uid)
    .collection('assignments')
    .doc(adminId)
    .set(
      {
        id: adminId,
        name,
        publicName: name,
        started: false,
        completed: false,
        progress,
        dateAssigned: FieldValue.serverTimestamp(),
        dateOpened,
        dateClosed,
        assigningOrgs: orgs,
        readOrgs: orgs,
        sequential: false,
        legal: DEFAULT_LEGAL,
        assessments: assessments.map((a) => ({
          taskId: a.taskId,
          optional: false,
          params: a.params,
          variantId: a.variantId,
          variantName: a.variantName,
        })),
        userData: {
          assessmentPid: uid,
          assessmentUid: uid,
          email,
          grade: null,
          name: { first: 'QA', middle: null, last: 'Run' },
          schoolLevel: null,
          username: email.split('@')[0],
        },
        testData: true,
      },
      { merge: true },
    );
  await db
    .collection('users')
    .doc(uid)
    .set(
      {
        assignments: { assigned: FieldValue.arrayUnion(adminId) },
        [`assignmentsAssigned.${adminId}`]: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
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

  const runSlug = String(args.runId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || crypto.randomBytes(4).toString('hex');
  const email = `qa-${runSlug}@levante.test`;
  const password = `Qa-${crypto.randomBytes(12).toString('base64url')}`;
  const { birthYear, birthMonth } = birthFromAge(args.ageYears, args.ageMonths);

  const districtId = await getOrCreateDistrict(db, SITE_NAME);
  const assessment = await buildAssessment(db, args.task, args.language);
  const participant = await createParticipant(db, {
    districtId,
    siteName: SITE_NAME,
    email,
    password,
    birthYear,
    birthMonth,
  });

  const assignmentName = `QA ${args.task} ${runSlug}`;
  const { adminId, dateOpened, dateClosed } = await createAdministration(db, {
    districtId,
    name: assignmentName,
    assessments: [assessment],
    createdBy: participant.uid,
  });

  await writeParticipantAssignment(db, {
    uid: participant.uid,
    email: participant.email,
    districtId,
    adminId,
    name: assignmentName,
    assessments: [assessment],
    dateOpened,
    dateClosed,
  });

  const result = { email: participant.email, password: participant.password, uid: participant.uid };
  console.log(`PROVISION_RESULT=${JSON.stringify(result)}`);
}

main().catch((err) => {
  console.error(`[qa-provision] ERROR: ${err?.stack || err?.message || err}`);
  process.exit(1);
});
