/**
 * Shared helpers for TROG panel asset capture + offline replay.
 * Assets live under tools/vlm-panel/assets/trog/<langToken>/.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export function assetDirFor(langToken) {
  return join(HERE, 'assets', 'trog', String(langToken).toLowerCase());
}

export function indexPath(dir) {
  return join(dir, 'index.json');
}

export function loadIndex(dir) {
  const p = indexPath(dir);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf-8'));
}

export function hasAssets(langToken) {
  const idx = loadIndex(assetDirFor(langToken));
  return !!(idx?.items?.length);
}

export function ensureAssetDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write/replace full index (capture finalize). */
export function writeIndex(dir, index) {
  ensureAssetDir(dir);
  writeFileSync(indexPath(dir), JSON.stringify(index, null, 2) + '\n');
}

export function pngPath(dir, assetId) {
  return join(dir, `${assetId}.png`);
}

export function savePngBase64(dir, assetId, pngBase64) {
  ensureAssetDir(dir);
  writeFileSync(pngPath(dir, assetId), Buffer.from(pngBase64, 'base64'));
}

export function readPngBase64(dir, assetId) {
  return readFileSync(pngPath(dir, assetId)).toString('base64');
}

export function padStep(step) {
  return String(step).padStart(4, '0');
}
