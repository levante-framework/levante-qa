/** Infer agent label from archive filename or trial records. */
export function agentFromRunId(runId: string, records: { oracle?: boolean }[]): string {
  if (/^wrong_/.test(runId)) return 'wrong';
  if (records.some((r) => r.oracle)) return 'oracle';
  return 'vlm';
}
