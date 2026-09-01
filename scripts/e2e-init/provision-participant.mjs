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
 *
 * Optional assessment param overrides (merged into administration + assignment):
 *   --param isAdaptive=true
 *   --param isAdaptive=false
 *   --param userMode=adaptiveTimingMultiStage   # SWR CAT variant (also set QA_SWR_USER_MODE)
 *   --variant-id <id>                           # pin tasks/<task>/variants/<id>
 *   --variant-name <name>                       # label when using --params-json
 *   --params-json '{...}'                       # use these params (skip -dev catalog lookup)
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
    variantId: undefined,
    variantName: undefined,
    paramsJson: undefined,
    /** @type {Record<string, unknown>} */
    paramOverrides: {},
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
    else if (a === '--variant-id') args.variantId = argv[++i];
    else if (a === '--variant-name') args.variantName = argv[++i];
    else if (a === '--params-json') args.paramsJson = argv[++i];
    else if (a === '--param') {
      const raw = argv[++i];
      if (!raw || !raw.includes('=')) {
        throw new Error(`Invalid --param '${raw}' (expected key=value)`);
      }
      const eq = raw.indexOf('=');
      const key = raw.slice(0, eq).trim();
      const valueRaw = raw.slice(eq + 1).trim();
      if (!key) throw new Error(`Invalid --param '${raw}' (empty key)`);
      args.paramOverrides[key] = coerceParamValue(valueRaw);
    }
  }
  if (!args.task) throw new Error('Missing --task');
  if (!Number.isFinite(args.ageYears) || args.ageYears < 0) throw new Error('Invalid --age-years');
  if (!Number.isFinite(args.ageMonths) || args.ageMonths < 0 || args.ageMonths > 11) {
    throw new Error('Invalid --age-months');
  }
  return args;
}

/** Coerce common param string forms used in Firestore variant params. */
function coerceParamValue(valueRaw) {
  const lower = valueRaw.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (lower === 'null') return null;
  const n = Number(valueRaw);
  if (valueRaw !== '' && Number.isFinite(n) && String(n) === valueRaw) return n;
  return valueRaw;
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

/** roar-swr / i18next use languageOnly codes (en, de, es, …). */
function languageOnly(languageCode) {
  return String(languageCode || 'en-US').toLowerCase().split('-')[0];
}

/**
 * GCS audio folders are case-sensitive (`audio/en-US/`, `audio/es-CO/`).
 * Several registered variants store `en-us` / `es-co` / `es-Ar`. core-tasks
 * lists that exact string, gets an empty folder, and never hides the splash —
 * the oracle then waits 5 minutes for a continue button that never mounts.
 * Bare codes (`en`, `es`, `de`) are left alone; the task remaps those.
 */
function canonicalizeLanguageTag(lang) {
  if (lang == null || lang === '') return lang;
  const raw = String(lang);
  const lower = raw.toLowerCase();
  if (!lower.includes('-')) return raw;
  const [primary, region] = lower.split('-');
  if (!primary || !region) return raw;
  return `${primary}-${region.toUpperCase()}`;
}

/** Exact locale, or ROAR/TROG bare `en`/`es`/`de`. Sibling regions (`en-GB` for `en-US`) do not match. */
function nameMatchesWant(name, want, wantBase) {
  const n = String(name || '').toLowerCase();
  if (!n) return false;
  if (n === want || n === wantBase) return true;
  if (n.startsWith(`${want}-`) || n.startsWith(`${want} `)) return true;
  return n.startsWith(`${wantBase} `);
}

function pickVariant(docs, languageCode, preferUserMode = '') {
  const want = String(languageCode || 'en-US').toLowerCase();
  const wantBase = languageOnly(want);
  const wantMode = String(preferUserMode || '').trim();
  const hasPreferred =
    Boolean(wantMode) &&
    docs.some((d) => String(d.data()?.params?.userMode ?? '') === wantMode);
  const score = (d) => {
    const data = d.data() ?? {};
    const lang = String(data.params?.language ?? '').toLowerCase();
    const name = String(data.name ?? '').toLowerCase();
    const mode = String(data.params?.userMode ?? 'shortRandom');
    let s = 0;
    if (lang === want) s += 200;
    else if (lang === wantBase) s += 120;
    // hs-levante-admin-dev SWR English variants use name "en" and language: null.
    if (nameMatchesWant(name, want, wantBase)) s += 150;
    else if (lang.startsWith('en') || /english|united states|north america/.test(name)) s += 40;
    if (hasPreferred && mode === wantMode) s += 100;
    else if (mode === 'shortRandom') s += 15;
    if (/pilot|experimental/.test(name)) s -= 5;
    if (data.registered === true) s += 10;
    return s;
  };
  const describe = (d) => {
    const data = d.data() ?? {};
    return `${data.name ?? d.id}(lang=${data.params?.language ?? 'null'}, registered=${data.registered === true})`;
  };
  // Require a real language/name match. Falling back to "any registered" used to
  // pick German SWR (language: "de") for it-IT / pt-BR when those variants are missing,
  // and EN with language:null was not enough to pin roar-swr away from host locale.
  const langMatch = docs.filter((d) => score(d) >= 120);
  if (!langMatch.length) {
    throw new Error(
      `No task variant matches language "${languageCode}" (base=${wantBase}). ` +
        `Available: ${docs.map(describe).join(', ') || '(none)'}`,
    );
  }
  const langOf = (d) => String(d.data()?.params?.language ?? '').toLowerCase();
  const isRegistered = (d) => d.data()?.registered === true;
  const registered = langMatch.filter(isRegistered);
  if (!registered.length) {
    throw new Error(
      `No registered task variant matches language "${languageCode}" (base=${wantBase}). ` +
        `Refusing unregistered fallback. Matches: ${langMatch.map(describe).join(', ') || '(none)'}`,
    );
  }
  // Exact locale first (en-US, es-AR). Else bare `en`/`es`/`de` for ROAR/TROG.
  // Never fall through to a sibling region (en-GB for en-US, es-CO for es-AR).
  const registeredExact = registered.filter((d) => langOf(d) === want);
  const registeredBare = registered.filter((d) => langOf(d) === wantBase);
  const pool = registeredExact.length
    ? registeredExact
    : registeredBare.length
      ? registeredBare
      : registered;
  const sorted = [...pool].sort((a, b) => score(b) - score(a));
  return sorted[0] ?? null;
}

function sanitizeWrittenParams(params) {
  const out = { ...params };
  // Runtime-only flags: writing these into assignment params makes
  // updateTaskParams hit permission-denied on admin-dev (PA / SWR).
  delete out.isAdaptive;
  delete out.userMode;
  if (Object.prototype.hasOwnProperty.call(out, 'language')) {
    out.language = canonicalizeLanguageTag(out.language);
  }
  return out;
}

async function buildAssessment(
  db,
  taskId,
  languageCode,
  paramOverrides = {},
  preferUserMode = '',
  variantId = '',
  snapshot = null,
) {
  const taskDoc = await db.collection('tasks').doc(taskId).get();
  if (!taskDoc.exists) throw new Error(`Task "${taskId}" not found on dev`);

  // Replay a pack that lives on -prod (or was deleted from the -dev catalog)
  // by writing the snapshot params onto the assignment. Firekit starts from
  // those stored params; we do not clone the variant doc onto -dev.
  if (snapshot && snapshot.params && typeof snapshot.params === 'object') {
    const params = sanitizeWrittenParams({ ...snapshot.params, ...paramOverrides });
    const id = String(variantId || snapshot.id || '').trim() || 'snapshot';
    return {
      taskId,
      variantId: id,
      variantName: snapshot.name ?? languageCode,
      params,
    };
  }

  const variants = await db.collection('tasks').doc(taskId).collection('variants').get();
  if (variants.empty) throw new Error(`Task "${taskId}" has no variants`);
  const wantId = String(variantId || '').trim();
  const pick = wantId
    ? variants.docs.find((d) => d.id === wantId)
    : pickVariant(variants.docs, languageCode, preferUserMode);
  if (wantId && !pick) {
    throw new Error(`Task "${taskId}" has no variant "${wantId}"`);
  }
  if (!pick) throw new Error(`Task "${taskId}" has no usable variant for ${languageCode}`);
  const data = pick.data() ?? {};
  const baseParams = data.params ?? {};
  // Do not inject lng/language here: Firekit updateTaskParams rejects unknown keys and
  // startTask fails. Correct language comes from picking the matching variant
  // (DE has language:"de"; EN name "en" with language null → roar-swr defaultToEnglish).
  const params = sanitizeWrittenParams({
    ...baseParams,
    ...paramOverrides,
  });
  return {
    taskId,
    variantId: pick.id,
    variantName: data.name ?? languageCode,
    params,
  };
}

async function createParticipant(db, { districtId, siteName, email, password, birthYear, birthMonth }) {
  const auth = getAuth();
  let user;
  try {
    user = await auth.createUser({
      email,
      password,
      displayName: `QA ${email.split('@')[0]}`,
      emailVerified: true,
    });
  } catch (err) {
    // Recollects reuse deterministic qa-<runId> emails; reset the Auth user + continue.
    if (err?.code !== 'auth/email-already-exists') throw err;
    const existing = await auth.getUserByEmail(email);
    await auth.deleteUser(existing.uid);
    try {
      await db.collection('users').doc(existing.uid).delete();
    } catch {
      /* best-effort */
    }
    try {
      await db.collection('userClaims').doc(existing.uid).delete();
    } catch {
      /* best-effort */
    }
    console.log(`[qa-provision] recycled existing auth user for ${email}`);
    user = await auth.createUser({
      email,
      password,
      displayName: `QA ${email.split('@')[0]}`,
      emailVerified: true,
    });
  }
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
  const isProd = projectId === 'hs-levante-admin-prod';
  if (!args.force && !isDev) {
    throw new Error('Refusing to run outside DEV. Set VITE_FIREBASE_PROJECT=DEV or --project-id hs-levante-admin-dev (or --force).');
  }
  if (isProd) {
    if (SITE_NAME !== 'qa-tests') {
      throw new Error('Prod writes are limited to site qa-tests.');
    }
    const credPath = String(args.credential || '');
    if (/admin-dev/i.test(credPath)) {
      throw new Error(
        'Refusing prod write with a -dev service-account path. Unset LEVANTE_ADMIN_FIREBASE_CREDENTIALS and use ADC, or pass a prod admin SA.',
      );
    }
  }

  const credential = await getCredentials(args.credential);
  initializeApp({ projectId, credential });
  const db = getFirestore();

  const runSlug = String(args.runId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || crypto.randomBytes(4).toString('hex');
  const email = `qa-${runSlug}@levante.test`;
  const password = `Qa-${crypto.randomBytes(12).toString('base64url')}`;
  const { birthYear, birthMonth } = birthFromAge(args.ageYears, args.ageMonths);

  const districtId = await getOrCreateDistrict(db, SITE_NAME);
  // Env / --param isAdaptive is a *runtime* Cypress flag (QA_PA_IS_ADAPTIVE), not
  // a Firestore variantParam. Writing isAdaptive into assignment params makes
  // roar-pa updateTaskParams hit FirebaseError permission-denied on admin-dev.
  const envAdaptive = process.env.QA_PA_IS_ADAPTIVE;
  if (
    envAdaptive !== undefined &&
    envAdaptive !== '' &&
    args.paramOverrides.isAdaptive === undefined
  ) {
    const v = String(envAdaptive).trim().toLowerCase();
    if (v === 'true' || v === '1' || v === 'yes') args.paramOverrides.isAdaptive = true;
  }
  const wantAdaptive = args.paramOverrides.isAdaptive === true;
  if ('isAdaptive' in args.paramOverrides) {
    delete args.paramOverrides.isAdaptive;
  }
  if (wantAdaptive) {
    console.log(
      '[qa-provision] isAdaptive requested — not written to Firestore ' +
        '(permission-denied on updateTaskParams). Run Cypress with QA_PA_IS_ADAPTIVE=true.',
    );
  }
  // Same for SWR userMode (adaptiveTimingMultiStage, etc.): inject at runtime via
  // QA_SWR_USER_MODE + swrUserModeBridge (userParams), not gameParams / Firestore.
  const envSwrMode = process.env.QA_SWR_USER_MODE;
  if (
    envSwrMode !== undefined &&
    String(envSwrMode).trim() !== '' &&
    args.paramOverrides.userMode === undefined
  ) {
    args.paramOverrides.userMode = String(envSwrMode).trim();
  }
  const wantSwrUserMode =
    typeof args.paramOverrides.userMode === 'string'
      ? String(args.paramOverrides.userMode).trim()
      : '';
  if ('userMode' in args.paramOverrides) {
    delete args.paramOverrides.userMode;
  }
  if (wantSwrUserMode) {
    console.log(
      `[qa-provision] userMode=${wantSwrUserMode} requested — not written to Firestore ` +
        '(updateTaskParams / gameParams). Run Cypress with ' +
        `QA_SWR_USER_MODE=${wantSwrUserMode}.`,
    );
  }
  let snapshot = null;
  if (args.paramsJson) {
    try {
      const parsed = JSON.parse(args.paramsJson);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('expected a JSON object');
      }
      snapshot = {
        id: args.variantId,
        name: args.variantName,
        params: parsed,
      };
    } catch (err) {
      throw new Error(`Invalid --params-json: ${err?.message || err}`);
    }
  }
  const assessment = await buildAssessment(
    db,
    args.task,
    args.language,
    args.paramOverrides,
    wantSwrUserMode,
    args.variantId,
    snapshot,
  );
  // Do not mutate numAdaptive here. English shortRandom variants ship 150.
  // Deleting the key or writing 84 makes the dashboard fail to start the task
  // (updateTaskParams / roar-swr validation). ATM therefore inherits 150 until
  // a Firestore-safe cap exists.
  if (Object.keys(args.paramOverrides).length) {
    console.log(`[qa-provision] param overrides: ${JSON.stringify(args.paramOverrides)}`);
  }
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

  const result = {
    email: participant.email,
    password: participant.password,
    uid: participant.uid,
    variantId: assessment.variantId,
    variantName: assessment.variantName,
    language: assessment.params?.language ?? args.language,
    userMode: assessment.params?.userMode ?? null,
    numAdaptive: assessment.params?.numAdaptive ?? null,
  };
  console.log(`PROVISION_RESULT=${JSON.stringify(result)}`);
}

main().catch((err) => {
  console.error(`[qa-provision] ERROR: ${err?.stack || err?.message || err}`);
  process.exit(1);
});
