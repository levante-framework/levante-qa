/**
 * Kuperman et al. (2012) AoA helpers for SWR offline / blend.
 */
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const AOA_CSV_DEFAULT = join(HERE, '..', 'data', 'aoa_kuperman.csv');

let cache = null;

function parseCSV(text) {
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  const split = (line) => {
    const out = [];
    let cur = '';
    let q = false;
    for (const ch of line) {
      if (ch === '"') {
        q = !q;
        continue;
      }
      if (ch === ',' && !q) {
        out.push(cur);
        cur = '';
        continue;
      }
      cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const hdr = split(lines[0]);
  return lines.slice(1).filter(Boolean).map((line) => {
    const cols = split(line);
    const o = {};
    hdr.forEach((h, i) => {
      o[h] = cols[i] ?? '';
    });
    return o;
  });
}

export function loadAoaMap(path = AOA_CSV_DEFAULT) {
  if (cache && cache.path === path) return cache.map;
  if (!existsSync(path)) throw new Error(`AoA CSV missing: ${path}`);
  const map = new Map();
  for (const r of parseCSV(readFileSync(path, 'utf8'))) {
    const w = String(r.word || r.Word || '')
      .trim()
      .toLowerCase();
    const aoa = parseFloat(r.aoa || r.AoA_Kup || '');
    if (!w || !Number.isFinite(aoa)) continue;
    map.set(w, aoa);
  }
  cache = { path, map };
  return map;
}

export function lookupAoa(word, path = AOA_CSV_DEFAULT) {
  const w = String(word || '')
    .trim()
    .toLowerCase();
  if (!w) return null;
  const map = loadAoaMap(path);
  return map.has(w) ? map.get(w) : null;
}

/** Soft P(child knows word) from AoA vs persona age. */
export function pKnowFromAoa(aoa, ageYears, scale = 1.5) {
  if (!Number.isFinite(aoa) || !Number.isFinite(ageYears)) return null;
  return 1 / (1 + Math.exp(-(ageYears - aoa) / scale));
}

export function logit(p) {
  const x = Math.min(1 - 1e-6, Math.max(1e-6, p));
  return Math.log(x / (1 - x));
}

export function zFromP(p, c = 0.5) {
  const adj = Math.min(1 - 1e-3, Math.max(1e-3, (p - c) / (1 - c)));
  return logit(adj);
}

export function bProxyFromP(p) {
  return -zFromP(p);
}

/**
 * Blend VLM p_child with AoA p_know on reals when AoA exists.
 * Pseudos / missing AoA → VLM only.
 * @param {number} wAoa weight on AoA in [0,1]
 */
export function blendPChild({ pVlm, aoa, ageYears, rp, wAoa }) {
  if (!Number.isFinite(pVlm)) return null;
  const isReal = String(rp || '').toLowerCase() === 'real';
  if (!isReal || !Number.isFinite(aoa) || !Number.isFinite(ageYears) || !(wAoa > 0)) {
    return pVlm;
  }
  const pAoa = pKnowFromAoa(aoa, ageYears);
  if (!Number.isFinite(pAoa)) return pVlm;
  const w = Math.min(1, Math.max(0, wAoa));
  return w * pAoa + (1 - w) * pVlm;
}
