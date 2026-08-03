#!/usr/bin/env node
/**
 * Aggregate per-call Gemini usage jsonl under out/usage/ into a summary table.
 *
 *   node tools/vlm-panel/aggregate_usage.mjs
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const USAGE_DIR = join(HERE, 'out', 'usage');
const OUT_JSON = join(HERE, 'out', 'usage_summary.json');
const OUT_MD = join(HERE, 'out', 'usage_summary.md');

function main() {
  if (!existsSync(USAGE_DIR)) {
    console.log(`No usage dir at ${USAGE_DIR}`);
    process.exit(0);
  }
  const byModel = {};
  const byRun = {};
  let calls = 0;
  for (const name of readdirSync(USAGE_DIR).filter((f) => f.endsWith('.jsonl'))) {
    const runId = name.replace(/\.jsonl$/, '');
    const text = readFileSync(join(USAGE_DIR, name), 'utf8');
    for (const line of text.split(/\n/).filter(Boolean)) {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      calls += 1;
      const model = row.model || 'unknown';
      const u = row.usage || {};
      const total = Number(u.totalTokenCount) || 0;
      const prompt = Number(u.promptTokenCount) || 0;
      const cand = Number(u.candidatesTokenCount) || 0;
      const thoughts = Number(u.thoughtsTokenCount) || 0;
      const m = (byModel[model] ??= { calls: 0, totalTokenCount: 0, promptTokenCount: 0, candidatesTokenCount: 0, thoughtsTokenCount: 0 });
      m.calls += 1;
      m.totalTokenCount += total;
      m.promptTokenCount += prompt;
      m.candidatesTokenCount += cand;
      m.thoughtsTokenCount += thoughts;
      const r = (byRun[runId] ??= { calls: 0, totalTokenCount: 0, model });
      r.calls += 1;
      r.totalTokenCount += total;
      if (row.model) r.model = row.model;
    }
  }
  const summary = { calls, byModel, byRun };
  writeFileSync(OUT_JSON, JSON.stringify(summary, null, 2) + '\n');
  const md = [
    '# VLM usage summary',
    '',
    `- Calls: **${calls}**`,
    '',
    '| model | calls | total | prompt | candidates | thoughts |',
    '|---|---:|---:|---:|---:|---:|',
    ...Object.entries(byModel)
      .sort((a, b) => b[1].totalTokenCount - a[1].totalTokenCount)
      .map(
        ([model, m]) =>
          `| ${model} | ${m.calls} | ${m.totalTokenCount} | ${m.promptTokenCount} | ${m.candidatesTokenCount} | ${m.thoughtsTokenCount} |`,
      ),
    '',
  ];
  writeFileSync(OUT_MD, md.join('\n'));
  console.log(`Wrote ${OUT_MD} (${calls} calls)`);
}

main();
