/**
 * Backfill missing narration transcripts into LEVANTE audio assets.
 *
 * LEVANTE mp3s carry their canonical script in an ID3v2 TXXX frame. A pipeline
 * bug left some assets (those generated from "Existing audio") without those
 * frames. This script finds every item-bank audio file in the assets bucket that
 * is missing a transcript frame, looks up the canonical text from the
 * audio-generation source of truth
 * (levante_translations/translation_text/item_bank_translations.csv, keyed by
 * item_id + locale), writes the TXXX frames, and re-uploads the object.
 *
 * Files that are not in the item bank (sound-effect cues like coin/select) have
 * no source text and are left untouched.
 *
 * Usage:
 *   tsx scripts/backfill_audio_transcripts.ts                 # dry run (default)
 *   tsx scripts/backfill_audio_transcripts.ts --apply         # write + re-upload
 *   tsx scripts/backfill_audio_transcripts.ts --locale=en-US  # one locale
 *   tsx scripts/backfill_audio_transcripts.ts --task=hearts-and-flowers
 *   tsx scripts/backfill_audio_transcripts.ts --limit=5 --apply
 *
 * Requires: gsutil authenticated against a principal with write access to the
 * bucket (downloads use the public https endpoint; uploads use gsutil).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import NodeID3 from 'node-id3';

interface UserDefinedTextFrame {
  description?: string;
  value?: string;
}
interface Tags {
  userDefinedText?: UserDefinedTextFrame[];
}

const BUCKET = process.env.ASSETS_BUCKET ?? 'levante-assets-dev';
const CSV_URL =
  process.env.TRANSLATIONS_CSV_URL ??
  'https://raw.githubusercontent.com/levante-framework/levante_translations/main/translation_text/item_bank_translations.csv';
const RANGE_BYTES = 64 * 1024;
const DETECT_CONCURRENCY = 16;
const INVALID_VALUES = new Set(['', 'NO APPROVED TRANSLATION']);

// TXXX descriptions that count as a transcript (mirrors the id3Reader precedence).
const TRANSCRIPT_KEYS = ['original_translation_text', 'text', 'audio_enhanced_text'];

interface Args {
  apply: boolean;
  locales: string[] | null;
  task: string | null;
  limit: number | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, locales: null, task: null, limit: null };
  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else if (arg.startsWith('--locale=')) args.locales = arg.slice('--locale='.length).split(',');
    else if (arg.startsWith('--task=')) args.task = arg.slice('--task='.length);
    else if (arg.startsWith('--limit=')) args.limit = Number(arg.slice('--limit='.length));
  }
  return args;
}

/** Minimal RFC4180 CSV parser (handles quotes, escaped quotes, newlines in fields). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

type TranslationMap = Map<string, Map<string, string>>;

async function loadTranslations(): Promise<{ byItem: TranslationMap; locales: string[] }> {
  const res = await fetch(CSV_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch translations CSV: HTTP ${res.status}`);
  }
  const rows = parseCsv(await res.text());
  const header = rows[0] ?? [];
  const itemIdx = header.indexOf('item_id');
  const localeCols = header
    .map((name, idx) => ({ name, idx }))
    .filter((c) => /^[a-z]{2}-[A-Z]{2}$/.test(c.name));

  const byItem: TranslationMap = new Map();
  for (const r of rows.slice(1)) {
    const itemId = r[itemIdx]?.trim();
    if (!itemId) continue;
    const perLocale = new Map<string, string>();
    for (const { name, idx } of localeCols) {
      const value = (r[idx] ?? '').trim();
      if (!INVALID_VALUES.has(value)) {
        perLocale.set(name, value);
      }
    }
    byItem.set(itemId, perLocale);
  }
  return { byItem, locales: localeCols.map((c) => c.name) };
}

function gsutilLs(prefix: string): string[] {
  try {
    const out = execFileSync('gsutil', ['ls', `gs://${BUCKET}/audio/${prefix}/**`], {
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.split('\n').filter((l) => l.endsWith('.mp3'));
  } catch {
    return [];
  }
}

/** Locale folders that actually exist under audio/ in the bucket. */
function listBucketLocales(): string[] {
  try {
    const out = execFileSync('gsutil', ['ls', `gs://${BUCKET}/audio/`], { encoding: 'utf-8' });
    return out
      .split('\n')
      .map((l) => l.replace(`gs://${BUCKET}/audio/`, '').replace(/\/$/, ''))
      .filter((name) => /^[a-z]{2}-[A-Z]{2}$/.test(name));
  } catch {
    return [];
  }
}

function httpsUrl(gsUrl: string): string {
  return gsUrl.replace(/^gs:\/\//, 'https://storage.googleapis.com/');
}

function basename(url: string): string {
  return (url.split('/').pop() ?? '').replace(/\.mp3$/i, '');
}

function hasTranscript(tags: Tags): boolean {
  for (const entry of tags.userDefinedText ?? []) {
    if (entry.description && TRANSCRIPT_KEYS.includes(entry.description) && (entry.value ?? '').trim()) {
      return true;
    }
  }
  return false;
}

async function readTagsRange(url: string): Promise<Tags | null> {
  const res = await fetch(url, { headers: { Range: `bytes=0-${RANGE_BYTES - 1}` } });
  if (!res.ok && res.status !== 206) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return NodeID3.read(buf) as unknown as Tags;
}

interface Candidate {
  gsUrl: string;
  httpsUrl: string;
  itemId: string;
  locale: string;
  text: string;
}

async function mapPool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const idx = next;
      next += 1;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

function applyBackfill(candidate: Candidate, tmpDir: string): void {
  const localFile = join(tmpDir, `${candidate.locale}__${candidate.itemId}.mp3`);
  // Download the full object (public read), patch tags, re-upload via gsutil.
  execFileSync('gsutil', ['cp', candidate.gsUrl, localFile], { stdio: 'pipe' });

  const tags = NodeID3.read(localFile) as unknown as Tags;
  const byDesc = new Map<string, string>();
  for (const e of tags.userDefinedText ?? []) {
    if (e.description) byDesc.set(e.description, e.value ?? '');
  }
  byDesc.set('original_translation_text', candidate.text);
  byDesc.set('text', candidate.text);
  if (!byDesc.get('lang_code')) byDesc.set('lang_code', candidate.locale);
  byDesc.set('backfilled_at', new Date().toISOString());
  byDesc.set('backfill_source', 'levante-qa:item_bank_translations.csv');
  const userDefinedText = [...byDesc.entries()].map(([description, value]) => ({ description, value }));

  const result = NodeID3.update({ userDefinedText }, localFile);
  if (result !== true) {
    throw new Error(`NodeID3.update failed for ${candidate.itemId}: ${String(result)}`);
  }
  execFileSync('gsutil', ['-h', 'Content-Type:audio/mpeg', 'cp', localFile, candidate.gsUrl], {
    stdio: 'pipe',
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { byItem, locales: csvLocales } = await loadTranslations();
  const bucketLocales = listBucketLocales();
  const available = csvLocales.filter((l) => bucketLocales.includes(l));
  const locales = (args.locales ?? available).filter((l) => available.includes(l));

  console.log(`Bucket: gs://${BUCKET}/audio  | locales: ${locales.join(', ')}`);
  console.log(`Mode: ${args.apply ? 'APPLY (will re-upload)' : 'DRY RUN'}\n`);

  const allCandidates: Candidate[] = [];
  let scanned = 0;
  let alreadyTagged = 0;

  for (const locale of locales) {
    const gsUrls = gsutilLs(locale);
    // Only files that have canonical source text are backfillable.
    const targets = gsUrls
      .map((gsUrl) => ({ gsUrl, itemId: basename(gsUrl) }))
      .filter(({ itemId }) => {
        if (args.task && !itemIdMatchesTask(itemId, args.task)) return false;
        const text = byItem.get(itemId)?.get(locale);
        return text !== undefined && text.length > 0;
      });

    const checked = await mapPool(targets, DETECT_CONCURRENCY, async ({ gsUrl, itemId }) => {
      scanned += 1;
      const url = httpsUrl(gsUrl);
      const tags = await readTagsRange(url);
      if (tags && hasTranscript(tags)) {
        return null;
      }
      const text = byItem.get(itemId)?.get(locale) ?? '';
      return { gsUrl, httpsUrl: url, itemId, locale, text } as Candidate;
    });

    const candidates = checked.filter((c): c is Candidate => c !== null);
    alreadyTagged += targets.length - candidates.length;
    allCandidates.push(...candidates);
    console.log(`${locale}: ${targets.length} item-bank files, ${candidates.length} missing transcript`);
  }

  const limited = args.limit ? allCandidates.slice(0, args.limit) : allCandidates;

  console.log(
    `\nScanned ${scanned} item-bank files; ${alreadyTagged} already tagged; ` +
      `${allCandidates.length} need backfill${args.limit ? ` (limited to ${limited.length})` : ''}.\n`,
  );

  for (const c of limited) {
    console.log(`  [${c.locale}] ${c.itemId}: "${c.text.slice(0, 80)}${c.text.length > 80 ? '…' : ''}"`);
  }

  if (!args.apply) {
    console.log('\nDry run only. Re-run with --apply to write the tags and re-upload.');
    return;
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'levante-id3-'));
  let written = 0;
  for (const c of limited) {
    try {
      applyBackfill(c, tmpDir);
      written += 1;
      console.log(`  ✓ wrote ${c.locale}/${c.itemId}`);
    } catch (err) {
      console.error(`  ✗ failed ${c.locale}/${c.itemId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`\nDone. Re-uploaded ${written}/${limited.length} files.`);
}

// item_id values are not strictly prefixed by task, but most task audio is, so a
// prefix match is a good-enough filter for the --task convenience flag.
function itemIdMatchesTask(itemId: string, task: string): boolean {
  return itemId.startsWith(task) || itemId.includes(task);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
