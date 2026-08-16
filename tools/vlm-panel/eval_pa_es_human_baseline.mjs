#!/usr/bin/env node
/**
 * Bogotá (es-CO) ROAR-PA human item difficulty + ES corpus join.
 *
 *   node tools/vlm-panel/eval_pa_es_human_baseline.mjs
 */
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  PA_TRIALS,
  BOGOTA_SITE,
  MIN_N,
  bFromP,
  loadEsCorpus,
  joinCorpus,
  parseCSV,
  parseItemUid,
  writeCsv,
} from './lib/paEs.mjs';
import { readFileSync } from 'fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');

function main() {
  mkdirSync(OUT, { recursive: true });
  const corpus = loadEsCorpus();
  const trials = parseCSV(readFileSync(PA_TRIALS, 'utf8')).filter(
    (r) => r.task_id === 'pa' && r.site === BOGOTA_SITE,
  );

  const by = new Map();
  for (const t of trials) {
    const uid = String(t.item_uid || '').trim();
    const parsed = parseItemUid(uid);
    if (!parsed) continue;
    let row = by.get(uid);
    if (!row) {
      row = { item_uid: uid, subtype: parsed.subtype, word: parsed.word, n: 0, n_correct: 0, runs: new Set() };
      by.set(uid, row);
    }
    row.n += 1;
    if (String(t.correct).toUpperCase() === 'TRUE') row.n_correct += 1;
    if (t.run_id) row.runs.add(t.run_id);
  }

  const items = [...by.values()]
    .map((r) => {
      const p = r.n ? r.n_correct / r.n : null;
      const corp = joinCorpus(r.word, r.subtype, corpus);
      return {
        item_uid: r.item_uid,
        subtype: r.subtype,
        word: r.word,
        n: r.n,
        n_runs: r.runs.size,
        n_correct: r.n_correct,
        p_correct: p != null ? +p.toFixed(4) : '',
        b_human: p != null ? +bFromP(p).toFixed(4) : '',
        enough: r.n >= MIN_N ? 1 : 0,
        joined: corp ? 1 : 0,
        stim: corp?.stim ?? '',
        goal: corp?.goal ?? '',
        foil1: corp?.foil1 ?? '',
        foil2: corp?.foil2 ?? '',
      };
    })
    .sort((a, b) => a.subtype.localeCompare(b.subtype) || a.word.localeCompare(b.word));

  writeCsv(join(OUT, 'pa_es_human_baseline.csv'), items, [
    'item_uid',
    'subtype',
    'word',
    'n',
    'n_runs',
    'n_correct',
    'p_correct',
    'b_human',
    'enough',
    'joined',
    'stim',
    'goal',
    'foil1',
    'foil2',
  ]);

  const nItems = items.length;
  const nEnough = items.filter((i) => i.enough).length;
  const nJoined = items.filter((i) => i.joined).length;
  const ns = items.map((i) => i.n).sort((a, b) => a - b);
  const med = ns[Math.floor((ns.length - 1) / 2)] ?? 0;
  const corpusOrphan = corpus.filter((c) => {
    const g = items.find(
      (i) => i.subtype === c.subtype && (i.goal === c.goal || i.stim === c.stim || i.word === c.goal || i.word === c.stim),
    );
    return !g;
  });

  const report = `# PA ES human baseline (Bogotá)

**Date:** ${new Date().toISOString().slice(0, 10)}  
**Source:** \`levante-bench/data/responses/v2/tasks/pa_trials.csv\` · site=\`${BOGOTA_SITE}\`  
**Corpus:** roar-pa \`es/test.csv\` (${corpus.length} test items)

## Coverage

| Metric | Value |
|--------|------:|
| Human items | ${nItems} |
| Trials | ${trials.length} |
| Runs | ${new Set(trials.map((t) => t.run_id)).size} |
| n per item min / median / max | ${ns[0] ?? 0} / ${med} / ${ns[ns.length - 1] ?? 0} |
| Items with n≥${MIN_N} | **${nEnough}/${nItems}** |
| Joined to ES corpus | **${nJoined}/${nItems}** |
| Corpus rows unmatched | ${corpusOrphan.length} |

**Enough data:** ${nEnough === nItems && nItems > 0 ? '**GO** — all items meet n≥' + MIN_N : '**GAPS** — some items below n≥' + MIN_N}.

CSV: \`out/pa_es_human_baseline.csv\`
`;

  writeFileSync(join(OUT, 'REPORT_pa_es_human_baseline.md'), report);
  console.log(
    JSON.stringify(
      {
        nItems,
        nTrials: trials.length,
        nEnough,
        nJoined,
        nMin: ns[0],
        nMedian: med,
        corpusOrphan: corpusOrphan.length,
        report: 'tools/vlm-panel/out/REPORT_pa_es_human_baseline.md',
      },
      null,
      2,
    ),
  );
}

main();
