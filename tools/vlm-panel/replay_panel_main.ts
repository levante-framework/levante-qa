/**
 * Offline TROG panel replay from captured assets.
 * Invoked via: npx tsx tools/vlm-panel/replay_panel_main.ts …
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeChildPersonaPrompt } from '../../cypress/support/persona/childPersona';
import {
  SYSTEM_PROMPT_CHECKLIST,
  SYSTEM_PROMPT_YOUNG,
  TROG_YOUNG_AGE_MAX,
  trogUserText,
  parseChoiceIndex,
} from '../../cypress/support/agents/prompts/trogPrompts';
import { askVLM } from '../../cypress/plugins/vlmClients/index';
import {
  assetDirFor,
  hasAssets,
  loadIndex,
  readPngBase64,
} from './panelAssets.mjs';
import { writeStatus, printWatchHint } from './panelStatus.mjs';
import { legacyLanguageReplacement } from '../../dashboard/catalog.mjs';
import dotenv from 'dotenv';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
dotenv.config({ path: join(REPO, '.env') });
const OUT_DIR = join(HERE, 'out');
const LOG_DIR = join(OUT_DIR, 'logs');
const MANIFEST = join(OUT_DIR, 'manifest.json');
const USAGE_DIR = join(OUT_DIR, 'usage');

function parseArgs(argv: string[]) {
  const args = {
    grid: join(HERE, 'panel_grid.json'),
    limit: Infinity,
    dryRun: false,
    lang: null as string | null,
    force: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--force') args.force = true;
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--grid') args.grid = argv[++i];
    else if (a === '--lang') args.lang = argv[++i];
  }
  return args;
}

function shortModel(model: string) {
  return model.replace(/^gemini-/, '').replace(/[^a-z0-9]/gi, '');
}

function expand(grid: any, token: string, locale: string) {
  const out: any[] = [];
  for (const model of grid.models) {
    for (const age of grid.ages) {
      for (let rep = 1; rep <= (grid.repeats ?? 1); rep++) {
        const runId = `panel_${grid.task}_${token}_${shortModel(model)}_a${age}_r${rep}`;
        out.push({
          runId,
          task: grid.task,
          provider: grid.provider ?? 'gemini',
          language: token,
          qaLanguage: locale,
          model,
          age,
          repeat: rep,
          temperature: grid.temperature ?? 0.8,
          personaAbility: grid.personaAbility ?? 'irt',
          country: grid.country ?? null,
        });
      }
    }
  }
  return out;
}

function hasFinalizedLog(runId: string) {
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

function clearTrialLogs(runId: string) {
  const dir = join(REPO, 'cypress', 'logs', 'runs', runId);
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (/^vlm_.*\.jsonl?$/.test(f) || f.endsWith('.jsonl')) {
      rmSync(join(dir, f), { force: true });
    }
  }
}

function loadManifest(): Record<string, any> {
  if (!existsSync(MANIFEST)) return {};
  try {
    const arr = JSON.parse(readFileSync(MANIFEST, 'utf-8'));
    return Object.fromEntries(arr.map((r: any) => [r.runId, r]));
  } catch {
    return {};
  }
}

function saveManifest(byId: Record<string, any>) {
  const arr = Object.values(byId).sort((a: any, b: any) => a.runId.localeCompare(b.runId));
  writeFileSync(MANIFEST, JSON.stringify(arr, null, 2) + '\n');
}

function trogSystemForAge(age: number) {
  return age <= TROG_YOUNG_AGE_MAX ? SYSTEM_PROMPT_YOUNG : SYSTEM_PROMPT_CHECKLIST;
}

async function replayOne(
  r: any,
  index: any,
  assetDir: string,
  meta: { cell: number; cellsTotal: number } = { cell: 1, cellsTotal: 1 },
) {
  process.env.GEMINI_MODEL = r.model;
  process.env.VLM_TEMPERATURE = String(r.temperature);
  process.env.QA_PERSONA = 'child';
  process.env.QA_PERSONA_AGE_YEARS = String(r.age);
  process.env.QA_PERSONA_AGE_MONTHS = '0';
  process.env.QA_PERSONA_ABILITY = r.personaAbility;
  process.env.QA_LANGUAGE = r.qaLanguage ?? r.language;
  process.env.QA_RUN_ID = r.runId;
  if (r.country) process.env.QA_PERSONA_COUNTRY = String(r.country);
  else delete process.env.QA_PERSONA_COUNTRY;

  const runDir = join(REPO, 'cypress', 'logs', 'runs', r.runId);
  mkdirSync(runDir, { recursive: true });
  const livePath = join(runDir, '_trog_vlm_live.jsonl');
  const finalPath = join(runDir, `vlm_trog_gemini_${Date.now()}.jsonl`);
  writeFileSync(livePath, '');

  const preamble = makeChildPersonaPrompt(r.age, 0, 'trog', {
    includeIrtAbility: String(r.personaAbility).toLowerCase() === 'irt',
    country: r.country,
  });
  const systemPrompt = `${preamble}\n\n${trogSystemForAge(Number(r.age))}`;

  mkdirSync(USAGE_DIR, { recursive: true });
  const usagePath = join(USAGE_DIR, `${r.runId}.jsonl`);
  const cellStarted = Date.now();
  let scored = 0;
  let correctN = 0;

  let itemIdx = 0;
  for (const item of index.items) {
    itemIdx++;
    const pngBase64 = readPngBase64(assetDir, item.assetId);
    const userText = trogUserText(item.transcript ?? null, Number(r.age));
    const start = Date.now();
    const reply = await askVLM(r.provider, {
      pngBase64,
      systemPrompt,
      taskId: 'trog',
      transcript: item.transcript ?? null,
      userText,
    });
    const latencyMs = Date.now() - start;
    const vlmIndex = parseChoiceIndex(reply.text ?? '');
    const keyedIndex = item.keyedIndex;
    const hasKey = typeof keyedIndex === 'number' && keyedIndex >= 0;
    const choices: string[] = item.choices ?? [];
    const correct =
      vlmIndex != null && hasKey ? vlmIndex === keyedIndex : null;
    if (typeof correct === 'boolean') {
      scored++;
      if (correct) correctN++;
    }

    if (itemIdx === 1 || itemIdx % 10 === 0 || itemIdx === index.items.length) {
      writeStatus({
        phase: 'replay',
        runId: r.runId,
        message: 'scoring item',
        cell: meta.cell,
        cellsTotal: meta.cellsTotal,
        item: itemIdx,
        itemsTotal: index.items.length,
        lastTranscript: item.transcript ?? null,
        accuracy: scored ? `${correctN}/${scored}` : null,
        elapsedSec: Math.round((Date.now() - cellStarted) / 1000),
        status: 'running',
      });
      console.log(
        `    item ${itemIdx}/${index.items.length}` +
          (scored ? `  acc=${correctN}/${scored}` : '') +
          (item.transcript ? `  "${String(item.transcript).slice(0, 40)}"` : ''),
      );
    }

    const rec = {
      timestamp: new Date().toISOString(),
      task: 'trog',
      step: item.step,
      itemType: 'item',
      promptText: item.promptText ?? null,
      choices,
      chosenIndex: vlmIndex,
      chosenValue: vlmIndex != null ? (choices[vlmIndex] ?? null) : null,
      correct,
      keyedIndex: hasKey ? keyedIndex : null,
      keyedValue: hasKey ? (choices[keyedIndex] ?? null) : null,
      rtMs: latencyMs,
      oracle: false,
      provider: r.provider,
      modelRaw: reply.text ?? '',
      latencyMs,
      timedOut: latencyMs > 10000,
      audioTranscript: item.transcript ?? null,
      audioSource: item.audioSource ?? null,
      gateWantCorrect: null,
      gateP: null,
      gateOverridden: null,
      vlmProposedIndex: vlmIndex,
    };
    appendFileSync(livePath, JSON.stringify(rec) + '\n');
    appendFileSync(finalPath, JSON.stringify(rec) + '\n');
    if (reply.usage) {
      appendFileSync(
        usagePath,
        JSON.stringify({
          ts: new Date().toISOString(),
          runId: r.runId,
          provider: r.provider,
          model: r.model,
          latencyMs,
          usage: reply.usage,
          replay: true,
        }) + '\n',
      );
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const grid = JSON.parse(readFileSync(args.grid, 'utf-8'));
  const locale = args.lang ?? grid.language ?? 'en';
  const legacyLocale = legacyLanguageReplacement(locale);
  if (legacyLocale) {
    throw new Error(`Locale "${locale}" is legacy; use "${legacyLocale}".`);
  }
  const token = locale.split('-')[0].toLowerCase();
  if (!hasAssets(token)) {
    throw new Error(
      `No panel assets for lang=${token}. Run: node tools/vlm-panel/run_panel.mjs --capture-assets --lang ${locale}`,
    );
  }
  const assetDir = assetDirFor(token);
  const index = loadIndex(assetDir)!;
  mkdirSync(LOG_DIR, { recursive: true });

  let respondents = expand(grid, token, locale);
  if (Number.isFinite(args.limit)) respondents = respondents.slice(0, args.limit);
  const byId = loadManifest();
  const pending = args.force
    ? respondents
    : respondents.filter((r) => !hasFinalizedLog(r.runId));

  console.log(
    `Replay panel: ${pending.length}/${respondents.length} cell(s) from assets (${index.items.length} items) [${token}]`,
  );
  printWatchHint();
  if (args.dryRun) {
    for (const r of pending) console.log(`  [RUN ] ${r.runId}`);
    return;
  }

  let i = 0;
  for (const r of pending) {
    i++;
    clearTrialLogs(r.runId);
    const t0 = Date.now();
    console.log(`\n[${i}/${pending.length}] START ${r.runId} (replay model=${r.model} age=${r.age})`);
    writeStatus({
      phase: 'replay',
      runId: r.runId,
      message: 'starting cell',
      cell: i,
      cellsTotal: pending.length,
      itemsTotal: index.items.length,
      status: 'running',
    });
    byId[r.runId] = { ...r, status: 'running', startedAt: new Date().toISOString(), mode: 'replay' };
    saveManifest(byId);
    try {
      await replayOne(r, index, assetDir, { cell: i, cellsTotal: pending.length });
      byId[r.runId] = {
        ...byId[r.runId],
        status: 'done',
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        elapsedMs: Date.now() - t0,
        mode: 'replay',
      };
      console.log(`           DONE ${r.runId} in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
      writeStatus({
        phase: 'replay',
        runId: r.runId,
        message: 'cell done',
        cell: i,
        cellsTotal: pending.length,
        status: 'running',
        elapsedSec: Math.round((Date.now() - t0) / 1000),
      });
    } catch (err) {
      byId[r.runId] = {
        ...byId[r.runId],
        status: 'failed',
        finishedAt: new Date().toISOString(),
        exitCode: 1,
        elapsedMs: Date.now() - t0,
        mode: 'replay',
        error: String(err),
      };
      console.error(`           FAILED ${r.runId}:`, err);
      writeStatus({
        phase: 'replay',
        runId: r.runId,
        message: `failed: ${err}`,
        cell: i,
        cellsTotal: pending.length,
        status: 'failed',
      });
    }
    saveManifest(byId);
  }
  writeStatus({
    phase: 'replay',
    message: 'replay finished',
    status: 'done',
    cellsTotal: pending.length,
  });
  console.log(`\nReplay finished. Manifest: ${MANIFEST}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
