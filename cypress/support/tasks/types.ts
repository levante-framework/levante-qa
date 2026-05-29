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
}

export interface VLMResult {
  action: Action;
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

