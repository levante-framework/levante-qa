#!/usr/bin/env node
/**
 * VLM synthetic-respondent panel runner.
 *
 * Expands panel_grid.json into one "respondent" per (model x age x repeat) cell.
 *
 * Modes:
 *   (default) If assets exist for the language → --replay (Gemini only, no UI).
 *             Else → --live (full Cypress per cell, as before).
 *   --capture-assets  One Cypress walk: save PNG+index, oracle-advance (no Gemini).
 *   --replay          Force offline replay from assets.
 *   --live            Force full Cypress per cell (still off-screen by default).
 *   --headed          Show the Cypress/Electron window (WSLg will take your display).
 *
 * Display: under WSLg, `DISPLAY=:0` makes Electron paint on the Windows desktop
 * even for `cypress run`. By default we wrap with `xvfb-run -a` so the run stays
 * off-screen. Pass `--headed` only when debugging the UI.
 *
 * Usage:
 *   node tools/vlm-panel/run_panel.mjs --capture-assets --lang en-US
 *   node tools/vlm-panel/run_panel.mjs --lang en-US              # replay if assets present
 *   node tools/vlm-panel/run_panel.mjs --live --limit 1
 *   node tools/vlm-panel/run_panel.mjs --force                   # re-run successes too
 */
import { spawnSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  openSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { legacyLanguageReplacement } from '../../dashboard/catalog.mjs';
import { assetDirFor, hasAssets, ensureAssetDir } from './panelAssets.mjs';
import {
  writeStatus,
  readStatus,
  formatStatusLine,
  printWatchHint,
} from './panelStatus.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
dotenv.config({ path: join(REPO, '.env') });
const OUT_DIR = join(HERE, 'out');
const LOG_DIR = join(OUT_DIR, 'logs');
const MANIFEST = join(OUT_DIR, 'manifest.json');

function parseArgs(argv) {
  const args = {
    grid: join(HERE, 'panel_grid.json'),
    limit: Infinity,
    dryRun: false,
    lang: null,
    force: false,
    captureAssets: false,
    replay: false,
    live: false,
    headed: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--force') args.force = true;
    else if (a === '--capture-assets') args.captureAssets = true;
    else if (a === '--replay') args.replay = true;
    else if (a === '--live') args.live = true;
    else if (a === '--headed') args.headed = true;
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--grid') args.grid = argv[++i];
    else if (a === '--lang') args.lang = argv[++i];
  }
  return args;
}

/** Prefer Xvfb so WSLg DISPLAY=:0 does not paint Electron on the Windows desktop. */
function spawnCypress(cyArgs, { cwd, env, stdio, headed }) {
  if (headed) {
    return spawn('npx', ['cypress', 'run', '--headed', ...cyArgs], { cwd, env, stdio });
  }
  const isolated = { ...env };
  delete isolated.DISPLAY;
  delete isolated.WAYLAND_DISPLAY;
  if (existsSync('/usr/bin/xvfb-run')) {
    return spawn(
      'xvfb-run',
      ['-a', '-s', '-screen 0 1280x1024x24', 'npx', 'cypress', 'run', ...cyArgs],
      { cwd, env: isolated, stdio },
    );
  }
  return spawn('npx', ['cypress', 'run', ...cyArgs], { cwd, env: isolated, stdio });
}

function countPngs(dir) {
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.png')).length;
  } catch {
    return 0;
  }
}

function waitChild(child, { runId, assetDir = null, startedMs }) {
  return new Promise((resolve) => {
    let lastLine = '';
    let lastHeartbeat = 0;
    const tick = setInterval(() => {
      const elapsedSec = Math.round((Date.now() - startedMs) / 1000);
      const fromFile = readStatus();
      const pngs = assetDir ? countPngs(assetDir) : null;
      if (pngs != null && (!fromFile || (fromFile.itemsCaptured ?? 0) < pngs)) {
        writeStatus({
          phase: fromFile?.phase ?? 'capture',
          runId,
          message: fromFile?.message ?? 'running',
          itemsCaptured: pngs,
          elapsedSec,
          status: 'running',
        });
      } else {
        writeStatus({
          ...(fromFile || {}),
          runId,
          elapsedSec,
          status: 'running',
        });
      }
      const line = formatStatusLine(readStatus());
      const now = Date.now();
      if (line !== lastLine || now - lastHeartbeat > 30000) {
        console.log(`  … ${line}`);
        lastLine = line;
        lastHeartbeat = now;
      }
    }, 5000);

    child.on('error', (err) => {
      clearInterval(tick);
      console.error('  spawn error:', err);
      resolve({ status: 1 });
    });
    child.on('close', (code) => {
      clearInterval(tick);
      resolve({ status: code ?? 1 });
    });
  });
}

function shortModel(model) {
  return model.replace(/^gemini-/, '').replace(/[^a-z0-9]/gi, '');
}

/** e.g. 0.5 → t05, 1.2 → t12 (for runIds when temperatures[] is used). */
function shortTemp(t) {
  const n = Number(t);
  if (!Number.isFinite(n)) return 'tna';
  return `t${String(n).replace('.', '').replace(/-/g, 'm')}`;
}

function expand(grid, token, locale) {
  const out = [];
  const temps =
    Array.isArray(grid.temperatures) && grid.temperatures.length
      ? grid.temperatures.map(Number)
      : [grid.temperature ?? 0.8];
  // Always stamp temp into runId when `temperatures` is set (even length 1),
  // so one-cell retries match multi-temp smoke runIds (e.g. …_a11_t05_r1).
  const stampTemp = Array.isArray(grid.temperatures) && grid.temperatures.length > 0;
  for (const model of grid.models) {
    for (const age of grid.ages) {
      for (const temperature of temps) {
        for (let rep = 1; rep <= (grid.repeats ?? 1); rep++) {
          const tempTag = stampTemp ? `_${shortTemp(temperature)}` : '';
          const runId = `panel_${grid.task}_${token}_${shortModel(model)}_a${age}${tempTag}_r${rep}`;
          out.push({
            runId,
            task: grid.task,
            spec: grid.spec,
            provider: grid.provider ?? 'gemini',
            language: token,
            qaLanguage: locale,
            model,
            age,
            repeat: rep,
            temperature,
            personaAbility: grid.personaAbility ?? 'irt',
            country: grid.country ?? null,
          });
        }
      }
    }
  }
  return out;
}

function hasFinalizedLog(runId) {
  const dir = join(REPO, 'cypress', 'logs', 'runs', runId);
  if (!existsSync(dir)) return false;
  for (const f of readdirSync(dir)) {
    if (!/^vlm_.*\.jsonl?$/.test(f)) continue;
    try {
      if (statSync(join(dir, f)).size > 64) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

function clearTrialLogs(runId) {
  const dir = join(REPO, 'cypress', 'logs', 'runs', runId);
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (/^vlm_.*\.jsonl?$/.test(f) || f.endsWith('.jsonl')) {
      rmSync(join(dir, f), { force: true });
    }
  }
}

function loadManifest() {
  if (!existsSync(MANIFEST)) return {};
  try {
    const arr = JSON.parse(readFileSync(MANIFEST, 'utf-8'));
    return Object.fromEntries(arr.map((r) => [r.runId, r]));
  } catch {
    return {};
  }
}

function saveManifest(byId) {
  const arr = Object.values(byId).sort((a, b) => a.runId.localeCompare(b.runId));
  writeFileSync(MANIFEST, JSON.stringify(arr, null, 2) + '\n');
}

function baseEnv(r) {
  const env = {
    ...process.env,
    GEMINI_MODEL: r.model,
    VLM_TEMPERATURE: String(r.temperature),
    QA_PERSONA: 'child',
    QA_PERSONA_AGE_YEARS: String(r.age),
    QA_PERSONA_AGE_MONTHS: '0',
    QA_PERSONA_ABILITY: r.personaAbility,
    QA_LANGUAGE: r.qaLanguage ?? r.language,
    QA_RUN_ID: r.runId,
  };
  if (r.country) env.QA_PERSONA_COUNTRY = String(r.country);
  if ((env.CYPRESS_CACHE_FOLDER ?? '').includes('sandbox-cache')) {
    delete env.CYPRESS_CACHE_FOLDER;
  }
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

async function runCypress(r, byId, extraEnv = {}, { headed = false, assetDir = null } = {}) {
  const logFile = join(LOG_DIR, `${r.runId}.log`);
  const env = { ...baseEnv(r), ...extraEnv };
  byId[r.runId] = {
    ...r,
    status: 'running',
    startedAt: new Date().toISOString(),
    logFile: logFile.replace(REPO + '/', ''),
  };
  saveManifest(byId);

  writeStatus({
    phase: extraEnv.QA_PANEL_CAPTURE ? 'capture' : 'live',
    runId: r.runId,
    message: 'starting Cypress',
    itemsCaptured: assetDir ? countPngs(assetDir) : 0,
    status: 'running',
    logFile: logFile.replace(REPO + '/', ''),
    elapsedSec: 0,
  });
  printWatchHint();
  console.log(`  cypress log: ${logFile.replace(REPO + '/', '')}`);

  const fd = openSync(logFile, 'a');
  const started = Date.now();
  const child = spawnCypress(
    ['--spec', r.spec, '--env', `provider=${r.provider}`],
    { cwd: REPO, env, stdio: ['ignore', fd, fd], headed },
  );
  const res = await waitChild(child, { runId: r.runId, assetDir, startedMs: started });
  const elapsedMs = Date.now() - started;

  byId[r.runId] = {
    ...byId[r.runId],
    status: res.status === 0 ? 'done' : 'failed',
    finishedAt: new Date().toISOString(),
    exitCode: res.status,
    elapsedMs,
  };
  saveManifest(byId);
  writeStatus({
    phase: extraEnv.QA_PANEL_CAPTURE ? 'capture' : 'live',
    runId: r.runId,
    message: res.status === 0 ? 'finished' : 'failed',
    status: res.status === 0 ? 'done' : 'failed',
    exitCode: res.status,
    elapsedSec: Math.round(elapsedMs / 1000),
    itemsCaptured: assetDir ? countPngs(assetDir) : readStatus()?.itemsCaptured,
  });
  return res.status === 0;
}

async function runCaptureAssets(locale, token, grid, { headed = false } = {}) {
  const dir = ensureAssetDir(assetDirFor(token));
  // Clear staging so a re-capture is clean
  for (const f of readdirSync(dir)) {
    if (f === '_items.jsonl' || f === 'index.json' || f.endsWith('.png')) {
      rmSync(join(dir, f), { force: true });
    }
  }
  const r = {
    runId: `panel_${grid.task}_${token}_capture`,
    task: grid.task,
    spec: grid.spec,
    provider: grid.provider ?? 'gemini',
    language: token,
    qaLanguage: locale,
    model: grid.models[0],
    age: grid.ages[0],
    repeat: 0,
    temperature: 0,
    personaAbility: grid.personaAbility ?? 'irt',
    country: grid.country ?? null,
  };
  console.log(`Capturing TROG assets → ${dir}`);
  console.log(
    headed
      ? '(headed Cypress — will use your display)'
      : '(off-screen via xvfb; pass --headed to show the window)',
  );
  const byId = loadManifest();
  const ok = await runCypress(
    r,
    byId,
    {
      QA_PANEL_CAPTURE: '1',
      QA_PANEL_ASSET_DIR: dir,
      VLM_TEMPERATURE: '0',
    },
    { headed, assetDir: dir },
  );
  if (!ok) {
    console.error('Asset capture failed. See', join(LOG_DIR, `${r.runId}.log`));
    process.exit(1);
  }
  if (!hasAssets(token)) {
    console.error('Capture finished but index.json missing/empty under', dir);
    process.exit(1);
  }
  const idx = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf-8'));
  console.log(`Captured ${idx.items?.length ?? 0} items. Next: node tools/vlm-panel/run_panel.mjs --lang ${locale}`);
}

async function main() {
  const args = parseArgs(process.argv);
  const grid = JSON.parse(readFileSync(args.grid, 'utf-8'));
  const locale = args.lang ?? grid.language ?? 'en';
  const legacyLocale = legacyLanguageReplacement(locale);
  if (legacyLocale) {
    throw new Error(`Locale "${locale}" is legacy; use "${legacyLocale}" (e.g. --lang ${legacyLocale}).`);
  }
  const token = locale.split('-')[0].toLowerCase();
  mkdirSync(LOG_DIR, { recursive: true });

  if (args.captureAssets) {
    if (args.dryRun) {
      console.log(`[dry-run] would capture assets for ${token} under ${assetDirFor(token)}`);
      return;
    }
    await runCaptureAssets(locale, token, grid, { headed: args.headed });
    return;
  }

  const preferReplay = args.replay || (!args.live && hasAssets(token));
  if (preferReplay) {
    if (!hasAssets(token)) {
      console.error(`No assets for ${token}. Run --capture-assets first.`);
      process.exit(1);
    }
    if (!process.env.GEMINI_API_KEY) {
      console.error(`GEMINI_API_KEY not set. Add it to ${join(REPO, '.env')} (dotenv loads it for replay).`);
      process.exit(1);
    }
    console.log(`Mode: replay (assets at ${assetDirFor(token)}; no Cypress UI / no display needed)`);
    printWatchHint();
    const r = spawnSync(
      'npx',
      [
        'tsx',
        join(HERE, 'replay_panel_main.ts'),
        '--grid',
        args.grid,
        '--lang',
        locale,
        ...(args.force ? ['--force'] : []),
        ...(Number.isFinite(args.limit) ? ['--limit', String(args.limit)] : []),
        ...(args.dryRun ? ['--dry-run'] : []),
      ],
      { cwd: REPO, env: process.env, stdio: 'inherit' },
    );
    process.exit(r.status ?? 1);
  }

  console.log(
    args.headed
      ? 'Mode: live Cypress (--headed; will use your display)'
      : 'Mode: live Cypress (off-screen via xvfb; pass --headed to show the window)',
  );
  let respondents = expand(grid, token, locale);
  if (Number.isFinite(args.limit)) respondents = respondents.slice(0, args.limit);

  const byId = loadManifest();
  const pending = args.force
    ? respondents
    : respondents.filter((r) => !hasFinalizedLog(r.runId));
  const skipped = respondents.length - pending.length;

  const tempLabel = Array.isArray(grid.temperatures) && grid.temperatures.length
    ? `temps=[${grid.temperatures.join(',')}]`
    : `temp=${grid.temperature}`;
  console.log(
    `Panel: ${respondents.length} respondent(s) [${grid.models.length} models x ${grid.ages.length} ages x ${tempLabel} x ${grid.repeats} repeats]`,
  );
  console.log(`  task=${grid.task} lang=${token} (QA_LANGUAGE=${locale}) ${tempLabel} persona=irt`);
  console.log(
    `  already done: ${skipped} | to run: ${pending.length}` +
      (args.force ? ' (--force: re-run all, including successes)' : ' (resume: pending/failed only)'),
  );

  if (args.dryRun) {
    for (const r of respondents) {
      const tag = !args.force && hasFinalizedLog(r.runId) ? 'SKIP' : 'RUN ';
      console.log(`  [${tag}] ${r.runId}  model=${r.model} age=${r.age} temp=${r.temperature}`);
    }
    console.log('(dry run -- nothing executed)');
    return;
  }

  const assetDir = hasAssets(token) ? assetDirFor(token) : null;
  let i = 0;
  for (const r of pending) {
    i++;
    clearTrialLogs(r.runId);
    const t0 = new Date().toISOString();
    console.log(`\n[${i}/${pending.length}] ${t0}  START ${r.runId} (model=${r.model} age=${r.age})`);
    writeStatus({
      phase: 'live',
      runId: r.runId,
      message: 'starting cell',
      cell: i,
      cellsTotal: pending.length,
      status: 'running',
    });
    const extra = {};
    if (assetDir) {
      extra.QA_PANEL_ASSET_DIR = assetDir;
      extra.QA_PANEL_USE_ASSETS = '1';
    }
    const ok = await runCypress(r, byId, extra, { headed: args.headed, assetDir });
    const mins = ((byId[r.runId].elapsedMs ?? 0) / 60000).toFixed(1);
    console.log(`           ${ok ? 'DONE' : 'FAILED'} ${r.runId} in ${mins} min (exit ${byId[r.runId].exitCode})`);
  }

  const done = Object.values(byId).filter((r) => r.status === 'done').length;
  const failed = Object.values(byId).filter((r) => r.status === 'failed').length;
  writeStatus({
    phase: 'live',
    message: 'panel finished',
    status: failed ? 'failed' : 'done',
    cellsDone: done,
    cellsFailed: failed,
  });
  console.log(`\nPanel finished. done=${done} failed=${failed}. Manifest: ${MANIFEST.replace(REPO + '/', '')}`);
  console.log('Next: node tools/vlm-panel/analyze.mjs');
}

main().catch((err) => {
  console.error(err);
  writeStatus({ phase: 'error', message: String(err), status: 'failed' });
  process.exit(1);
});
