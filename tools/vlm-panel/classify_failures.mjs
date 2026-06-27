#!/usr/bin/env node
/**
 * VLM panel failure triage — separate "tool/Google noise" from "product/-dev
 * signal" so a panel's results can be trusted (or marked inconclusive) before
 * anyone reads difficulty/translation numbers off it.
 *
 * Every panel respondent (see run_panel.mjs) records its outcome in
 * out/manifest.json with a `status` and a `logFile`. A `failed` run is almost
 * always one of three things:
 *   - TOOL  : the model API (429/5xx/UNAVAILABLE/overloaded, askVLM timeout).
 *             Tells you about Google, NOT about -dev. Re-run later.
 *   - DEV   : the app / -dev itself (boot stall on the launcher splash, audio
 *             language mismatch, decode failure, dashboard unreachable). THIS is
 *             the readiness signal.
 *   - UNKNOWN: no recognizable signature — inspect the log.
 *
 * Verdict rule: if the TOOL-failure rate is high the panel is INCONCLUSIVE for
 * content (Google ate too much of it); any DEV failure is a readiness red flag.
 *
 * Usage:
 *   node tools/vlm-panel/classify_failures.mjs                 # all runs
 *   node tools/vlm-panel/classify_failures.mjs --task vocab --lang en
 *   node tools/vlm-panel/classify_failures.mjs --manifest path/to/manifest.json
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const DEFAULT_MANIFEST = join(HERE, 'out', 'manifest.json');

/** Fraction of TOOL failures (of all runs in scope) above which a panel is
 *  considered inconclusive for content interpretation. Override with env. */
export const TOOL_INCONCLUSIVE_RATE = Math.max(
  0,
  Number(process.env.VLM_TOOL_INCONCLUSIVE_RATE ?? 0.1),
);

/**
 * Classify a single failed run from its log text. DEV signatures are checked
 * first (they are specific and never co-occur with a mid-run API error), then
 * the broad TOOL signatures, then unknown.
 * @returns {{ bucket: 'tool'|'dev'|'unknown', reason: string }}
 */
export function classifyFailureLog(text) {
  const t = String(text || '');
  // --- DEV / -dev / app ---
  if (/Expected to find content: 'OK' but never did/.test(t)) {
    return { bucket: 'dev', reason: 'boot stall (task never mounted off splash)' };
  }
  if (/Audio language mismatch|readMp3Tags/i.test(t)) {
    return { bucket: 'dev', reason: 'audio language mismatch / missing narration' };
  }
  if (/decodeAudioData|could not be decoded/i.test(t)) {
    return { bucket: 'dev', reason: 'audio decode failure' };
  }
  if (/ECONNREFUSED|localhost:4180|dashboard (unreachable|not reachable)/i.test(t)) {
    return { bucket: 'dev', reason: 'dashboard/-dev unreachable' };
  }
  if (/Timed out retrying after \d+ms: Expected to find content/.test(t)) {
    return { bucket: 'dev', reason: 'app never reached expected screen' };
  }
  // --- TOOL / model API (Google) ---
  // The Cypress error wraps the call in backticks (`cy.task('askVLM')` timed
  // out …), so match the two tokens loosely rather than as one literal.
  if (/askVLM/.test(t) && /timed out/i.test(t)) {
    return { bucket: 'tool', reason: 'askVLM model call timed out' };
  }
  if (
    /\b(429|500|502|503|504)\b/.test(t) ||
    /UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|overloaded|deadline|INTERNAL/i.test(t)
  ) {
    return { bucket: 'tool', reason: 'model overloaded / transient API error' };
  }
  if (/ETIMEDOUT|ECONNRESET|socket hang up|fetch failed|ENOTFOUND/i.test(t)) {
    return { bucket: 'tool', reason: 'network error to model API' };
  }
  return { bucket: 'unknown', reason: 'no recognizable error signature' };
}

function resolveLogPath(logFile) {
  if (!logFile) return null;
  return isAbsolute(logFile) ? logFile : join(REPO, logFile);
}

/**
 * Read a manifest, classify every failed run, and return a structured summary.
 * @param {string} manifestPath
 * @param {{ task?: string, langs?: string[] }} [filter]
 */
export function summarizeFailures(manifestPath = DEFAULT_MANIFEST, filter = {}) {
  const empty = {
    ok: false,
    total: 0,
    done: 0,
    failed: 0,
    buckets: { tool: 0, dev: 0, unknown: 0 },
    toolRate: 0,
    devFailures: 0,
    inconclusive: false,
    details: [],
  };
  if (!existsSync(manifestPath)) return { ...empty, error: `manifest not found: ${manifestPath}` };

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    return { ...empty, error: `manifest parse failed: ${err?.message || err}` };
  }
  let runs = manifest.respondents || manifest.runs || (Array.isArray(manifest) ? manifest : []);

  const wantLangs = Array.isArray(filter.langs) && filter.langs.length ? new Set(filter.langs) : null;
  runs = runs.filter((r) => {
    if (filter.task && r.task !== filter.task) return false;
    if (wantLangs && !wantLangs.has(r.language)) return false;
    return true;
  });

  const buckets = { tool: 0, dev: 0, unknown: 0 };
  const byTaskLang = {};
  const details = [];
  let done = 0;
  let failed = 0;

  for (const r of runs) {
    const status = r.status || r.state;
    const isDone = status === 'done' || status === 'complete';
    if (isDone) {
      done += 1;
      continue;
    }
    if (!status || status === 'running' || status === 'provisioning') continue; // in-flight: ignore
    failed += 1;
    let text = '';
    const p = resolveLogPath(r.logFile);
    if (p && existsSync(p)) {
      try {
        text = readFileSync(p, 'utf-8');
      } catch {
        text = '';
      }
    }
    const { bucket, reason } = text ? classifyFailureLog(text) : { bucket: 'unknown', reason: 'no log file' };
    buckets[bucket] += 1;
    const key = `${r.task}/${r.language}`;
    byTaskLang[key] = byTaskLang[key] || { tool: 0, dev: 0, unknown: 0 };
    byTaskLang[key][bucket] += 1;
    details.push({
      runId: r.runId,
      task: r.task,
      lang: r.language,
      model: String(r.model || '').replace(/gemini-2\.5-|gemini-/, ''),
      date: String(r.startedAt || '').slice(0, 10),
      bucket,
      reason,
    });
  }

  const total = done + failed;
  const toolRate = total > 0 ? buckets.tool / total : 0;
  return {
    ok: true,
    total,
    done,
    failed,
    buckets,
    byTaskLang,
    toolRate,
    devFailures: buckets.dev,
    inconclusive: toolRate > TOOL_INCONCLUSIVE_RATE,
    details,
  };
}

/** Render a compact markdown block for a report (or stdout). */
export function renderSummaryMarkdown(s, scopeLabel = 'panel') {
  if (!s.ok) return `## Run reliability\n\n_(failure triage unavailable: ${s.error})_\n`;
  if (s.total === 0) return `## Run reliability\n\n_(no runs found for ${scopeLabel})_\n`;
  const lines = [
    '## Run reliability (failure triage)',
    '',
    `${s.total} runs for ${scopeLabel}: **${s.done} done**, **${s.failed} failed**.`,
    `Failures by cause: TOOL/Google **${s.buckets.tool}** · \`-dev\`/app **${s.buckets.dev}** · unknown **${s.buckets.unknown}**`,
  ];
  if (s.devFailures > 0) {
    lines.push(`- 🔴 **\`-dev\`/app failures: ${s.devFailures}** — readiness red flag (boot stall / audio / unreachable).`);
  } else {
    lines.push('- ✅ No `-dev`/app failures — launch + audio looked healthy in this panel.');
  }
  if (s.inconclusive) {
    lines.push(
      `- ⚠️ TOOL-failure rate **${(s.toolRate * 100).toFixed(1)}%** > ${(TOOL_INCONCLUSIVE_RATE * 100).toFixed(0)}% — **INCONCLUSIVE for content**; Google overload ate too much of this panel, re-run before trusting difficulty/translation numbers.`,
    );
  } else if (s.buckets.tool > 0) {
    lines.push(`- TOOL-failure rate ${(s.toolRate * 100).toFixed(1)}% (within tolerance) — those are Google, not \`-dev\`.`);
  }
  lines.push('');
  return lines.join('\n');
}

function parseFlag(argv, name) {
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === `--${name}`) return argv[i + 1];
    if (argv[i].startsWith(`--${name}=`)) return argv[i].slice(name.length + 3);
  }
  return null;
}

function main() {
  const argv = process.argv;
  const manifestArg = parseFlag(argv, 'manifest');
  const manifestPath = manifestArg ? resolve(manifestArg) : DEFAULT_MANIFEST;
  const task = parseFlag(argv, 'task');
  const langArg = parseFlag(argv, 'lang') || parseFlag(argv, 'langs');
  const langs = langArg ? langArg.split(',').map((s) => s.trim()).filter(Boolean) : null;

  const s = summarizeFailures(manifestPath, { task, langs });
  if (!s.ok) {
    console.error(s.error);
    process.exit(1);
  }
  const scope = [task || 'all tasks', langs ? langs.join('+') : 'all langs'].join(' / ');
  console.log(`=== VLM panel failure triage — ${scope} ===`);
  console.log(`total=${s.total}  done=${s.done}  failed=${s.failed}`);
  console.log(`by cause: TOOL/Google=${s.buckets.tool}  -dev/app=${s.buckets.dev}  unknown=${s.buckets.unknown}`);
  console.log(`tool-rate=${(s.toolRate * 100).toFixed(1)}%  ->  ${s.inconclusive ? 'INCONCLUSIVE for content (re-run)' : 'usable'}`);
  if (s.devFailures > 0) console.log(`!! ${s.devFailures} -dev/app failure(s) — readiness red flag`);

  const keys = Object.keys(s.byTaskLang).sort();
  if (keys.length) {
    console.log('\nby task/language (tool/dev/unknown):');
    for (const k of keys) {
      const b = s.byTaskLang[k];
      console.log(`  ${k.padEnd(16)} ${b.tool}/${b.dev}/${b.unknown}`);
    }
  }
  if (s.details.length) {
    console.log('\ndetail:');
    s.details
      .sort((a, b) => a.bucket.localeCompare(b.bucket))
      .forEach((d) => console.log(`  [${d.bucket}] ${d.task}/${d.lang} ${d.model} ${d.date} — ${d.reason}`));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
