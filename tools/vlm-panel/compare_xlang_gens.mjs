#!/usr/bin/env node
/**
 * Compare two review_xlang_*.csv files (baseline vs current).
 * Reports strong_delta overlap / reshuffle — the limited 3.x vs 2.5 question.
 *
 *   node tools/vlm-panel/compare_xlang_gens.mjs \
 *     --baseline out/review_xlang_de_25.csv \
 *     --current out/review_xlang_de.csv
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArg(argv, name) {
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === `--${name}`) return argv[i + 1];
    if (argv[i].startsWith(`--${name}=`)) return argv[i].slice(name.length + 3);
  }
  return null;
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length) return [];
  const headers = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cols = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        q = !q;
        continue;
      }
      if (c === ',' && !q) {
        cols.push(cur);
        cur = '';
        continue;
      }
      cur += c;
    }
    cols.push(cur);
    const row = {};
    headers.forEach((h, i) => {
      row[h] = cols[i] ?? '';
    });
    return row;
  });
}

function strongSet(rows) {
  return new Set(
    rows
      .filter((r) => String(r.strong_delta || '').toLowerCase() === 'yes')
      .map((r) => r.item_uid)
      .filter(Boolean),
  );
}

function main() {
  const baselineRel = parseArg(process.argv, 'baseline') || 'out/review_xlang_de_25.csv';
  const currentRel = parseArg(process.argv, 'current') || 'out/review_xlang_de.csv';
  const baselinePath = join(HERE, baselineRel);
  const currentPath = join(HERE, currentRel);
  if (!existsSync(baselinePath) || !existsSync(currentPath)) {
    console.error(`Missing files:\n  ${baselinePath}\n  ${currentPath}`);
    process.exit(2);
  }
  const base = parseCsv(readFileSync(baselinePath, 'utf8'));
  const cur = parseCsv(readFileSync(currentPath, 'utf8'));
  const bStrong = strongSet(base);
  const cStrong = strongSet(cur);
  const both = [...bStrong].filter((x) => cStrong.has(x));
  const onlyBase = [...bStrong].filter((x) => !cStrong.has(x));
  const onlyCur = [...cStrong].filter((x) => !bStrong.has(x));
  const union = new Set([...bStrong, ...cStrong]);
  const jaccard = union.size ? both.length / union.size : 1;

  const byUid = new Map(cur.map((r) => [r.item_uid, r]));
  const deltaPairs = [];
  for (const r of base) {
    const c = byUid.get(r.item_uid);
    if (!c) continue;
    const db = Number(r.delta);
    const dc = Number(c.delta);
    if (!Number.isFinite(db) || !Number.isFinite(dc)) continue;
    deltaPairs.push({ item_uid: r.item_uid, delta_25: db, delta_3x: dc, abs_shift: Math.abs(dc - db) });
  }
  deltaPairs.sort((a, b) => b.abs_shift - a.abs_shift);

  const report = {
    baseline: baselineRel,
    current: currentRel,
    n_baseline_strong: bStrong.size,
    n_current_strong: cStrong.size,
    n_overlap: both.length,
    n_only_baseline: onlyBase.length,
    n_only_current: onlyCur.length,
    jaccard_strong: +jaccard.toFixed(3),
    only_baseline: onlyBase.sort(),
    only_current: onlyCur.sort(),
    overlap: both.sort(),
    top_delta_shifts: deltaPairs.slice(0, 15),
  };

  const outJson = join(HERE, 'out', 'xlang_gen_compare_de.json');
  const outMd = join(HERE, 'out', 'xlang_gen_compare_de.md');
  writeFileSync(outJson, JSON.stringify(report, null, 2) + '\n');

  const verdict =
    jaccard >= 0.6
      ? 'Mostly same review queue (3.x ≈ 2.5 triage).'
      : jaccard >= 0.3
        ? 'Partial reshuffle — spot-check only_current / only_baseline.'
        : 'Large reshuffle — do not treat 2.5 triage as transferable to 3.x.';

  const md = [
    `# 3.x vs 2.5 xlang Δ compare (DE)`,
    '',
    `- Baseline: \`${baselineRel}\` (strong=${bStrong.size})`,
    `- Current: \`${currentRel}\` (strong=${cStrong.size})`,
    `- Overlap: **${both.length}** | only 2.5: **${onlyBase.length}** | only 3.x: **${onlyCur.length}**`,
    `- Jaccard(strong_delta): **${jaccard.toFixed(3)}**`,
    '',
    `**Verdict:** ${verdict}`,
    '',
    '## Only in 2.5 strong_delta',
    ...(onlyBase.length ? onlyBase.map((x) => `- ${x}`) : ['- (none)']),
    '',
    '## Only in 3.x strong_delta',
    ...(onlyCur.length ? onlyCur.map((x) => `- ${x}`) : ['- (none)']),
    '',
    '## Largest |Δ_3x − Δ_25| shifts',
    '| item_uid | Δ_25 | Δ_3x | |shift| |',
    '|---|---:|---:|---:|',
    ...deltaPairs
      .slice(0, 15)
      .map(
        (r) =>
          `| ${r.item_uid} | ${r.delta_25.toFixed(3)} | ${r.delta_3x.toFixed(3)} | ${r.abs_shift.toFixed(3)} |`,
      ),
    '',
  ];
  writeFileSync(outMd, md.join('\n'));
  console.log(md.join('\n'));
  console.log(`Wrote ${outMd}`);
}

main();
