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
}

export interface VLMResult {
  action: Action;
  latencyMs: number;
  provider: string;
}

