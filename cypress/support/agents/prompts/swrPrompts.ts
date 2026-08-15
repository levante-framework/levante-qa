/**
 * SWR VLM prompts.
 *
 * v1 — adult lexicality only (LEFT=pseudo, RIGHT=real). Weak vs human `b`.
 * v2 — REAL|PSEUDO + HIGH|MED|LOW child-success (ρ~0.38 live).
 * v3 — REAL|PSEUDO + HARDNESS 1-5 (bake-off winner; held-out ρ~0.52 age-avg).
 *      Optional QA_SWR_CHILD_PLAY=1: LOW / HARDNESS 5 → coin-flip left/right.
 */

export type SwrPromptVersion = 'v1' | 'v2' | 'v2strict' | 'v3';
export type SwrConfidence = 'high' | 'med' | 'low';

/** Soft P(child correct) weights for v2 (same scale as vocab v4). */
export const SWR_CONFIDENCE_WEIGHT: Record<SwrConfidence, number> = {
  high: 1,
  med: 0.5,
  low: 0.25,
};

/** Map HARDNESS 1-5 → easiness (1→1.0 … 5→0.2). */
export function hardnessToPChild(h: number): number | null {
  if (!Number.isFinite(h) || h < 1 || h > 5) return null;
  return (6 - h) / 5;
}

export function resolveSwrPromptVersion(): SwrPromptVersion {
  let raw: unknown;
  try {
    if (typeof Cypress !== 'undefined' && typeof Cypress.expose === 'function') {
      raw = Cypress.expose('QA_SWR_PROMPT');
    }
  } catch {
    /* not in Cypress */
  }
  if (raw == null || raw === '') {
    raw = typeof process !== 'undefined' ? process.env.QA_SWR_PROMPT : undefined;
  }
  const v = String(raw ?? 'v1').trim().toLowerCase();
  if (v === 'v3' || v === 'h15' || v === 'hardness') return 'v3';
  if (v === 'v2strict' || v === 'hml_s' || v === 'v2s') return 'v2strict';
  if (v === 'v2') return 'v2';
  return 'v1';
}

/** Opt-in: LOW / HARDNESS 5 coin-flips left/right. */
export function resolveSwrChildPlay(): boolean {
  let raw: unknown;
  try {
    if (typeof Cypress !== 'undefined' && typeof Cypress.expose === 'function') {
      raw = Cypress.expose('QA_SWR_CHILD_PLAY');
    }
  } catch {
    /* not in Cypress */
  }
  if (raw == null || raw === '') {
    raw = typeof process !== 'undefined' ? process.env.QA_SWR_CHILD_PLAY : undefined;
  }
  const v = String(raw ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export function resolvePersonaAgeYears(): number | null {
  let raw: unknown;
  try {
    if (typeof Cypress !== 'undefined' && typeof Cypress.expose === 'function') {
      raw = Cypress.expose('QA_PERSONA_AGE_YEARS');
    }
  } catch {
    /* not in Cypress */
  }
  if (raw == null || raw === '') {
    raw = typeof process !== 'undefined' ? process.env.QA_PERSONA_AGE_YEARS : undefined;
  }
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

const SYSTEM_V1 = [
  'You are taking SWR (Single Word Recognition).',
  'On each trial you see one letter string and decide if it is a real word.',
  'Choose LEFT for "not a real word" and RIGHT for "real word".',
  '',
  'Respond with ONLY one word: LEFT or RIGHT.',
  'Do not add punctuation or explanation.',
].join('\n');

function ageLine(ageYears: number | null): string {
  if (ageYears == null || !Number.isFinite(ageYears)) {
    return 'Judge how a typical early-elementary child (about age 8) would do.';
  }
  return `Judge how a typical ${Math.round(ageYears)}-year-old child reader would do.`;
}

function buildSystemV2(ageYears: number | null, strict = false): string {
  return [
    'You help estimate difficulty for SWR (Single Word Recognition).',
    'Each trial shows one letter string. Decide two things:',
    '  (1) REAL or PSEUDO — is this an English word? (common misspellings / nonsense = PSEUDO)',
    '  (2) HIGH, MED, or LOW — probability a child at the age below usually gets (1) correct.',
    ...(strict
      ? [
          '        HIGH = nearly certain (>90%): only ultra-common early words (cat, dog, big) or blatant nonsense (xkq).',
          '        MED  = plausible but not automatic — DEFAULT. Most grade-level real words and many pseudos.',
          '        LOW  = often wrong: rare/academic/long words, or pseudos that look like real words.',
          'CRITICAL: Do NOT use HIGH for ordinary school vocabulary. Prefer MED. For age 10, HIGH should be rare (<20%).',
          'If the word is longer than 5 letters or uncommon, do not choose HIGH.',
        ]
      : [
          '        HIGH = trivial for that age (very common short words / obvious nonsense)',
          '        MED  = doable but not automatic for that age (default when unsure)',
          '        LOW  = hard for that age (rare, long, academic, or subtle pseudowords)',
          'Do not default to HIGH. Use the full scale; many school-age items should be MED.',
        ]),
    ageLine(ageYears),
    'Look carefully at every letter. Short common words (cat, open, night) are REAL.',
    'Made-up letter strings (blans, youx, plissars) are PSEUDO.',
    'Reply with exactly two tokens, e.g. "REAL HIGH" or "PSEUDO MED" or "REAL LOW".',
    'No other words or punctuation.',
  ].join('\n');
}

function buildSystemV3(ageYears: number | null): string {
  return [
    'You help estimate difficulty for SWR (Single Word Recognition).',
    'Each trial shows one letter string. Decide two things:',
    '  (1) REAL or PSEUDO — is this an English word? (misspellings / nonsense = PSEUDO)',
    '  (2) HARDNESS 1-5 — how hard would (1) be for a child at the age below?',
    '        1 = trivial (very common short words / obvious nonsense)',
    '        2 = easy',
    '        3 = moderate (default when unsure)',
    '        4 = hard (rare, long, or subtle)',
    '        5 = very hard for that age',
    'Use the full 1-5 scale; do not default to 1 or 3 for everything.',
    ageLine(ageYears),
    'Look carefully at every letter. Short common words (cat, open, night) are REAL.',
    'Made-up letter strings (blans, youx, plissars) are PSEUDO.',
    'Reply with exactly two tokens, e.g. "REAL 2" or "PSEUDO 4" or "REAL 5".',
    'No other words or punctuation.',
  ].join('\n');
}

export function swrSystemPrompt(ageYears: number | null = resolvePersonaAgeYears()): string {
  const v = resolveSwrPromptVersion();
  if (v === 'v3') return buildSystemV3(ageYears);
  if (v === 'v2strict') return buildSystemV2(ageYears, true);
  if (v === 'v2') return buildSystemV2(ageYears, false);
  return SYSTEM_V1;
}

export function resolveSwrAoaInject(): boolean {
  let raw: unknown;
  try {
    if (typeof Cypress !== 'undefined' && typeof Cypress.expose === 'function') {
      raw = Cypress.expose('QA_SWR_AOA');
    }
  } catch {
    /* not in Cypress */
  }
  if (raw == null || raw === '') {
    raw = typeof process !== 'undefined' ? process.env.QA_SWR_AOA : undefined;
  }
  const v = String(raw ?? '0').trim().toLowerCase();
  // Default OFF — offline inject was neutral@6 / harmful@10; prefer post-hoc blend.
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export function swrUserText(
  transcript: string | null = null,
  ageYears: number | null = resolvePersonaAgeYears(),
  aoaYears: number | null = null,
): string {
  const v = resolveSwrPromptVersion();
  if (v === 'v1') return 'Reply with ONLY LEFT or RIGHT.';
  const age =
    ageYears != null && Number.isFinite(ageYears) ? `${Math.round(ageYears)}-year-old` : 'child';
  const base =
    v === 'v3'
      ? `Reply with exactly two tokens: REAL or PSEUDO, then HARDNESS 1-5 (for a typical ${age}). Example: "REAL 2" or "PSEUDO 4".`
      : `Reply with exactly two tokens: REAL or PSEUDO, then HIGH, MED, or LOW (would a typical ${age} correctly judge this string?). Example: "REAL HIGH" or "PSEUDO LOW".`;
  const w = String(transcript ?? '').trim();
  if (!w) return base;
  let msg = `${base} The letter string is: "${w}".`;
  if (
    resolveSwrAoaInject() &&
    aoaYears != null &&
    Number.isFinite(aoaYears) &&
    (v === 'v2' || v === 'v2strict' || v === 'v3')
  ) {
    msg +=
      ` Kuperman age-of-acquisition for this word (if REAL) is about ${aoaYears.toFixed(1)} years` +
      ` — treat later AoA as harder for that child age; ignore AoA if PSEUDO.`;
  }
  return msg;
}

/** Offline / text-only user turn (no screenshot). */
export function swrOfflineUserText(
  word: string,
  ageYears: number | null,
  aoaYears: number | null = null,
): string {
  return swrUserText(word, ageYears, aoaYears);
}

export type SwrReplyParse = {
  /** Mapped game click. */
  lr: 'left' | 'right' | null;
  /** Lexicality token when present. */
  lexical: 'real' | 'pseudo' | null;
  confidence: SwrConfidence | null;
  /** HARDNESS 1-5 when present (v3). */
  hardness: number | null;
  /** Soft P(child correct); null if missing. */
  pChild: number | null;
};

function parseConfidence(text: string): SwrConfidence | null {
  if (/\bHIGH\b/.test(text)) return 'high';
  if (/\bMED\b/.test(text)) return 'med';
  if (/\bLOW\b/.test(text)) return 'low';
  return null;
}

/**
 * Parse v1 LEFT|RIGHT, v2 REAL|PSEUDO HIGH|MED|LOW, or v3 REAL|PSEUDO 1-5.
 */
export function parseSwrReply(raw: string): SwrReplyParse {
  const text = String(raw ?? '').trim().toUpperCase();
  const version = resolveSwrPromptVersion();

  let lexical: 'real' | 'pseudo' | null = null;
  if (/\bREAL\b/.test(text)) lexical = 'real';
  else if (/\bPSEUDO\b/.test(text)) lexical = 'pseudo';
  else if (/\bRIGHT\b/.test(text)) lexical = 'real';
  else if (/\bLEFT\b/.test(text)) lexical = 'pseudo';

  let confidence: SwrConfidence | null = null;
  let hardness: number | null = null;
  let pChild: number | null = null;

  if (version === 'v3') {
    const m = text.match(/\b([1-5])\b/);
    if (m) {
      hardness = Number(m[1]);
      pChild = hardnessToPChild(hardness);
      // Mirror into coarse conf for child-play / logging.
      if (hardness <= 2) confidence = 'high';
      else if (hardness === 3) confidence = 'med';
      else confidence = 'low';
    }
  } else {
    confidence = parseConfidence(text);
    pChild = confidence ? SWR_CONFIDENCE_WEIGHT[confidence] : null;
  }

  const lr = lexical === 'real' ? 'right' : lexical === 'pseudo' ? 'left' : null;
  return { lr, lexical, confidence, hardness, pChild };
}

/**
 * When child-play is on, LOW / HARDNESS 5 → coin-flip left/right.
 */
export function applyChildPlayPolicy(
  parsed: SwrReplyParse,
  rng: () => number = Math.random,
): SwrReplyParse & { randomized: boolean } {
  const hardFail = parsed.hardness === 5 || parsed.confidence === 'low';
  if (!hardFail) {
    return { ...parsed, randomized: false };
  }
  const lr: 'left' | 'right' = rng() < 0.5 ? 'left' : 'right';
  return { ...parsed, lr, randomized: true };
}
