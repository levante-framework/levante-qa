/**
 * Official vocab CAT hardness from a locale item-bank row.
 *
 * Registered -prod variants use vocab-item-bank-<locale>.csv.
 * CAT reads `d` if present, else `difficulty` (getCorpus.ts).
 * Treat exact ±5 difficulty-only values as placeholders, not measured d.
 */
export const VOCAB_CORPUS_BY_LANG = {
  en: 'vocab-item-bank-en-US.csv',
  'en-us': 'vocab-item-bank-en-US.csv',
  'en-gb': 'vocab-item-bank-en-GB.csv',
  de: 'vocab-item-bank-de-DE.csv',
  'de-de': 'vocab-item-bank-de-DE.csv',
  es: 'vocab-item-bank-es-CO.csv',
  'es-co': 'vocab-item-bank-es-CO.csv',
  'es-ar': 'vocab-item-bank-es-AR.csv',
  nl: 'vocab-item-bank-nl-NL.csv',
  'nl-nl': 'vocab-item-bank-nl-NL.csv',
};

export function vocabCorpusFile(lang = 'en') {
  const key = String(lang || 'en').trim().toLowerCase();
  return VOCAB_CORPUS_BY_LANG[key] || VOCAB_CORPUS_BY_LANG.en;
}

export function isPlaceholderDifficulty(x) {
  return Number.isFinite(x) && Math.abs(x) === 5;
}

function parseNum(raw) {
  const s = String(raw ?? '').trim();
  if (!s || /^(na|nan|none|null)$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** CAT referee: finite `d`, else non-placeholder `difficulty`. */
export function catVocabD(row) {
  const d = parseNum(row?.d);
  if (d != null) return d;
  const difficulty = parseNum(row?.difficulty);
  if (difficulty != null && !isPlaceholderDifficulty(difficulty)) return difficulty;
  return null;
}

/** Kids IRT in the locale bank: non-placeholder `difficulty` only (do not fall back to old CAT `d`). */
export function vocabIrtD(row) {
  const difficulty = parseNum(row?.difficulty);
  if (difficulty != null && !isPlaceholderDifficulty(difficulty)) return difficulty;
  return null;
}
