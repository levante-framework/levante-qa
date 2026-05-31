/**
 * Durable run-data persistence to Google Cloud Storage.
 *
 * The dashboard mirrors its run history (and small per-run JSONL artifacts) to a
 * GCS bucket so results survive server restarts and are shared across machines.
 * Defaults to gs://levante-tools/levante-qa/ — the same "tools" bucket that
 * already hosts pitwall/ and test-results/.
 *
 * Everything degrades gracefully: if the bucket is unreachable, credentials are
 * missing, or the @google-cloud/storage package isn't installed, the dashboard
 * keeps working with its local results/runs.json and just logs a warning.
 *
 * Configuration (all optional):
 *   QA_GCS_BUCKET   bucket name              (default: levante-tools)
 *   QA_GCS_PREFIX   object key prefix        (default: levante-qa)
 *   QA_GCS_DISABLE  set to any value to turn off GCS entirely
 *   QA_GCS_PROJECT  GCP project id           (else inferred from creds/ADC)
 *   Auth: GCP_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS_JSON
 *         (inline JSON), or GOOGLE_APPLICATION_CREDENTIALS (path), or ADC
 *         (e.g. `gcloud auth application-default login`).
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const BUCKET = process.env.QA_GCS_BUCKET || 'levante-tools';
const PREFIX = (process.env.QA_GCS_PREFIX || 'levante-qa').replace(/\/+$/, '');
const DISABLED = !!process.env.QA_GCS_DISABLE;
const INDEX_OBJECT = `${PREFIX}/runs.json`;

let bucketPromise; // memoized bucket handle (or null if unavailable)
let warned = false;

function warnOnce(msg) {
  if (warned) return;
  warned = true;
  console.warn(`[gcs] ${msg} — falling back to local-only run history.`);
}

async function getBucket() {
  if (DISABLED) return null;
  if (bucketPromise !== undefined) return bucketPromise;
  bucketPromise = (async () => {
    try {
      const { Storage } = await import('@google-cloud/storage');
      const raw =
        process.env.GCP_SERVICE_ACCOUNT_JSON ||
        process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
      let storage;
      if (raw) {
        const credentials = JSON.parse(raw);
        storage = new Storage({
          credentials,
          projectId: process.env.QA_GCS_PROJECT || credentials.project_id,
        });
      } else {
        // Application Default Credentials (gcloud login / GOOGLE_APPLICATION_CREDENTIALS path).
        storage = new Storage(
          process.env.QA_GCS_PROJECT ? { projectId: process.env.QA_GCS_PROJECT } : {},
        );
      }
      return storage.bucket(BUCKET);
    } catch (err) {
      warnOnce(`could not initialize storage client: ${err?.message || err}`);
      return null;
    }
  })();
  return bucketPromise;
}

export function gcsTarget() {
  return DISABLED ? null : `gs://${BUCKET}/${PREFIX}`;
}

/** Reads the canonical run index from GCS. Returns an array (possibly empty). */
export async function downloadIndex() {
  const bucket = await getBucket();
  if (!bucket) return [];
  try {
    const [buf] = await bucket.file(INDEX_OBJECT).download();
    const parsed = JSON.parse(buf.toString('utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    // 404 simply means nothing uploaded yet.
    if (err && (err.code === 404 || err.code === '404')) return [];
    warnOnce(`could not read ${INDEX_OBJECT}: ${err?.message || err}`);
    return [];
  }
}

/** Overwrites the canonical run index in GCS with `list`. */
export async function uploadIndex(list) {
  const bucket = await getBucket();
  if (!bucket) return false;
  try {
    await bucket.file(INDEX_OBJECT).save(JSON.stringify(list, null, 2) + '\n', {
      contentType: 'application/json',
      resumable: false,
    });
    return true;
  } catch (err) {
    warnOnce(`could not write ${INDEX_OBJECT}: ${err?.message || err}`);
    return false;
  }
}

/**
 * Uploads the small JSONL artifacts (trial archive, diagnostic + persona logs)
 * from a run's scoped local log dir to gs://.../levante-qa/runs/<runId>/.
 * Screenshots and other large binaries are intentionally skipped.
 */
export async function uploadRunArtifacts(runId, localDir) {
  const bucket = await getBucket();
  if (!bucket) return 0;
  let names = [];
  try {
    names = await readdir(localDir);
  } catch {
    return 0;
  }
  let uploaded = 0;
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    try {
      const body = await readFile(join(localDir, name));
      await bucket.file(`${PREFIX}/runs/${runId}/${name}`).save(body, {
        contentType: 'application/x-ndjson',
        resumable: false,
      });
      uploaded += 1;
    } catch (err) {
      warnOnce(`could not upload artifact ${name}: ${err?.message || err}`);
    }
  }
  return uploaded;
}

/** Union of two run lists keyed by runId, newest-finished entry wins. */
export function mergeIndexes(a = [], b = []) {
  const byId = new Map();
  for (const rec of [...a, ...b]) {
    if (!rec || !rec.runId) continue;
    const prev = byId.get(rec.runId);
    if (!prev) {
      byId.set(rec.runId, rec);
      continue;
    }
    const t = (r) => new Date(r.finishedAt || r.startedAt || 0).getTime();
    byId.set(rec.runId, t(rec) >= t(prev) ? rec : prev);
  }
  return [...byId.values()];
}
