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
 *
 * Output: out/item_comparison.csv + out/report.md (+ stdout summary).
 *
 * Usage: node tools/vlm-panel/analyze.mjs
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { summarizeFailures, renderSummaryMarkdown } from './classify_failures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const RUNS_DIR = join(REPO, 'cypress', 'logs', 'runs');
const OUT_DIR = join(HERE, 'out');
const CORPORA = join(REPO, '..', 'crowdin-projects', 'corpora');
// Canonical map of approved sentence text -> item_id, the bridge from the VLM's
// spoken text to the item bank (whose `prompt` is a generic template).
const TRANSLATIONS_CSV = join(
  REPO,
  '..',
  'levante_translations',
  'translation_text',
  'item_bank_translations.csv',
);
const DIAG_CSV = join(
  REPO,
  '..',
  'levante-pilots',
  '04_papers',
  'display',
  'diag_items_allstats_selected.csv',
);
// Approved-only Crowdin export (built by the crowdin-approved QA path). Used to
// align languages that have NO column in item_bank_translations.csv (e.g. nl):
// the XLIFF unit id IS the item_id (same namespace as the CSV), so the existing
// item_id -> item_uid -> human chain works unchanged. See loadCrowdinAlignment.
const CROWDIN_CACHE =
  process.env.QA_CROWDIN_CACHE_PATH ||
  join(REPO, 'cypress', 'cache', 'crowdin-approved-translations.zip');
// Per-language Crowdin alignment (normText(approved target) -> item_id),
// prebuilt in main() for languages not carried by the CSV. Empty otherwise.
const CROWDIN_ALIGN = {};

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
  },
  vocab: {
    title: 'Picture Vocabulary (4-AFC)',
    diagTask: 'vocab',
    scoredType: 'word',
    itemBank: join(CORPORA, 'vocab-test', 'shared', 'corpora', 'vocab-item-bank.csv'),
    // The spoken word is the item identity. In placeholder-audio (nl) runs the
    // transcript is the Crowdin-approved target word the mp3 will be generated
    // from, so it aligns to the same item_id via the vocab.xliff unit id (which
    // equals the bank `audio_file`). `targetWord` is the same value as a fallback.
    identity: (rec) => rec.audioTranscript || rec.targetWord,
    hasResponse: (rec) => rec.chosenIndex !== null && rec.chosenIndex !== undefined,
    defaultChance: 0.25,
    humanJoin: true,
    crowdinFile: 'vocab',
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
// Output filename tag: trog keeps the legacy bare names; other tasks namespace
// their outputs so panels never clobber each other.
const TAG = TASK_NAME === 'trog' ? '' : `_${TASK_NAME}`;

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
    .filter((d) => langFromRunId(d, langMap) === language);
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

// Per-language: which translation column carries the spoken text, and which
// diag subset holds the human stats. es tries the regional columns in order.
const LANG_MAP = {
  en: { cols: ['en-US'], diag: 'en' },
  de: { cols: ['de-DE'], diag: 'de' },
  es: { cols: ['es-CO', 'es-AR'], diag: 'es' },
  // nl has no column in item_bank_translations.csv (yet) and no human IRT data
  // (pre-launch). Its text->item_id alignment comes from the Crowdin approved
  // export (CROWDIN_ALIGN); p_human stays null, which is fine — the
  // cross-language difficulty shift only needs p_vlm aligned by item_uid.
  nl: { cols: [], diag: 'nl' },
};

// Languages carried by item_bank_translations.csv columns; others (e.g. nl) are
// aligned from the Crowdin approved export instead, leaving CSV langs untouched.
const CSV_LANGS = new Set(['en', 'de', 'es']);

function decodeXml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Build normText(approved target) -> item_id for one language+task from the
 * cached Crowdin approved-only export. The XLIFF unit id is the item_id (same
 * namespace as item_bank_translations.csv and the corpus item bank), so the
 * downstream item_id -> item_uid -> human/cross-language chain is unchanged.
 * Returns an empty Map if the cache or task file is absent (the per-language
 * BROKEN screen still works; only nl<->en alignment is lost).
 */
async function loadCrowdinAlignment(language, crowdinFile) {
  const map = new Map();
  if (!crowdinFile || !existsSync(CROWDIN_CACHE)) return map;
  let zip;
  try {
    zip = await JSZip.loadAsync(readFileSync(CROWDIN_CACHE));
  } catch {
    return map;
  }
  const file = zip.file(`${language}/main/itembank_by_task/${crowdinFile}.xliff`);
  if (!file) return map;
  const xml = await file.async('string');
  const unitRe =
    /<(?:[^:\s>]+:)?trans-unit\b([^>]*)>([\s\S]*?)<\/(?:[^:\s>]+:)?trans-unit>|<(?:[^:\s>]+:)?unit\b([^>]*)>([\s\S]*?)<\/(?:[^:\s>]+:)?unit>/g;
  for (const m of xml.matchAll(unitRe)) {
    const attrs = m[1] || m[3] || '';
    const body = m[2] || m[4] || '';
    const id = /(?:\sid|resname)="([^"]+)"/.exec(attrs)?.[1];
    const target = /<(?:[^:\s>]+:)?target\b[^>]*>([\s\S]*?)<\/(?:[^:\s>]+:)?target>/.exec(body)?.[1];
    if (!id || !target) continue;
    const t = normText(decodeXml(target.replace(/<[^>]+>/g, '')));
    if (t && !map.has(t)) map.set(t, decodeXml(id));
  }
  return map;
}

// ---------- 5: human join ----------
// Chain: normalized transcript (in the run language) -> item_id (translations)
// -> item_uid (item bank) -> human stats (diag, trog/<lang>).
function buildHumanJoin(language) {
  if (!TASK.humanJoin || !ITEM_BANK) {
    return { transcriptToUid: new Map(), transcriptToChance: new Map(), uidToHuman: new Map() };
  }
  const lang = LANG_MAP[language] ?? LANG_MAP.en;

  // translations: normalized spoken text -> item_id (e.g. "trog-item-1")
  const tr = readCsv(TRANSLATIONS_CSV);
  const textToId = new Map();
  for (const r of tr) {
    for (const col of lang.cols) {
      const t = normText(r[col]);
      if (t && r.item_id && !textToId.has(t)) textToId.set(t, r.item_id);
    }
  }
  // Languages with no CSV column (e.g. nl) are aligned from the Crowdin approved
  // export prebuilt in main(); merge it in (CSV wins when both exist).
  const align = CROWDIN_ALIGN[language];
  if (align) {
    for (const [t, id] of align) if (!textToId.has(t)) textToId.set(t, id);
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
  // diag: item_uid -> {p_correct, point_biserial, flag_pb}
  const diag = readCsv(DIAG_CSV);
  const uidToHuman = new Map();
  for (const r of diag) {
    if (r.task !== TASK.diagTask || r.subset !== lang.diag) continue;
    const uid = String(r.item).replace(/-\d+$/, '');
    if (!uidToHuman.has(uid)) {
      uidToHuman.set(uid, {
        p_correct: numOrNull(r.p_correct),
        point_biserial: numOrNull(r.point_biserial),
        flag_pb: r.flag_pb,
      });
    }
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

  // screen flags (panel-relative cutoffs; BROKEN uses each item's own chance)
  const pSorted = [...rows.map((r) => r.p_vlm)].sort((a, b) => a - b);
  const hardCut = quantile(pSorted, 0.15);
  const ceilCut = quantile(pSorted, 0.9);
  for (const r of rows) {
    const c = classify(r.p_vlm, r.chance, hardCut, ceilCut);
    r.flag = c.flag;
    r.reason = c.reason;
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

  // ---- write screen_<lang>.csv (all items) ----
  const scrHeader = ['item_uid', 'flag', 'reason', 'n_resp', 'p_vlm', 'rpb_vlm', 'p_human', 'pb_human', 'transcript'];
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
        `"${String(r.transcript ?? '').replace(/"/g, '""')}"`,
      ].join(','),
    );
  }
  writeFileSync(join(OUT_DIR, `screen${TAG}_${language}.csv`), scr.join('\n') + '\n', 'utf-8');

  // ---- write review_<lang>.csv (only items needing review, prioritized) ----
  const order = { BROKEN: 0, HARD: 1, CEILING: 2 };
  const review = rows
    .filter((r) => r.flag !== 'OK')
    .sort((a, b) => (order[a.flag] - order[b.flag]) || a.p_vlm - b.p_vlm);
  const rv = [['priority', 'item_uid', 'flag', 'p_vlm', 'p_human', 'transcript'].join(',')];
  review.forEach((r, i) =>
    rv.push(
      [
        i + 1,
        r.item_uid ?? '',
        r.flag,
        fmt(r.p_vlm),
        fmt(r.p_human),
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

  const summary = hasHumanJoin
    ? `${language}: resp=${respondents.length} items=${commonKeys.length} flags[B${flagCounts.BROKEN ?? 0}/H${flagCounts.HARD ?? 0}/C${flagCounts.CEILING ?? 0}] rhoDiff=${fmt(rhoDiff, 2)} brokenCatch=${hBrokenCaught}/${hBroken.length}`
    : `${language}: resp=${respondents.length} items=${commonKeys.length} flags[B${flagCounts.BROKEN ?? 0}/H${flagCounts.HARD ?? 0}/C${flagCounts.CEILING ?? 0}]`;
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

  // Prebuild Crowdin alignment for non-CSV languages (e.g. nl) so the otherwise
  // synchronous join/cross-language pipeline can read it without async plumbing.
  if (TASK.humanJoin) {
    for (const lang of langs) {
      if (CSV_LANGS.has(lang)) continue;
      CROWDIN_ALIGN[lang] = await loadCrowdinAlignment(lang, TASK.crowdinFile);
      if (CROWDIN_ALIGN[lang].size === 0) {
        console.error(
          `WARN: no Crowdin alignment for "${lang}" (cache ${existsSync(CROWDIN_CACHE) ? 'present' : 'MISSING'}; ` +
            `task file ${TASK.crowdinFile}.xliff). Per-language screen still works; ${lang}<->en item alignment will be empty.`,
        );
      }
    }
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

  for (const lang of langs) {
    const out = analyzeLanguage(lang);
    if (!out) continue;
    rep.push(out.section);
    console.log(out.summary);
  }

  // cross-language difficulty shift (vs en) -- the translation-breakage signal
  if (langs.includes('en') && langs.length > 1) {
    rep.push(crossLanguageSection(langs));
  }

  writeFileSync(join(OUT_DIR, `report${TAG}.md`), rep.join('\n') + '\n', 'utf-8');
  console.log(`Wrote out/report${TAG}.md, out/screen${TAG}_<lang>.csv, out/review${TAG}_<lang>.csv`);
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

main();
