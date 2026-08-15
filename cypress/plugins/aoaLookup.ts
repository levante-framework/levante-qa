/**
 * Kuperman AoA lookup for Cypress tasks (cached).
 * Data: tools/vlm-panel/data/aoa_kuperman.csv
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const AOA_PATH = join(process.cwd(), 'tools', 'vlm-panel', 'data', 'aoa_kuperman.csv');

let map: Map<string, number> | null = null;

function load(): Map<string, number> {
  if (map) return map;
  map = new Map();
  if (!existsSync(AOA_PATH)) return map;
  const lines = readFileSync(AOA_PATH, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const comma = line.indexOf(',');
    if (comma < 0) continue;
    const word = line.slice(0, comma).trim().toLowerCase();
    const aoa = Number(line.slice(comma + 1).trim());
    if (word && Number.isFinite(aoa)) map.set(word, aoa);
  }
  return map;
}

/** Returns AoA years or null if unknown. */
export function lookupAoaYears(word: string | null | undefined): number | null {
  const w = String(word ?? '')
    .trim()
    .toLowerCase();
  if (!w) return null;
  const m = load();
  return m.has(w) ? (m.get(w) as number) : null;
}
