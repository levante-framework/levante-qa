import { z } from 'zod';

/**
 * Shared types for LEVANTE task QA. All trial records are validated through the
 * zod schemas defined here before being written to disk or scored.
 */

export const ShapeSchema = z.enum(['heart', 'flower']).nullable();
export type Shape = z.infer<typeof ShapeSchema>;

export const SideSchema = z.enum(['left', 'right']).nullable();
export type Side = z.infer<typeof SideSchema>;

export const BlockTypeSchema = z.enum(['hearts', 'flowers', 'mixed', 'instructions']);
export type BlockType = z.infer<typeof BlockTypeSchema>;

export const ActionSchema = z.enum(['LEFT', 'RIGHT', 'CONTINUE']);
export type Action = z.infer<typeof ActionSchema>;

export const ResponseActionSchema = z.enum(['LEFT', 'RIGHT']);
export type ResponseAction = z.infer<typeof ResponseActionSchema>;

export const CongruencySchema = z.enum(['congruent', 'incongruent']);
export type Congruency = z.infer<typeof CongruencySchema>;

/**
 * Where a trial's audio transcript came from. LEVANTE narration mp3s carry the
 * canonical script in an ID3v2 TXXX (user-defined text) frame, NOT in USLT/TIT2
 * (TIT2 is just the asset id and COMM is voice metadata — verified against the
 * live dev bucket on 2026-05-29). Precedence, highest first:
 *   1. TXXX:original_translation_text — the clean source script (no TTS markup).
 *   2. TXXX:text                      — the text actually fed to the TTS engine
 *                                       (may contain emotion cues like "[happy]").
 *   3. TXXX:audio_enhanced_text       — last-resort enhanced variant.
 * 'missing' means the mp3 had none of those frames; 'error' means the fetch or
 * parse failed.
 */
export const AudioSourceSchema = z.enum([
  'id3:original_translation_text',
  'id3:text',
  'id3:audio_enhanced_text',
  'missing',
  'error',
]);
export type AudioSource = z.infer<typeof AudioSourceSchema>;

/**
 * A single trial as observed and acted upon by an agent. The same schema is
 * used for both the deterministic oracle and the VLM agent; fields specific to
 * the VLM path (latencyMs, modelAction, oracleAction, timedOut) are optional.
 */
export const TrialRecordSchema = z.object({
  timestamp: z.string(),
  task: z.string(),
  step: z.number().int().nonnegative(),
  block: BlockTypeSchema,
  shape: ShapeSchema,
  side: SideSchema,
  congruency: CongruencySchema.nullable().default(null),
  action: ActionSchema,
  correct: z.boolean().nullable().default(null),
  rtMs: z.number().nonnegative().nullable().default(null),
  oracle: z.boolean(),
  // Audio channel: the canonical narration script that played on this screen,
  // read from the mp3's ID3 tags. Null when no new narration started on the
  // screen (e.g. a silent response trial) or capture is unavailable.
  audioTranscript: z.string().nullable().default(null),
  audioSource: AudioSourceSchema.nullable().default(null),
  // VLM-only fields.
  provider: z.string().nullable().default(null),
  modelAction: ActionSchema.nullable().default(null),
  oracleAction: ActionSchema.nullable().default(null),
  latencyMs: z.number().nonnegative().nullable().default(null),
  timedOut: z.boolean().nullable().default(null),
});
export type TrialRecord = z.infer<typeof TrialRecordSchema>;

// --- EGMA math -------------------------------------------------------------

/**
 * EGMA item families exercised by the hosted demo. The question is delivered by
 * narration (there is no on-screen prompt text), which is why audio support is a
 * prerequisite for this task:
 *   - number-identification: "Choose the N" — the target N is ONLY in the audio.
 *   - number-comparison:     "Which is larger/smaller?" — direction is in the
 *                            audio; the operands are the two on-screen choices.
 * 'instructions' covers section/intro/feedback screens; 'unknown' is a guard for
 * any item type the demo timeline adds later.
 */
export const EgmaItemTypeSchema = z.enum([
  'number-identification',
  'number-comparison',
  'missing-number',
  'arithmetic',
  'fraction',
  'number-line',
  'instructions',
  'unknown',
]);
export type EgmaItemType = z.infer<typeof EgmaItemTypeSchema>;

/**
 * A single EGMA trial. The answer is expressed as the chosen option's VALUE
 * (the number on the button) plus its index, so oracle and VLM records are
 * directly comparable regardless of choice ordering.
 */
export const EgmaTrialRecordSchema = z.object({
  timestamp: z.string(),
  task: z.string(),
  step: z.number().int().nonnegative(),
  itemType: EgmaItemTypeSchema,
  // The narration that defined the item (the only place the question exists).
  promptText: z.string().nullable().default(null),
  choices: z.array(z.string()).default([]),
  chosenIndex: z.number().int().nullable().default(null),
  chosenValue: z.string().nullable().default(null),
  // The value the deterministic solver considers correct (null on instructions).
  correctValue: z.string().nullable().default(null),
  correct: z.boolean().nullable().default(null),
  // The task's OWN answer key for this item: the index/value of the choice the
  // app marks correct (.correct / aria-label="correct", emitted only under
  // Cypress — see core-tasks afcStimulus.ts). Null when no marker is present
  // (instructions, number-line, untagged types). This is ground truth, used to
  // cross-check the oracle's solver and to score the VLM against the app rather
  // than against our own solver.
  keyedIndex: z.number().int().nullable().default(null),
  keyedValue: z.string().nullable().default(null),
  // Number-line only: fractional placement error |placed - target| / range, in
  // [0, 1]. Null for non-slider items.
  numberLineError: z.number().nullable().default(null),
  rtMs: z.number().nonnegative().nullable().default(null),
  oracle: z.boolean(),
  audioTranscript: z.string().nullable().default(null),
  audioSource: AudioSourceSchema.nullable().default(null),
  // VLM-only fields.
  provider: z.string().nullable().default(null),
  modelRaw: z.string().nullable().default(null),
  latencyMs: z.number().nonnegative().nullable().default(null),
  timedOut: z.boolean().nullable().default(null),
});
export type EgmaTrialRecord = z.infer<typeof EgmaTrialRecordSchema>;

export function parseEgmaTrialRecord(input: unknown): EgmaTrialRecord {
  return EgmaTrialRecordSchema.parse(input);
}

export const EgmaSummaryStatsSchema = z.object({
  nTrials: z.number().int().nonnegative(),
  // Exact accuracy over the multiple-choice item types (number-line excluded;
  // it is proximity-scored, see accNumberLineProximity).
  accChoice: z.number().nullable(),
  accByType: z.record(z.string(), z.number().nullable()),
  // Mean fractional error of number-line placements (0 = perfect). Null when no
  // number-line items were seen.
  numberLineMeanError: z.number().nullable(),
  rtMean: z.number().nullable(),
  timeoutRate: z.number(),
  itemTypesObserved: z.array(EgmaItemTypeSchema),
});
export type EgmaSummaryStats = z.infer<typeof EgmaSummaryStatsSchema>;

// --- Vocab -----------------------------------------------------------------

/**
 * A single Vocab trial. Vocab is a 4-AFC picture task whose target word is
 * delivered only by narration; the answer is the chosen image's concept word
 * (its `alt`) plus its index, so oracle and VLM records are directly
 * comparable.
 */
export const VocabTrialRecordSchema = z.object({
  timestamp: z.string(),
  task: z.string(),
  step: z.number().int().nonnegative(),
  // 'word' is a response item; 'instructions' covers intro/section screens.
  itemType: z.enum(['word', 'instructions']),
  // The narration that named the target word (the only place the prompt exists).
  promptText: z.string().nullable().default(null),
  // The target concept word parsed from the narration (article stripped).
  targetWord: z.string().nullable().default(null),
  // The image choices' concept words (their `alt`), in DOM order.
  choices: z.array(z.string()).default([]),
  chosenIndex: z.number().int().nullable().default(null),
  chosenValue: z.string().nullable().default(null),
  correct: z.boolean().nullable().default(null),
  // The task's OWN answer key for this item: index/value of the choice the app
  // marks correct (.correct on the <img>, emitted only under Cypress). Null when
  // no marker is present. Ground truth for the cross-check / VLM scoring.
  keyedIndex: z.number().int().nullable().default(null),
  keyedValue: z.string().nullable().default(null),
  rtMs: z.number().nonnegative().nullable().default(null),
  oracle: z.boolean(),
  audioTranscript: z.string().nullable().default(null),
  audioSource: AudioSourceSchema.nullable().default(null),
  // VLM-only fields.
  provider: z.string().nullable().default(null),
  modelRaw: z.string().nullable().default(null),
  latencyMs: z.number().nonnegative().nullable().default(null),
  timedOut: z.boolean().nullable().default(null),
});
export type VocabTrialRecord = z.infer<typeof VocabTrialRecordSchema>;

export function parseVocabTrialRecord(input: unknown): VocabTrialRecord {
  return VocabTrialRecordSchema.parse(input);
}

export const VocabSummaryStatsSchema = z.object({
  nTrials: z.number().int().nonnegative(),
  // Exact accuracy over scored word items (instruction rows excluded).
  accuracy: z.number().nullable(),
  rtMean: z.number().nullable(),
  timeoutRate: z.number(),
  nWithAudio: z.number().int().nonnegative(),
});
export type VocabSummaryStats = z.infer<typeof VocabSummaryStatsSchema>;

// --- Stories (Theory of Mind) ----------------------------------------------

/**
 * A single Stories (theory-of-mind) trial. Story beats are 'instructions'
 * screens (narrated scene setup); 'question' rows are the scored 2–4-choice
 * image comprehension/inference items. The answer requires story context, so
 * the only ground truth is the app's `.correct` key — recorded as
 * keyedIndex/keyedValue and used to score both agents.
 */
export const StoriesTrialRecordSchema = z.object({
  timestamp: z.string(),
  task: z.string(),
  step: z.number().int().nonnegative(),
  itemType: z.enum(['instructions', 'question']),
  // The on-screen narration / question text for this screen.
  promptText: z.string().nullable().default(null),
  // The accumulated story narration the VLM was given as context (question rows).
  storyContext: z.string().nullable().default(null),
  // The image choices' concept words (their `alt`), in DOM order.
  choices: z.array(z.string()).default([]),
  chosenIndex: z.number().int().nullable().default(null),
  chosenValue: z.string().nullable().default(null),
  correct: z.boolean().nullable().default(null),
  // The task's OWN answer key: index/value of the choice marked `.correct`.
  keyedIndex: z.number().int().nullable().default(null),
  keyedValue: z.string().nullable().default(null),
  rtMs: z.number().nonnegative().nullable().default(null),
  oracle: z.boolean(),
  audioTranscript: z.string().nullable().default(null),
  audioSource: AudioSourceSchema.nullable().default(null),
  // VLM-only fields.
  provider: z.string().nullable().default(null),
  modelRaw: z.string().nullable().default(null),
  latencyMs: z.number().nonnegative().nullable().default(null),
  timedOut: z.boolean().nullable().default(null),
});
export type StoriesTrialRecord = z.infer<typeof StoriesTrialRecordSchema>;

export function parseStoriesTrialRecord(input: unknown): StoriesTrialRecord {
  return StoriesTrialRecordSchema.parse(input);
}

export const StoriesSummaryStatsSchema = z.object({
  nQuestions: z.number().int().nonnegative(),
  accuracy: z.number().nullable(),
  rtMean: z.number().nullable(),
  timeoutRate: z.number(),
  nWithAudio: z.number().int().nonnegative(),
});
export type StoriesSummaryStats = z.infer<typeof StoriesSummaryStatsSchema>;

// --- Same-Different Selection ----------------------------------------------

/**
 * A single SDS trial. Two scored kinds plus instructions:
 *   - 'single': one card is correct; scored against the app's `.correct` key.
 *   - 'match':  pick two cards sharing a dimension; NO answer key exists, so
 *     these carry the selected pair but `correct` stays null (completion is the
 *     regression signal). Card values are the dimension-encoded `alt` strings.
 */
export const SdsTrialRecordSchema = z.object({
  timestamp: z.string(),
  task: z.string(),
  step: z.number().int().nonnegative(),
  itemType: z.enum(['instructions', 'single', 'match']),
  promptText: z.string().nullable().default(null),
  // All cards shown, in DOM order (their dimension-encoded `alt`).
  choices: z.array(z.string()).default([]),
  // Single-select choice.
  chosenIndex: z.number().int().nullable().default(null),
  chosenValue: z.string().nullable().default(null),
  // Multi-select (match) pair.
  selectedIndices: z.array(z.number().int()).default([]),
  selectedValues: z.array(z.string()).default([]),
  matchedDimension: z.string().nullable().default(null),
  correct: z.boolean().nullable().default(null),
  // The app's answer key (single-select only).
  keyedIndex: z.number().int().nullable().default(null),
  keyedValue: z.string().nullable().default(null),
  rtMs: z.number().nonnegative().nullable().default(null),
  oracle: z.boolean(),
  audioTranscript: z.string().nullable().default(null),
  audioSource: AudioSourceSchema.nullable().default(null),
  // VLM-only fields.
  provider: z.string().nullable().default(null),
  modelRaw: z.string().nullable().default(null),
  latencyMs: z.number().nonnegative().nullable().default(null),
  timedOut: z.boolean().nullable().default(null),
});
export type SdsTrialRecord = z.infer<typeof SdsTrialRecordSchema>;

export function parseSdsTrialRecord(input: unknown): SdsTrialRecord {
  return SdsTrialRecordSchema.parse(input);
}

export const SdsSummaryStatsSchema = z.object({
  nSingle: z.number().int().nonnegative(),
  nMatch: z.number().int().nonnegative(),
  // Accuracy over single-select items (the only ones with an answer key).
  accuracySingle: z.number().nullable(),
  rtMean: z.number().nullable(),
  timeoutRate: z.number(),
  nWithAudio: z.number().int().nonnegative(),
});
export type SdsSummaryStats = z.infer<typeof SdsSummaryStatsSchema>;

/**
 * Aggregate statistics produced by scoreTrials for one run.
 */
export const SummaryStatsSchema = z.object({
  nTrials: z.number().int().nonnegative(),
  accHearts: z.number().nullable(),
  accFlowers: z.number().nullable(),
  accMixed: z.number().nullable(),
  accCongruent: z.number().nullable(),
  accIncongruent: z.number().nullable(),
  rtMeanMixed: z.number().nullable(),
  timeoutRate: z.number(),
  blocksObserved: z.array(BlockTypeSchema),
  efComposite: z.number().nullable(),
});
export type SummaryStats = z.infer<typeof SummaryStatsSchema>;

/**
 * Validate and coerce an unknown object into a TrialRecord, throwing on failure.
 */
export function parseTrialRecord(input: unknown): TrialRecord {
  return TrialRecordSchema.parse(input);
}

/**
 * Request/response contract for the askVLM cypress task. Kept here so both the
 * node-side plugin and the browser-side agent can share it without the browser
 * bundle importing any node-only provider code.
 */
export interface VLMRequest {
  pngBase64: string;
  systemPrompt: string;
  // The narration transcript that played on the current screen, if any. Given
  // to the model as a text "audio channel" alongside the screenshot.
  transcript?: string | null;
  // Overrides the default user-turn instruction. Tasks whose answer is not a
  // LEFT/RIGHT/CONTINUE action (e.g. EGMA, where the model replies with a number)
  // pass their own instruction here.
  userText?: string | null;
}

export interface VLMResult {
  // Normalized Hearts & Flowers action (LEFT/RIGHT/CONTINUE). Always present for
  // back-compat; tasks with non-action answers should read `raw` instead.
  action: Action;
  // The raw model text, so non-action tasks (EGMA) can parse their own answer.
  raw: string;
  latencyMs: number;
  provider: string;
}

/**
 * Result of reading an mp3's ID3 tags, returned by the readMp3Tags cypress task.
 * Shared between the node-side reader and the browser-side audio helpers so the
 * browser bundle never imports node-only code.
 */
export interface Mp3Tags {
  url: string;
  transcript: string | null;
  source: AudioSource;
  /** ID3 TIT2 — the asset id (e.g. "heart-instruct1"), not the spoken text. */
  title: string | null;
  /** ID3 TXXX:lang_code (e.g. "en-US"), when present. */
  language: string | null;
  /** Populated only when source === 'error'. */
  error?: string;
}

