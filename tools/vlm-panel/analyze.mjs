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

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const RUNS_DIR = join(REPO, 'cypress', 'logs', 'runs');
const OUT_DIR = join(HERE, 'out');
const ITEM_BANK = join(
  REPO,
  '..',
  'crowdin-projects',
  'corpora',
  'trog',
  'shared',
  'corpora',
  'trog-item-bank.csv',
);
// Canonical map of approved en-US sentence text -> item_id, the bridge from the
// VLM's audio transcript to the item bank (whose `prompt` is a generic template).
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

const LOW_DISCRIM = 0.1; // point-biserial below this = "low/anti-discriminating"

// ---------- small helpers ----------
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (const c of line) {
    if (c === '"') q = !q;
    else if (c === ',' && !q) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function readCsv(path) {
  const lines = readFileSync(path, 'utf-8').split(/\r?\n/).filter((l) => l.length > 0);
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map((l) => {
    const cells = parseCsvLine(l);
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

// ---------- 1+2: load panel into respondent x item matrix (one language) ----------
function loadPanel(language) {
  if (!existsSync(RUNS_DIR)) return { respondents: [], items: new Map() };
  const langMap = runLanguageMap();
  const runDirs = readdirSync(RUNS_DIR)
    .filter((d) => d.startsWith('panel_'))
    .filter((d) => langFromRunId(d, langMap) === language);
  const respondents = [];
  // item key -> { transcript, byResp: Map(runId -> 0/1) }
  const items = new Map();

  for (const runId of runDirs) {
    const dir = join(RUNS_DIR, runId);
    const files = readdirSync(dir).filter((f) => /^vlm_.*\.jsonl?$/.test(f));
    if (files.length === 0) continue;
    // Prefer the finalized full-records file (largest) over the live append log.
    const file = files
      .map((f) => ({ f, size: readFileSync(join(dir, f), 'utf-8').length }))
      .sort((a, b) => b.size - a.size)[0].f;

    const seen = new Map(); // item key -> 0/1 (first scored attempt only)
    for (const line of readFileSync(join(dir, file), 'utf-8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.itemType !== 'item' || typeof rec.correct !== 'boolean') continue;
      const key = normText(rec.audioTranscript);
      if (!key) continue;
      if (!seen.has(key)) seen.set(key, rec.correct ? 1 : 0);
      if (!items.has(key)) items.set(key, { transcript: rec.audioTranscript, byResp: new Map() });
    }
    if (seen.size === 0) continue;
    respondents.push({ runId, answers: seen });
    for (const [key, val] of seen) items.get(key).byResp.set(runId, val);
  }
  return { respondents, items };
}

// ---------- 4: per-item p and corrected point-biserial ----------
function itemStats(respondents, items) {
  // common item set: answered by a strong majority of respondents
  const nResp = respondents.length;
  const minCoverage = Math.max(3, Math.ceil(nResp * 0.6));
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
};

// ---------- 5: human join ----------
// Chain: normalized transcript (in the run language) -> item_id (translations)
// -> item_uid (item bank) -> human stats (diag, trog/<lang>).
function buildHumanJoin(language) {
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
  // item bank: item_id / audio_file -> item_uid
  const bank = readCsv(ITEM_BANK);
  const idToUid = new Map();
  for (const r of bank) {
    const id = r.audio_file || r.item_id;
    if (id && r.item_uid) idToUid.set(id, r.item_uid);
  }
  // diag: item_uid -> {p_correct, point_biserial, flag_pb}
  const diag = readCsv(DIAG_CSV);
  const uidToHuman = new Map();
  for (const r of diag) {
    if (r.task !== 'trog' || r.subset !== lang.diag) continue;
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
  for (const [t, id] of textToId) {
    const uid = idToUid.get(id);
    if (uid) transcriptToUid.set(t, uid);
  }
  return { transcriptToUid, uidToHuman };
}

const CHANCE = 0.25; // TROG = 4-alternative forced choice
const CEILING_HUMAN = 0.95; // human pass-rate above which an item is uninformative

function quantile(sorted, q) {
  if (sorted.length === 0) return NaN;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** Languages that have at least one panel run on disk. */
function discoverLanguages() {
  if (!existsSync(RUNS_DIR)) return [];
  const langMap = runLanguageMap();
  const set = new Set();
  for (const d of readdirSync(RUNS_DIR)) {
    if (d.startsWith('panel_')) set.add(langFromRunId(d, langMap));
  }
  return [...set].sort();
}

/**
 * Classify an item into a screen flag from its panel pass-rate. Below chance
 * across a wide-ability panel is the strong "broken / mis-keyed / mistranslated"
 * signal; the rest is panel-relative (p_vlm is compressed, so absolute cutoffs
 * other than chance are unreliable).
 */
function classify(p_vlm, hardCut, ceilCut) {
  if (p_vlm < CHANCE) return { flag: 'BROKEN', reason: `p_vlm ${fmt(p_vlm, 2)} < chance ${CHANCE}` };
  if (p_vlm <= hardCut) return { flag: 'HARD', reason: `bottom of panel (p_vlm ${fmt(p_vlm, 2)})` };
  if (p_vlm >= ceilCut) return { flag: 'CEILING', reason: `top of panel (p_vlm ${fmt(p_vlm, 2)})` };
  return { flag: 'OK', reason: '' };
}

/** Run the whole pipeline + screen for one language; returns a report section. */
function analyzeLanguage(language) {
  const { respondents, items } = loadPanel(language);
  if (respondents.length === 0) return null;

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
  const { transcriptToUid, uidToHuman } = buildHumanJoin(language);
  const rows = [];
  let matched = 0;
  for (const s of stats) {
    const uid = transcriptToUid.get(s.key) ?? null;
    const human = uid ? uidToHuman.get(uid) : null;
    if (human) matched++;
    rows.push({
      ...s,
      item_uid: uid,
      p_human: human?.p_correct ?? null,
      pb_human: human?.point_biserial ?? null,
    });
  }

  // screen flags (panel-relative cutoffs)
  const pSorted = [...rows.map((r) => r.p_vlm)].sort((a, b) => a - b);
  const hardCut = quantile(pSorted, 0.15);
  const ceilCut = quantile(pSorted, 0.9);
  for (const r of rows) {
    const c = classify(r.p_vlm, hardCut, ceilCut);
    r.flag = c.flag;
    r.reason = c.reason;
  }
  const flagCounts = rows.reduce((a, r) => ((a[r.flag] = (a[r.flag] ?? 0) + 1), a), {});

  // correlations
  const m = rows.filter((r) => r.p_human != null);
  const rhoDiff = spearman(m.map((r) => r.p_vlm), m.map((r) => r.p_human));
  const md = rows.filter((r) => r.pb_human != null && r.rpb_vlm != null);
  const rhoDisc = spearman(md.map((r) => r.rpb_vlm), md.map((r) => r.pb_human));

  // threshold validation against human labels (matched items only)
  const hBroken = m.filter((r) => r.p_human < CHANCE);
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
  writeFileSync(join(OUT_DIR, `screen_${language}.csv`), scr.join('\n') + '\n', 'utf-8');

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
  writeFileSync(join(OUT_DIR, `review_${language}.csv`), rv.join('\n') + '\n', 'utf-8');

  // ---- report section ----
  const s = [];
  s.push(`## ${language.toUpperCase()}`);
  s.push(`- Respondents: **${respondents.length}** | common items (coverage >= ${minCoverage}): **${commonKeys.length}** | matched to human: **${matched}**`);
  s.push(`- Spread: min ${fmt(totalP[0], 2)}, median ${fmt(totalP[Math.floor(totalP.length / 2)], 2)}, max ${fmt(totalP[totalP.length - 1], 2)}, SD ${fmt(sdSpread, 2)} -> ${spreadOk ? 'OK' : 'INADEQUATE'}`);
  s.push('');
  s.push('### Screen flags');
  s.push(`- BROKEN (below chance): **${flagCounts.BROKEN ?? 0}** | HARD: **${flagCounts.HARD ?? 0}** | CEILING: **${flagCounts.CEILING ?? 0}** | OK: ${flagCounts.OK ?? 0}`);
  s.push(`- Review list: \`out/review_${language}.csv\` | full screen: \`out/screen_${language}.csv\``);
  s.push('');
  s.push('### Validation vs human labels (matched items)');
  s.push(`- Spearman rho difficulty (p_vlm vs human p_correct), n=${m.length}: **${fmt(rhoDiff)}**`);
  s.push(`- Spearman rho discrimination (rpb_vlm vs human point_biserial), n=${md.length}: **${fmt(rhoDisc)}**`);
  s.push(`- BROKEN catch: of ${hBroken.length} human below-chance item(s), VLM flagged **${hBrokenCaught}** as BROKEN/HARD`);
  s.push(`- BROKEN/HARD precision: of ${vConcern.length} VLM-flagged item(s), **${vConcernHumanHard}** are human-hard (p_correct < 0.5)`);
  s.push(`- CEILING catch: of ${hCeil.length} human-ceiling item(s) (p>${CEILING_HUMAN}), VLM flagged **${hCeilCaught}**`);
  s.push('');

  const summary = `${language}: resp=${respondents.length} items=${commonKeys.length} flags[B${flagCounts.BROKEN ?? 0}/H${flagCounts.HARD ?? 0}/C${flagCounts.CEILING ?? 0}] rhoDiff=${fmt(rhoDiff, 2)} brokenCatch=${hBrokenCaught}/${hBroken.length}`;
  return { section: s.join('\n'), summary };
}

// ---------- main ----------
function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const langs = discoverLanguages();
  if (langs.length === 0) {
    console.error(`No panel runs found under ${RUNS_DIR}. Run tools/vlm-panel/run_panel.mjs first.`);
    process.exit(1);
  }

  const rep = ['# TROG VLM difficulty screen', '', `Generated: ${new Date().toISOString()}`, ''];
  rep.push(
    'A pre-launch screen: a panel of VLM "children" of varying ability answers each item; ' +
      'items the panel passes **below chance** are flagged BROKEN (candidate mis-key/mistranslation), ' +
      'the panel-hardest items HARD, and panel-easiest CEILING (uninformative). Flags are validated ' +
      'against human pass-rates where those exist.',
  );
  rep.push('');

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

  writeFileSync(join(OUT_DIR, 'report.md'), rep.join('\n') + '\n', 'utf-8');
  console.log('Wrote out/report.md, out/screen_<lang>.csv, out/review_<lang>.csv');
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
    const { transcriptToUid } = buildHumanJoin(lang);
    const m = new Map();
    for (const s of stats) {
      const uid = transcriptToUid.get(s.key);
      if (uid) m.set(uid, s.p_vlm);
    }
    byLang[lang] = m;
  }
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
    s.push('| item_uid | p_en | p_' + lang + ' | delta |');
    s.push('|---|---|---|---|');
    for (const d of deltas.slice(0, 10)) {
      s.push(`| ${d.uid} | ${fmt(d.pEn, 2)} | ${fmt(d.pT, 2)} | ${fmt(d.delta, 2)} |`);
    }
  }
  s.push('');
  return s.join('\n');
}

main();
