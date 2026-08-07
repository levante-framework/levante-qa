/**
 * Live panel run status — single JSON + append-only log for off-screen runs.
 *
 *   cat tools/vlm-panel/out/status.json
 *   tail -f tools/vlm-panel/out/status.log
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const OUT_DIR = join(HERE, 'out');
export const STATUS_PATH = join(OUT_DIR, 'status.json');
export const STATUS_LOG = join(OUT_DIR, 'status.log');

export function readStatus() {
  if (!existsSync(STATUS_PATH)) return null;
  try {
    return JSON.parse(readFileSync(STATUS_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

export function writeStatus(patch) {
  mkdirSync(OUT_DIR, { recursive: true });
  const prev = readStatus() || {};
  const next = {
    ...prev,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(STATUS_PATH, JSON.stringify(next, null, 2) + '\n');
  const bits = [
    next.phase && `[${next.phase}]`,
    next.runId,
    next.message,
    next.itemsCaptured != null && `captured=${next.itemsCaptured}`,
    next.item != null && next.itemsTotal != null && `item=${next.item}/${next.itemsTotal}`,
    next.cell != null && next.cellsTotal != null && `cell=${next.cell}/${next.cellsTotal}`,
    next.lastTranscript && `"${String(next.lastTranscript).slice(0, 60)}"`,
    next.elapsedSec != null && `${next.elapsedSec}s`,
  ].filter(Boolean);
  appendFileSync(STATUS_LOG, `${next.updatedAt}  ${bits.join(' ')}\n`);
  return next;
}

export function formatStatusLine(s) {
  if (!s) return '(no status yet)';
  const bits = [
    s.phase && `[${s.phase}]`,
    s.message,
    s.itemsCaptured != null && `captured=${s.itemsCaptured}`,
    s.item != null && s.itemsTotal != null && `item ${s.item}/${s.itemsTotal}`,
    s.cell != null && s.cellsTotal != null && `cell ${s.cell}/${s.cellsTotal}`,
    s.lastTranscript && `"${String(s.lastTranscript).slice(0, 50)}"`,
    s.elapsedSec != null && `${s.elapsedSec}s`,
  ].filter(Boolean);
  return bits.join(' ') || JSON.stringify(s);
}

export function printWatchHint() {
  console.log(`  status: ${STATUS_PATH.replace(/\\/g, '/')}`);
  console.log(`  log:    tail -f ${STATUS_LOG.replace(/\\/g, '/')}`);
}
