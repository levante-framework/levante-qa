#!/usr/bin/env node
/**
 * Analyze the VLM synthetic-respondent panel and compare item statistics to the
 * human IRT data.
 *
 * Pipeline:
 *   1. Load every respondent's trial log (cypress/logs/runs/panel_*\/vlm_*.jsonl),
 *      one respondent per run dir; keep scored item rows.
 *   2. Build a respondent x item correctness matrix keyed by the (normalized)
 *      audio transcript.
 *   3. SPREAD GATE: report the distribution of per-respondent total scores. If
 *      everyone is near ceiling/floor there is no ability variance and
 *      discrimination is meaningless -- the script says so loudly.
 *   4. Per item: p_vlm (difficulty) and corrected point-biserial (discrimination).
 *   5. Join to humans via the item bank (transcript -> prompt -> item_uid) and the
 *      diag CSV (item_uid -> p_correct, point_biserial) for trog/en.
 *   6. Compare: Spearman rho on difficulty and on discrimination, a low/neg
 *      discrimination agreement table, and a ranked divergence list (human-hard /
 *      VLM-easy items -- the trog-item-78 signature).
 *   7. Fit a monotonic calibrator (isotonic / logistic) on matched p_vlm→p_human
 *      pairs and emit p_pred_child (+ approximate age-adjusted columns).
 *
 * Output: out/item_comparison.csv + out/report.md (+ stdout summary).
 *
 * Usage: node tools/vlm-panel/analyze.mjs
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeFailures, renderSummaryMarkdown } from './classify_failures.mjs';
import {
  PRED_AGES,
  ageAdjustedPredictions,
  blendVocabPrior,
  formatCalibrationReport,
  inSampleMetrics,
  loadVocabLexicon,
  predictChild,
  resolveCalibrator,
} from './calibration.mjs';
import {
  loadAgeItemRatesJson,
  normalizeItemUid,
} from './benchHuman.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const RUNS_DIR = join(REPO, 'cypress', 'logs', 'runs');
const OUT_DIR = join(HERE, 'out');
const CORPORA = join(REPO, '..', 'crowdin-projects', 'corpora');
const KNOWN_ISSUES_PATH = join(HERE, 'known_issues.json');
const DIAG_CSV = join(
  REPO,
  '..',
  'levante-pilots',
  '04_papers',
  'display',
  'diag_items_allstats_selected.csv',
);

/** item_uid -> note; suppressed from review_*.csv triage. */
function loadKnownIssues(task) {
  if (!existsSync(KNOWN_ISSUES_PATH)) return new Map();
  try {
    const raw = JSON.parse(readFileSync(KNOWN_ISSUES_PATH, 'utf-8'));
    const block = raw?.[task] ?? {};
    return new Map(
      Object.entries(block).filter(([k]) => !k.startsWith('_') && typeof block[k] === 'string'),
    );
  } catch {
    return new Map();
  }
}
// ---------- translation-string source ----------
// The bridge from the VLM's spoken text to the item bank is
// normText(approved string) -> item_id. Those strings ALWAYS come from a live
// source keyed by task + country, never a checked-in CSV or XLIFF file:
//
//   - default ('draft'): the per-task/per-locale JSON published to
//     levante-assets-draft/translations/itembank/<task>/<locale>/item-bank-translations.json,
//     a flat { item_id: string } map.
//   - 'crowdin': the non-hidden, APPROVED strings read directly from the Crowdin
//     API (no export/build, no XLIFF). String identifier === item_id.
//
// Set QA_TRANSLATIONS_SOURCE=crowdin to use the second. There is deliberately no
// fallback to a CSV/XLIFF: if the chosen source has no strings for a language the
// cross-language alignment is left empty and the run says so loudly.
const TRANSLATION_SOURCE = (process.env.QA_TRANSLATIONS_SOURCE || 'draft').toLowerCase();
const DRAFT_ITEMBANK_BASE =
  process.env.QA_ITEMBANK_BASE_URL ||
  'https://storage.googleapis.com/levante-assets-draft/translations/itembank';
const CROWDIN_API_BASE = 'https://api.crowdin.com/api/v2';

// Run-id language token (or bare subtag) -> canonical bucket locale folder.
const TOKEN_TO_LOCALE = {
  en: 'en-US',
  de: 'de-DE',
  es: 'es-CO',
  nl: 'nl-NL',
  he: 'he-IL',
  ar: 'ar-IL',
  eo: 'eo-UY',
};
// Bucket locale -> Crowdin language id (Crowdin uses bare subtags for some).
const LOCALE_TO_CROWDIN = {
  'en-US': 'en-US',
  'en-GB': 'en-GB',
  'de-DE': 'de',
  'nl-NL': 'nl',
  'es-CO': 'es-CO',
  'es-AR': 'es-AR',
  'he-IL': 'he-IL',
  'ar-IL': 'ar-IL',
  'eo-UY': 'eo',
};

/** A run-language token/locale -> full bucket locale (e.g. "nl" -> "nl-NL"). */
function resolveLocale(language) {
  if (!language) return null;
  if (language.includes('-')) return language;
  return TOKEN_TO_LOCALE[language] || language;
}

// Per-language approved-string map (item_id -> string), prebuilt in main() so the
// otherwise-synchronous join/cross-language pipeline can read it without async
// plumbing. Empty for a language whose source has no strings.
const ITEMBANK_STRINGS = {};

// Per-task wiring. The pipeline is identical across tasks; only the scored row
// type, the item-identity field, the item bank, the human diag task name, and
// the chance level differ. `defaultChance` is used when the item bank has no
// per-item chance (TROG is a uniform 4-AFC; Stories varies, so per-item wins).
const TASKS = {
  trog: {
    title: 'TROG',
    diagTask: 'trog',
    scoredType: 'item',
    itemBank: join(CORPORA, 'trog', 'shared', 'corpora', 'trog-item-bank.csv'),
    identity: (rec) => rec.audioTranscript,
    hasResponse: (rec) => rec.chosenIndex !== null && rec.chosenIndex !== undefined,
    defaultChance: 0.25,
    humanJoin: true,
    crowdinFile: 'sentence-understanding',
    draftTask: 'trog',
  },
  stories: {
    title: 'Stories (Theory of Mind)',
    diagTask: 'tom',
    scoredType: 'question',
    itemBank: join(CORPORA, 'theory-of-mind', 'shared', 'corpora', 'theory-of-mind-item-bank.csv'),
    // ToM questions are scored on the on-screen question text (audio transcript
    // is usually empty for this task). QA_LANGUAGE controls the run language, so
    // each run is single-language like TROG.
    identity: (rec) => rec.audioTranscript || rec.promptText,
    hasResponse: (rec) => rec.chosenIndex !== null && rec.chosenIndex !== undefined,
    defaultChance: 0.5,
    humanJoin: true,
    crowdinFile: 'stories',
    draftTask: 'theory-of-mind',
  },
  vocab: {
    title: 'Picture Vocabulary (4-AFC)',
    diagTask: 'vocab',
    scoredType: 'word',
    itemBank: join(CORPORA, 'vocab-test', 'shared', 'corpora', 'vocab-item-bank.csv'),
    // The spoken word is the item identity. In placeholder-audio (nl) runs the
    // transcript is the approved target word the mp3 will be generated from, so
    // it aligns to the same item_id via the itembank strings map (whose key
    // equals the bank `audio_file`). `targetWord` is the same value as a fallback.
    identity: (rec) => rec.audioTranscript || rec.targetWord,
    hasResponse: (rec) => rec.chosenIndex !== null && rec.chosenIndex !== undefined,
    defaultChance: 0.25,
    humanJoin: true,
    crowdinFile: 'vocab',
    draftTask: 'vocab',
  },
  /** Matrix Reasoning — identity is stimulus asset key (shared prompt audio/text). */
  matrix: {
    title: 'Matrix Reasoning',
    diagTask: null,
    scoredType: 'item',
    itemBank: join(CORPORA, 'matrix-reasoning', 'shared', 'corpora', 'matrix-reasoning-item-bank.csv'),
    identity: (rec) => rec.stimulusAlt,
    hasResponse: (rec) => rec.chosenIndex !== null && rec.chosenIndex !== undefined,
    defaultChance: 0.25,
    humanJoin: true,
    joinByItemId: true,
    crowdinFile: null,
    draftTask: 'matrix-reasoning',
  },
  swr: {
    title: 'ROAR SWR (Single Word Recognition) VLM difficulty screen',
    diagTask: null,
    scoredType: 'item',
    itemBank: null,
    identity: (rec) => rec.promptText,
    hasResponse: (rec) => rec.chosenLr !== null && rec.chosenLr !== undefined,
    defaultChance: 0.5,
    humanJoin: false,
  },
  sre: {
    title: 'ROAR SRE (Sentence Reading Efficiency) VLM difficulty screen',
    diagTask: null,
    scoredType: 'item',
    itemBank: null,
    identity: (rec) => rec.promptText,
    hasResponse: (rec) => rec.chosenLr !== null && rec.chosenLr !== undefined,
    defaultChance: 0.5,
    humanJoin: false,
  },
};

function parseTaskArg(argv) {
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--task') return argv[i + 1];
    if (argv[i].startsWith('--task=')) return argv[i].slice('--task='.length);
  }
  return 'trog';
}
function parseArg(argv, name) {
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === `--${name}`) return argv[i + 1];
    if (argv[i].startsWith(`--${name}=`)) return argv[i].slice(name.length + 3);
  }
  return null;
}
const TASK_NAME = parseTaskArg(process.argv);
const TASK = TASKS[TASK_NAME];
if (!TASK) {
  console.error(`Unknown --task "${TASK_NAME}". Known: ${Object.keys(TASKS).join(', ')}`);
  process.exit(1);
}
const ITEM_BANK = TASK.itemBank;
const EXTERNAL_HUMAN_CSV = parseArg(process.argv, 'human-csv');
/** `diag` (default) = pilots diag join; `bench` = levante-bench proportions image1. */
const HUMAN_SOURCE = (parseArg(process.argv, 'human-source') || 'diag').toLowerCase();
/** Optional runId substring/regex filter (e.g. `35flashlite|36flash` to drop 2.5 cells). */
const RUN_ID_RE_RAW = parseArg(process.argv, 'run-id-re');
const RUN_ID_RE = RUN_ID_RE_RAW ? new RegExp(RUN_ID_RE_RAW) : null;
if (RUN_ID_RE) console.log(`[filter] --run-id-re=${RUN_ID_RE_RAW}`);
// Output filename tag: trog keeps the legacy bare names; other tasks namespace
// their outputs so panels never clobber each other.
const TAG = TASK_NAME === 'trog' ? '' : `_${TASK_NAME}`;

const AGE_ITEM_RATES = loadAgeItemRatesJson(
  join(HERE, 'calibration', `age_item_rates_${TASK_NAME}.json`),
);
const BENCH_ITEM_PASS = (() => {
  const path = join(HERE, 'calibration', `item_pass_rates_${TASK_NAME}.json`);
  const raw = loadAgeItemRatesJson(path);
  if (!raw?.items) return new Map();
  return new Map(
    Object.entries(raw.items).map(([k, v]) => [k, Number(v)]).filter(([, v]) => Number.isFinite(v)),
  );
})();

const LOW_DISCRIM = 0.1; // point-biserial below this = "low/anti-discriminating"

// ---------- small helpers ----------
/**
 * Full RFC-4180-ish CSV parser: handles quoted fields containing commas,
 * newlines, and escaped quotes (""). The ToM translation/prose cells embed all
 * three, so a line-based splitter mis-parses them.
 */
function parseCsv(txt) {
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (q) {
      if (c === '"') {
        if (txt[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(cur);
      cur = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && txt[i + 1] === '\n') i++;
      row.push(cur);
      cur = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cur += c;
  }
  if (cur !== '' || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

function readCsv(path) {
  const rows = parseCsv(readFileSync(path, 'utf-8'));
  if (rows.length === 0) return [];
  const header = rows[0];
  return rows.slice(1).map((cells) => {
    const row = {};
    header.forEach((h, i) => (row[h] = cells[i]));
    return row;
  });
}

function normText(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function numOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === '' || s === 'NA' || s === 'NaN') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

function ranks(xs) {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1; // average rank, 1-based
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}

function spearman(xs, ys) {
  const pairs = xs.map((x, i) => [x, ys[i]]).filter(([a, b]) => a != null && b != null);
  if (pairs.length < 3) return null;
  return pearson(ranks(pairs.map((p) => p[0])), ranks(pairs.map((p) => p[1])));
}

function fmt(x, d = 3) {
  return x == null || Number.isNaN(x) ? '' : Number(x).toFixed(d);
}

/** runId -> language, from the manifest (falls back to the run-id token). */
function runLanguageMap() {
  const m = new Map();
  const manifest = join(OUT_DIR, 'manifest.json');
  if (existsSync(manifest)) {
    try {
      for (const r of JSON.parse(readFileSync(manifest, 'utf-8'))) {
        if (r.runId && r.language) m.set(r.runId, r.language);
      }
    } catch {
      /* ignore */
    }
  }
  return m;
}

/** Language token from a run id like panel_trog_en_25flash_a6_r1 -> "en". */
function langFromRunId(runId, langMap) {
  if (langMap.has(runId)) return langMap.get(runId);
  const parts = runId.split('_');
  return parts.length >= 3 ? parts[2] : 'en';
}

/** Task token from a run id like panel_stories_en_25flash_a6_r1 -> "stories". */
function taskFromRunId(runId) {
  const parts = runId.split('_');
  return parts.length >= 2 ? parts[1] : '';
}

// ---------- 1+2: load panel into respondent x item matrix (one language) ----------
function loadPanel(language) {
  if (!existsSync(RUNS_DIR)) return { respondents: [], items: new Map() };
  const langMap = runLanguageMap();
  const runDirs = readdirSync(RUNS_DIR)
    .filter((d) => d.startsWith('panel_'))
    .filter((d) => taskFromRunId(d) === TASK_NAME)
    .filter((d) => langFromRunId(d, langMap) === language)
    .filter((d) => (RUN_ID_RE ? RUN_ID_RE.test(d) : true));
  if (RUN_ID_RE) {
    console.log(`[filter] ${language}: ${runDirs.length} run dir(s) match --run-id-re`);
  }
  const respondents = [];
  // item key -> { transcript, byResp: Map(runId -> 0/1) }
  const items = new Map();
  let attempts = 0; // scored question encounters
  let nonResponse = 0; // of those, the model emitted no parseable choice

  for (const runId of runDirs) {
    const dir = join(RUNS_DIR, runId);
    const files = readdirSync(dir).filter((f) => /^vlm_.*\.jsonl?$/.test(f));
    if (files.length === 0) continue;
    // Prefer the finalized full-records file (largest) over the live append log.
    const file = files
      .map((f) => ({ f, size: readFileSync(join(dir, f), 'utf-8').length }))
      .sort((a, b) => b.size - a.size)[0].f;

    const seen = new Map(); // item key -> 0/1 (first ANSWERED attempt only)
    for (const line of readFileSync(join(dir, file), 'utf-8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.itemType !== TASK.scoredType || typeof rec.correct !== 'boolean') continue;
      const key = normText(TASK.identity(rec));
      if (!key) continue;
      attempts++;
      // A null/absent choice is a NON-RESPONSE (model emitted no parseable
      // digit), not a wrong answer. Counting it as 0 deflates p_vlm and, since
      // non-response rates differ by language, fabricates cross-language
      // "difficulty". Treat it as missing.
      if (!TASK.hasResponse(rec)) {
        nonResponse++;
        continue;
      }
      if (!seen.has(key)) seen.set(key, rec.correct ? 1 : 0);
      if (!items.has(key)) items.set(key, { transcript: rec.audioTranscript, byResp: new Map() });
    }
    if (seen.size === 0) continue;
    respondents.push({ runId, answers: seen });
    for (const [key, val] of seen) items.get(key).byResp.set(runId, val);
  }
  return { respondents, items, attempts, nonResponse };
}

// ---------- 4: per-item p and corrected point-biserial ----------
function itemStats(respondents, items) {
  // common item set: answered by a strong majority of respondents
  const nResp = respondents.length;
  const minCoverage = Math.max(1, Math.ceil(nResp * 0.6));
  const commonKeys = [...items.keys()].filter((k) => items.get(k).byResp.size >= minCoverage);

  // per-respondent total over the common item set
  const totals = new Map();
  for (const r of respondents) {
    let s = 0;
    let n = 0;
    for (const k of commonKeys) {
      if (r.answers.has(k)) {
        s += r.answers.get(k);
        n++;
      }
    }
    totals.set(r.runId, { sum: s, n, p: n ? s / n : NaN });
  }

  const stats = [];
  for (const k of commonKeys) {
    const it = items.get(k);
    const xs = []; // item score
    const ts = []; // rest score (total minus this item)
    let correct = 0;
    let n = 0;
    for (const r of respondents) {
      if (!r.answers.has(k)) continue;
      const x = r.answers.get(k);
      const tot = totals.get(r.runId);
      const rest = tot.sum - x;
      xs.push(x);
      ts.push(rest);
      correct += x;
      n++;
    }
    stats.push({
      key: k,
      transcript: it.transcript,
      n,
      p_vlm: n ? correct / n : NaN,
      rpb_vlm: pearson(xs, ts), // corrected (rest-score) point-biserial
    });
  }
  return { commonKeys, totals, stats, minCoverage };
}

// Per-language human-IRT diag subset (levante-pilots research data — NOT a
// translation-string source). Keyed by primary subtag. Languages absent here
// (or pre-launch, like nl) have no human data; p_human stays null, which is fine
// — the cross-language difficulty shift only needs p_vlm aligned by item_uid.
const LANG_DIAG = { en: 'en', de: 'de', es: 'es', nl: 'nl' };

/** Primary subtag, lowercased: "en-US" -> "en", "nl" -> "nl". */
function primarySubtag(language) {
  return String(language ?? '')
    .trim()
    .toLowerCase()
    .split(/[-_]/)[0];
}

/**
 * Load the approved item-bank strings ({ item_id: string }) for one task+locale
 * from the draft bucket JSON published by the localization pipeline. Throws on a
 * missing/!200 object — we do NOT fall back to a CSV/XLIFF.
 */
async function loadDraftItembankStrings(draftTask, locale) {
  const map = new Map();
  if (!draftTask || !locale) return map;
  const url = `${DRAFT_ITEMBANK_BASE}/${draftTask}/${locale}/item-bank-translations.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`draft itembank HTTP ${res.status} for ${draftTask}/${locale} (${url})`);
  const json = await res.json();
  for (const [itemId, text] of Object.entries(json ?? {})) {
    if (typeof text === 'string' && text.trim()) map.set(itemId, text);
  }
  return map;
}

// --- Crowdin direct (non-hidden, approved) ---------------------------------
function crowdinToken() {
  const fromEnv = process.env.CROWDIN_API_TOKEN || process.env.CROWDIN_TOKEN;
  if (fromEnv?.trim()) return fromEnv.trim();
  const tokenPath = join(homedir(), '.crowdin_api_token');
  if (existsSync(tokenPath)) return readFileSync(tokenPath, 'utf-8').trim();
  throw new Error('Crowdin token not found. Set CROWDIN_API_TOKEN or create ~/.crowdin_api_token.');
}

function crowdinProjectId() {
  return process.env.CROWDIN_PROJECT_ID || '756721';
}

/** Page through a Crowdin list endpoint (500/page), yielding each row's `data`. */
async function* crowdinPages(path, token) {
  const sep = path.includes('?') ? '&' : '?';
  for (let offset = 0; ; offset += 500) {
    const res = await fetch(`${CROWDIN_API_BASE}${path}${sep}limit=500&offset=${offset}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Crowdin ${res.status} for ${path}: ${await res.text()}`);
    const body = await res.json();
    const rows = body.data ?? [];
    for (const row of rows) yield row.data;
    if (rows.length < 500) return;
  }
}

// Project strings are language-independent; cache the non-hidden id map across
// the per-language prefetch loop.
let CROWDIN_STRINGS_CACHE = null;
async function crowdinNonHiddenStringIds(token) {
  if (CROWDIN_STRINGS_CACHE) return CROWDIN_STRINGS_CACHE;
  const proj = crowdinProjectId();
  const byStringId = new Map(); // stringId -> identifier (item_id)
  for await (const s of crowdinPages(`/projects/${proj}/strings`, token)) {
    if (s && !s.isHidden && s.identifier) byStringId.set(s.id, s.identifier);
  }
  CROWDIN_STRINGS_CACHE = byStringId;
  return byStringId;
}

/**
 * Build item_id -> approved string for one Crowdin language id by reading the
 * project's non-hidden strings and the language's APPROVED translations directly
 * from the Crowdin API (no export/build, no XLIFF). The string identifier is the
 * item_id, the same namespace as the corpus item bank.
 */
async function loadCrowdinApprovedStrings(crowdinLangId) {
  const map = new Map();
  if (!crowdinLangId) return map;
  const token = crowdinToken();
  const proj = crowdinProjectId();
  const idByStringId = await crowdinNonHiddenStringIds(token);
  // /languages/{id}/translations returns the approved translation per string.
  for await (const t of crowdinPages(`/projects/${proj}/languages/${crowdinLangId}/translations`, token)) {
    const itemId = idByStringId.get(t?.stringId);
    if (itemId && typeof t.text === 'string' && t.text.trim() && !map.has(itemId)) {
      map.set(itemId, t.text);
    }
  }
  return map;
}

/**
 * Dispatch to the configured translation-string source and return the
 * item_id -> approved string map for one run language. Throws on source failure
 * (no CSV/XLIFF fallback by design).
 */
async function loadItembankStrings(language) {
  const locale = resolveLocale(language);
  if (TRANSLATION_SOURCE === 'crowdin' || TRANSLATION_SOURCE === 'crowdin-approved') {
    return loadCrowdinApprovedStrings(LOCALE_TO_CROWDIN[locale] || locale);
  }
  return loadDraftItembankStrings(TASK.draftTask, locale);
}

// ---------- 5: human join ----------
// Chain: normalized transcript (in the run language) -> item_id (approved
// itembank strings) -> item_uid (corpus item bank) -> human stats (diag).
function buildHumanJoin(language) {
  if (!TASK.humanJoin || !ITEM_BANK) {
    return { transcriptToUid: new Map(), transcriptToChance: new Map(), uidToHuman: new Map() };
  }
  const diagSubset = LANG_DIAG[primarySubtag(language)] ?? LANG_DIAG.en;

  // diag: item_uid -> {p_correct, point_biserial, flag_pb}
  const diag = readCsv(DIAG_CSV);
  const uidToHuman = new Map();
  if (TASK.diagTask) {
    for (const r of diag) {
      if (r.task !== TASK.diagTask || r.subset !== diagSubset) continue;
      const uid = String(r.item).replace(/-\d+$/, '');
      if (!uidToHuman.has(uid)) {
        uidToHuman.set(uid, {
          p_correct: numOrNull(r.p_correct),
          point_biserial: numOrNull(r.point_biserial),
          flag_pb: r.flag_pb,
        });
      }
    }
  }

  // Matrix (and similar): panel identity is bank item_id / stimulusAlt. Prompts
  // share audio+text, so transcript→item_id would collapse items. Index by
  // item_id only — never prefer shared audio_file keys.
  if (TASK.joinByItemId) {
    const bank = readCsv(ITEM_BANK);
    const transcriptToUid = new Map();
    const transcriptToChance = new Map();
    for (const r of bank) {
      const id = String(r.item_id || r.item || '').trim();
      if (!id) continue;
      const key = normText(id);
      if (r.item_uid) transcriptToUid.set(key, r.item_uid);
      const ch = numOrNull(r.chance_level);
      if (ch != null && ch > 0 && ch < 1) transcriptToChance.set(key, ch);
    }
    return { transcriptToUid, transcriptToChance, uidToHuman };
  }

  // translations: normalized spoken text -> item_id, by inverting the approved
  // itembank strings prefetched in main() (draft bucket JSON, or Crowdin API).
  const textToId = new Map();
  for (const [itemId, text] of ITEMBANK_STRINGS[language] ?? new Map()) {
    const t = normText(text);
    if (t && !textToId.has(t)) textToId.set(t, itemId);
  }
  // item bank: item_id / audio_file -> item_uid (+ per-item chance level)
  const bank = readCsv(ITEM_BANK);
  const idToUid = new Map();
  const idToChance = new Map();
  for (const r of bank) {
    const id = r.audio_file || r.item_id;
    if (!id) continue;
    if (r.item_uid) idToUid.set(id, r.item_uid);
    const ch = numOrNull(r.chance_level);
    if (ch != null && ch > 0 && ch < 1) idToChance.set(id, ch);
  }

  const transcriptToUid = new Map();
  const transcriptToChance = new Map();
  for (const [t, id] of textToId) {
    const uid = idToUid.get(id);
    if (uid) transcriptToUid.set(t, uid);
    const ch = idToChance.get(id);
    if (ch != null) transcriptToChance.set(t, ch);
  }
  return { transcriptToUid, transcriptToChance, uidToHuman };
}

/**
 * Optional external human join for tasks not yet in diag/translations (e.g.
 * SWR/SRE while sourcing human item data from Redivis).
 *
 * Expected CSV columns:
 *   - item_key (or item / promptText) : item text/key
 *   - subset (or language)            : en|de|es (or locale like en-US)
 *   - p_correct                       : human pass-rate
 *   - point_biserial                  : optional discrimination
 *   - chance (or chance_level)        : optional chance level per item
 */
function loadExternalHuman(language) {
  if (!EXTERNAL_HUMAN_CSV) return null;
  if (!existsSync(EXTERNAL_HUMAN_CSV)) {
    throw new Error(`--human-csv not found: ${EXTERNAL_HUMAN_CSV}`);
  }
  const rows = readCsv(EXTERNAL_HUMAN_CSV);
  const byKey = new Map();
  for (const r of rows) {
    const rawLang = String(r.subset ?? r.language ?? '').trim().toLowerCase();
    const langToken = rawLang.split('-')[0];
    if (langToken && langToken !== language) continue;
    const key = normText(r.item_key ?? r.item ?? r.promptText);
    if (!key) continue;
    byKey.set(key, {
      p_correct: numOrNull(r.p_correct),
      point_biserial: numOrNull(r.point_biserial),
      chance: numOrNull(r.chance ?? r.chance_level),
    });
  }
  return byKey;
}

const CEILING_HUMAN = 0.95; // human pass-rate above which an item is uninformative

function quantile(sorted, q) {
  if (sorted.length === 0) return NaN;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** Languages that have at least one panel run on disk for the active task. */
function discoverLanguages() {
  if (!existsSync(RUNS_DIR)) return [];
  const langMap = runLanguageMap();
  const set = new Set();
  for (const d of readdirSync(RUNS_DIR)) {
    if (d.startsWith('panel_') && taskFromRunId(d) === TASK_NAME) {
      set.add(langFromRunId(d, langMap));
    }
  }
  return [...set].sort();
}

/** Prefer analyzing `en` first so other locales can reuse its calibrator. */
function languagesForAnalyze(langs) {
  return [...langs].sort((a, b) => {
    if (a === 'en') return -1;
    if (b === 'en') return 1;
    return a.localeCompare(b);
  });
}

/**
 * Classify an item into a screen flag from its panel pass-rate. Below chance
 * across a wide-ability panel is the strong "broken / mis-keyed / mistranslated"
 * signal; the rest is panel-relative (p_vlm is compressed, so absolute cutoffs
 * other than chance are unreliable).
 */
function classify(p_vlm, chance, hardCut, ceilCut) {
  if (p_vlm < chance) return { flag: 'BROKEN', reason: `p_vlm ${fmt(p_vlm, 2)} < chance ${fmt(chance, 2)}` };
  if (p_vlm <= hardCut) return { flag: 'HARD', reason: `bottom of panel (p_vlm ${fmt(p_vlm, 2)})` };
  if (p_vlm >= ceilCut) return { flag: 'CEILING', reason: `top of panel (p_vlm ${fmt(p_vlm, 2)})` };
  return { flag: 'OK', reason: '' };
}

/** Run the whole pipeline + screen for one language; returns a report section. */
function analyzeLanguage(language) {
  const { respondents, items, attempts, nonResponse } = loadPanel(language);
  if (respondents.length === 0) return null;
  const nonRespRate = attempts ? nonResponse / attempts : 0;
  const externalHuman = loadExternalHuman(language);
  const hasHumanJoin = TASK.humanJoin || !!externalHuman;

  const { commonKeys, totals, stats, minCoverage } = itemStats(respondents, items);

  // spread gate
  const totalP = respondents.map((r) => totals.get(r.runId).p).filter((v) => !Number.isNaN(v));
  totalP.sort((a, b) => a - b);
  const sdSpread = (() => {
    const mu = mean(totalP);
    return Math.sqrt(mean(totalP.map((v) => (v - mu) ** 2)));
  })();
  const spreadOk = sdSpread >= 0.08 && totalP[0] < 0.85 && totalP[totalP.length - 1] > 0.4;

  // human join
  const { transcriptToUid, transcriptToChance, uidToHuman } = buildHumanJoin(language);
  const rows = [];
  let matched = 0;
  for (const s of stats) {
    const uid = TASK.humanJoin ? (transcriptToUid.get(s.key) ?? null) : s.key;
    const human = externalHuman ? externalHuman.get(s.key) : uid ? uidToHuman.get(uid) : null;
    if (human) matched++;
    rows.push({
      ...s,
      item_uid: uid,
      chance: human?.chance ?? transcriptToChance.get(s.key) ?? TASK.defaultChance,
      p_human: human?.p_correct ?? null,
      pb_human: human?.point_biserial ?? null,
    });
  }

  // Optional: replace pooled diag p_human with levante-bench trial pass-rates.
  // Run fit_bench_calibrator.mjs first to build item_pass_rates_*.json.
  if (HUMAN_SOURCE === 'bench') {
    let benchMatched = 0;
    for (const r of rows) {
      const key = normalizeItemUid(TASK_NAME, r.item_uid);
      if (key && BENCH_ITEM_PASS.has(key)) {
        r.p_human = BENCH_ITEM_PASS.get(key);
        r.human_source = 'bench';
        benchMatched++;
      } else {
        r.p_human = null;
        r.human_source = null;
      }
    }
    matched = benchMatched;
    if (BENCH_ITEM_PASS.size === 0) {
      console.error(
        `WARN: --human-source=bench but missing calibration/item_pass_rates_${TASK_NAME}.json; ` +
          `run: node tools/vlm-panel/fit_bench_calibrator.mjs --task ${TASK_NAME}`,
      );
    }
  }

  // screen flags (panel-relative cutoffs; BROKEN uses each item's own chance)
  const pSorted = [...rows.map((r) => r.p_vlm)].sort((a, b) => a - b);
  const hardCut = quantile(pSorted, 0.15);
  const ceilCut = quantile(pSorted, 0.9);
  const knownIssues = loadKnownIssues(TASK_NAME);
  for (const r of rows) {
    const c = classify(r.p_vlm, r.chance, hardCut, ceilCut);
    r.flag = c.flag;
    r.reason = c.reason;
    if (r.item_uid && knownIssues.has(r.item_uid)) {
      r.knownIssue = knownIssues.get(r.item_uid);
      r.reason = `KNOWN: ${r.knownIssue}` + (r.reason ? ` | ${r.reason}` : '');
    }
  }
  const flagCounts = rows.reduce((a, r) => ((a[r.flag] = (a[r.flag] ?? 0) + 1), a), {});

  // correlations (only when human joins exist for this task)
  const m = rows.filter((r) => r.p_human != null);
  const rhoDiff = spearman(m.map((r) => r.p_vlm), m.map((r) => r.p_human));
  const md = rows.filter((r) => r.pb_human != null && r.rpb_vlm != null);
  const rhoDisc = spearman(md.map((r) => r.rpb_vlm), md.map((r) => r.pb_human));

  // threshold validation against human labels (matched items only)
  const hBroken = m.filter((r) => r.p_human < r.chance);
  const hBrokenCaught = hBroken.filter((r) => r.flag === 'BROKEN' || r.flag === 'HARD').length;
  const vConcern = m.filter((r) => r.flag === 'BROKEN' || r.flag === 'HARD');
  const vConcernHumanHard = vConcern.filter((r) => r.p_human < 0.5).length;
  const hCeil = m.filter((r) => r.p_human > CEILING_HUMAN);
  const hCeilCaught = hCeil.filter((r) => r.flag === 'CEILING' || r.p_vlm >= ceilCut).length;

  // ---- child-performance calibrator (ungated p_vlm → predicted child p) ----
  // Prefer a language-specific fit when enough human joins exist; otherwise reuse
  // the en calibrator so new locales still get absolute predictions.
  const defaultChance = TASK.defaultChance;
  const calPairs = m.map((r) => ({ p_vlm: r.p_vlm, p_human: r.p_human }));
  const calLang = HUMAN_SOURCE === 'bench' ? `${language}_bench` : language;
  const calSourceLang = HUMAN_SOURCE === 'bench' ? 'en_bench' : 'en';
  const cal = resolveCalibrator({
    task: TASK_NAME,
    language: calLang,
    pairs: calPairs,
    sourceLang: calSourceLang,
    chance: defaultChance,
    cvChance: defaultChance,
  });
  const vocabLex = TASK_NAME === 'vocab' ? loadVocabLexicon() : null;
  for (const r of rows) {
    const chance = r.chance ?? defaultChance;
    let pPred = predictChild(cal.model, r.p_vlm, chance);
    if (vocabLex) {
      pPred = blendVocabPrior(pPred, {
        itemUid: r.item_uid,
        transcript: r.transcript,
        chance,
        lexicon: vocabLex,
      });
    }
    r.p_pred_child = pPred;
    r.p_pred_age = ageAdjustedPredictions(TASK_NAME, r.p_pred_child, chance, {
      itemUid: normalizeItemUid(TASK_NAME, r.item_uid),
      ageItemRates: AGE_ITEM_RATES,
    });
  }

  // ---- write screen_<lang>.csv (all items) ----
  const ageCols = PRED_AGES.map((a) => `p_pred_age_${a}`);
  const scrHeader = [
    'item_uid',
    'flag',
    'reason',
    'n_resp',
    'p_vlm',
    'rpb_vlm',
    'p_human',
    'pb_human',
    'p_pred_child',
    ...ageCols,
    'transcript',
  ];
  const scr = [scrHeader.join(',')];
  for (const r of [...rows].sort((a, b) => a.p_vlm - b.p_vlm)) {
    scr.push(
      [
        r.item_uid ?? '',
        r.flag,
        `"${r.reason}"`,
        r.n,
        fmt(r.p_vlm),
        fmt(r.rpb_vlm),
        fmt(r.p_human),
        fmt(r.pb_human),
        fmt(r.p_pred_child),
        ...PRED_AGES.map((a) => fmt(r.p_pred_age?.[String(a)] ?? null)),
        `"${String(r.transcript ?? '').replace(/"/g, '""')}"`,
      ].join(','),
    );
  }
  writeFileSync(join(OUT_DIR, `screen${TAG}_${language}.csv`), scr.join('\n') + '\n', 'utf-8');

  // ---- write review_<lang>.csv (only items needing review, prioritized) ----
  // known_issues.json entries are suppressed from triage (still on screen_*.csv).
  const order = { BROKEN: 0, HARD: 1, CEILING: 2 };
  const review = rows
    .filter((r) => r.flag !== 'OK')
    .filter((r) => !r.knownIssue)
    .sort((a, b) => (order[a.flag] - order[b.flag]) || a.p_vlm - b.p_vlm);
  const knownSuppressed = rows.filter((r) => r.knownIssue);
  const rv = [['priority', 'item_uid', 'flag', 'p_vlm', 'p_human', 'p_pred_child', 'transcript'].join(',')];
  review.forEach((r, i) =>
    rv.push(
      [
        i + 1,
        r.item_uid ?? '',
        r.flag,
        fmt(r.p_vlm),
        fmt(r.p_human),
        fmt(r.p_pred_child),
        `"${String(r.transcript ?? '').replace(/"/g, '""')}"`,
      ].join(','),
    ),
  );
  writeFileSync(join(OUT_DIR, `review${TAG}_${language}.csv`), rv.join('\n') + '\n', 'utf-8');
  // ---- report section ----
  const s = [];
  s.push(`## ${language.toUpperCase()}`);
  if (hasHumanJoin) {
    s.push(
      `- Respondents: **${respondents.length}** | common items (coverage >= ${minCoverage}): **${commonKeys.length}** | matched to human: **${matched}**`,
    );
  } else {
    s.push(
      `- Respondents: **${respondents.length}** | common items (coverage >= ${minCoverage}): **${commonKeys.length}**`,
    );
  }
  s.push(`- Non-response: **${fmt(nonRespRate * 100, 1)}%** of scored encounters had no parseable VLM choice (excluded, not scored wrong)`);
  s.push(`- Spread: min ${fmt(totalP[0], 2)}, median ${fmt(totalP[Math.floor(totalP.length / 2)], 2)}, max ${fmt(totalP[totalP.length - 1], 2)}, SD ${fmt(sdSpread, 2)} -> ${spreadOk ? 'OK' : 'INADEQUATE'}`);
  s.push('');
  s.push('### Screen flags');
  s.push(`- BROKEN (below chance): **${flagCounts.BROKEN ?? 0}** | HARD: **${flagCounts.HARD ?? 0}** | CEILING: **${flagCounts.CEILING ?? 0}** | OK: ${flagCounts.OK ?? 0}`);
  if (knownSuppressed.length) {
    s.push(
      `- Known issues suppressed from review: **${knownSuppressed.length}** (` +
        knownSuppressed.map((r) => `\`${r.item_uid}\``).join(', ') +
        `) — see \`known_issues.json\``,
    );
  }
  s.push(`- Review list: \`out/review${TAG}_${language}.csv\` | full screen: \`out/screen${TAG}_${language}.csv\``);
  s.push('');
  if (hasHumanJoin) {
    s.push('### Validation vs human labels (matched items)');
    s.push(`- Spearman rho difficulty (p_vlm vs human p_correct), n=${m.length}: **${fmt(rhoDiff)}**`);
    s.push(`- Spearman rho discrimination (rpb_vlm vs human point_biserial), n=${md.length}: **${fmt(rhoDisc)}**`);
    s.push(
      `- BROKEN catch: of ${hBroken.length} human below-chance item(s), VLM flagged **${hBrokenCaught}** as BROKEN/HARD`,
    );
    s.push(
      `- BROKEN/HARD precision: of ${vConcern.length} VLM-flagged item(s), **${vConcernHumanHard}** are human-hard (p_correct < 0.5)`,
    );
    s.push(
      `- CEILING catch: of ${hCeil.length} human-ceiling item(s) (p>${CEILING_HUMAN}), VLM flagged **${hCeilCaught}**`,
    );
    s.push('');
  } else {
    s.push('### Validation vs human labels');
    s.push('- Human item-level joins are not yet wired for this task in `diag_items_allstats_selected.csv` / translations.');
    s.push('');
  }

  s.push(
    formatCalibrationReport({
      language,
      source: cal.source,
      path: cal.path,
      cv: cal.cv,
      fitted: cal.fitted,
      nMatched: m.length,
      inSample: cal.model ? inSampleMetrics(calPairs, cal.model, defaultChance) : null,
    }),
  );

  const maeNote =
    cal.cv?.maeCal != null && cal.cv?.maeRaw != null
      ? ` maeCal=${fmt(cal.cv.maeCal, 2)}/raw=${fmt(cal.cv.maeRaw, 2)}`
      : '';
  const summary = hasHumanJoin
    ? `${language}: resp=${respondents.length} items=${commonKeys.length} flags[B${flagCounts.BROKEN ?? 0}/H${flagCounts.HARD ?? 0}/C${flagCounts.CEILING ?? 0}] rhoDiff=${fmt(rhoDiff, 2)} brokenCatch=${hBrokenCaught}/${hBroken.length}${maeNote}`
    : `${language}: resp=${respondents.length} items=${commonKeys.length} flags[B${flagCounts.BROKEN ?? 0}/H${flagCounts.HARD ?? 0}/C${flagCounts.CEILING ?? 0}]${maeNote}`;
  return { section: s.join('\n'), summary };
}

// ---------- main ----------
async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const langs = discoverLanguages();
  if (langs.length === 0) {
    console.error(`No panel runs found under ${RUNS_DIR}. Run tools/vlm-panel/run_panel.mjs first.`);
    process.exit(1);
  }

  // Prefetch the approved itembank strings (item_id -> string) for each language
  // from the configured source (draft bucket JSON by default, or the Crowdin API
  // when QA_TRANSLATIONS_SOURCE=crowdin), so the otherwise-synchronous
  // join/cross-language pipeline can read them without async plumbing.
  if (TASK.humanJoin && !TASK.joinByItemId) {
    console.error(`[strings] source=${TRANSLATION_SOURCE} task=${TASK.draftTask}`);
    for (const lang of langs) {
      try {
        ITEMBANK_STRINGS[lang] = await loadItembankStrings(lang);
      } catch (err) {
        ITEMBANK_STRINGS[lang] = new Map();
        console.error(
          `WARN: no ${TRANSLATION_SOURCE} translation strings for "${lang}" (${resolveLocale(lang)}): ` +
            `${err.message}. Per-language screen still works; ${lang}<->en item alignment will be empty.`,
        );
        continue;
      }
      if (ITEMBANK_STRINGS[lang].size === 0) {
        console.error(
          `WARN: empty ${TRANSLATION_SOURCE} translation-string map for "${lang}" (${resolveLocale(lang)}); ` +
            `${lang}<->en item alignment will be empty.`,
        );
      }
    }
  } else if (TASK.joinByItemId) {
    console.error(`[strings] joinByItemId=true task=${TASK_NAME} (skip transcript string map)`);
  }

  const rep = [`# ${TASK.title} VLM difficulty screen`, '', `Generated: ${new Date().toISOString()}`, ''];
  rep.push(
    'A pre-launch screen: a panel of VLM "children" of varying ability answers each item; ' +
      'items the panel passes **below chance** are flagged BROKEN (candidate mis-key/mistranslation), ' +
      'the panel-hardest items HARD, and panel-easiest CEILING (uninformative). Flags are validated ' +
      'against human pass-rates where those exist.',
  );
  rep.push('');

  // Failure triage first: a panel that Google ate (TOOL failures) is not
  // trustworthy for content, and any -dev/app failure is a readiness flag.
  const reliability = summarizeFailures(join(OUT_DIR, 'manifest.json'), { task: TASK_NAME, langs });
  const scopeLabel = `${TASK_NAME}/${langs.join('+')}`;
  rep.push(renderSummaryMarkdown(reliability, scopeLabel));
  if (reliability.ok && reliability.failed > 0) {
    console.log(
      `[reliability] ${scopeLabel}: ${reliability.failed} failed ` +
        `(TOOL ${reliability.buckets.tool} / -dev ${reliability.buckets.dev} / unknown ${reliability.buckets.unknown})` +
        `${reliability.inconclusive ? ' — INCONCLUSIVE for content' : ''}`,
    );
  }

  for (const lang of languagesForAnalyze(langs)) {
    const out = analyzeLanguage(lang);
    if (!out) continue;
    rep.push(out.section);
    console.log(out.summary);
  }

  // cross-language difficulty shift (vs en) -- the translation-breakage signal
  if (langs.includes('en') && langs.length > 1) {
    rep.push(crossLanguageSection(langs));
    writeCrossLanguageReviewCsvs(langs);
  }

  writeFileSync(join(OUT_DIR, `report${TAG}.md`), rep.join('\n') + '\n', 'utf-8');
  console.log(`Wrote out/report${TAG}.md, out/screen${TAG}_<lang>.csv, out/review${TAG}_<lang>.csv`);
  if (langs.includes('en') && langs.length > 1) {
    console.log(`Wrote out/review_xlang${TAG}_<lang>.csv (delta vs en; |delta|>=0.25 = strong candidates)`);
  }
}

/**
 * Cross-language difficulty shift: per item, p_vlm(lang) - p_vlm(en). A large
 * negative shift in a target language is the strongest pre-launch signal of a
 * broken translation (the item-78 signature), and it cancels panel composition.
 */
function crossLanguageSection(langs) {
  const byLang = {};
  for (const lang of langs) {
    const { respondents, items } = loadPanel(lang);
    const { stats } = itemStats(respondents, items);
    const joins = TASK.humanJoin ? buildHumanJoin(lang) : null;
    const m = new Map();
    for (const s of stats) {
      const id = TASK.humanJoin ? joins.transcriptToUid.get(s.key) : s.key;
      if (id) m.set(id, s.p_vlm);
    }
    byLang[lang] = m;
  }
  const label = TASK.humanJoin ? 'item_uid' : 'item_key';
  const s = ['## Cross-language difficulty shift vs en (translation-breakage signal)'];
  s.push('');
  s.push(
    'Spreadsheet triage: `out/review_xlang' +
      TAG +
      '_<lang>.csv` (all items sorted by delta; |delta| ≥ 0.25 is a strong candidate).',
  );
  for (const lang of langs.filter((l) => l !== 'en')) {
    const deltas = [];
    for (const [uid, pEn] of byLang.en) {
      const pT = byLang[lang]?.get(uid);
      if (pT != null) deltas.push({ uid, pEn, pT, delta: pT - pEn });
    }
    deltas.sort((a, b) => a.delta - b.delta);
    s.push('');
    s.push(`### ${lang} - biggest drops vs en (candidate broken translations)`);
    s.push(`| ${label} | p_en | p_${lang} | delta |`);
    s.push('|---|---|---|---|');
    for (const d of deltas.slice(0, 10)) {
      s.push(`| ${d.uid} | ${fmt(d.pEn, 2)} | ${fmt(d.pT, 2)} | ${fmt(d.delta, 2)} |`);
    }
  }
  s.push('');
  return s.join('\n');
}

/** Parse the simple screen_*.csv we just wrote (quoted fields, no nested commas in ids). */
function loadScreenCsv(language) {
  const path = join(OUT_DIR, `screen${TAG}_${language}.csv`);
  if (!existsSync(path)) return new Map();
  const lines = readFileSync(path, 'utf-8').trim().split(/\r?\n/);
  if (lines.length < 2) return new Map();
  const header = splitCsvLine(lines[0]);
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const out = new Map();
  for (const line of lines.slice(1)) {
    const cols = splitCsvLine(line);
    const uid = cols[idx.item_uid];
    if (!uid) continue;
    out.set(uid, {
      item_uid: uid,
      flag: cols[idx.flag] ?? '',
      p_vlm: Number(cols[idx.p_vlm]),
      transcript: cols[idx.transcript] ?? '',
    });
  }
  return out;
}

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * Write review_xlang_<lang>.csv for each non-en language: all joined items
 * sorted by delta = p_lang - p_en (most negative first).
 */
function writeCrossLanguageReviewCsvs(langs) {
  const en = loadScreenCsv('en');
  if (en.size === 0) return;
  const knownIssues = loadKnownIssues(TASK_NAME);
  const XLANG_STRONG = 0.25;
  for (const lang of langs.filter((l) => l !== 'en')) {
    const other = loadScreenCsv(lang);
    if (other.size === 0) continue;
    const rows = [];
    for (const [uid, a] of en) {
      if (knownIssues.has(uid)) continue;
      const b = other.get(uid);
      if (!b || !Number.isFinite(a.p_vlm) || !Number.isFinite(b.p_vlm)) continue;
      const delta = b.p_vlm - a.p_vlm;
      rows.push({
        item_uid: uid,
        p_en: a.p_vlm,
        p_lang: b.p_vlm,
        delta,
        strong: Math.abs(delta) >= XLANG_STRONG ? 'yes' : '',
        flag_en: a.flag,
        flag_lang: b.flag,
        transcript_en: a.transcript,
        transcript_lang: b.transcript,
      });
    }
    rows.sort((x, y) => x.delta - y.delta);
    const header = [
      'item_uid',
      'p_en',
      `p_${lang}`,
      'delta',
      'strong_delta',
      'flag_en',
      `flag_${lang}`,
      'transcript_en',
      `transcript_${lang}`,
    ];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push(
        [
          r.item_uid,
          fmt(r.p_en),
          fmt(r.p_lang),
          fmt(r.delta),
          r.strong,
          r.flag_en,
          r.flag_lang,
          `"${String(r.transcript_en).replace(/"/g, '""')}"`,
          `"${String(r.transcript_lang).replace(/"/g, '""')}"`,
        ].join(','),
      );
    }
    const outPath = join(OUT_DIR, `review_xlang${TAG}_${lang}.csv`);
    writeFileSync(outPath, lines.join('\n') + '\n', 'utf-8');
  }
}

main();
