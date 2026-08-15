import { GoogleGenAI } from '@google/genai';
import type { VLMRequest, VLMUsage } from '../../support/tasks/types';
import { buildUserText } from './index';

// Default follows Google's replacement for gemini-2.5-flash (EOL ~2026-10-16).
// Override per run with GEMINI_MODEL, e.g. gemini-3.5-flash-lite or a pro id.
const DEFAULT_MODEL = 'gemini-3.6-flash';

/**
 * Sampling temperature. Defaults to 0 (deterministic) so the oracle and normal
 * VLM-agent runs are unchanged. The synthetic-respondent panel sets
 * VLM_TEMPERATURE > 0 so repeated runs of the same (model, persona) cell vary,
 * producing the within-cell response variance that item discrimination needs.
 */
function resolveTemperature(): number {
  const raw = process.env.VLM_TEMPERATURE;
  if (raw === undefined || raw === '') return 0;
  const t = Number(raw);
  return Number.isFinite(t) && t >= 0 ? t : 0;
}

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set.');
  }
  if (!client) {
    client = new GoogleGenAI({ apiKey });
  }
  return client;
}

type GenerateParams = Parameters<GoogleGenAI['models']['generateContent']>[0];

/**
 * Transient Gemini failures — model overload (503 UNAVAILABLE / "high demand"),
 * rate limiting (429 RESOURCE_EXHAUSTED), and the occasional 5xx — are common on
 * the free tier and abort a whole 170-item benchmark mid-run. These are safe to
 * retry; a non-response answer (parsed elsewhere) is the only thing that should
 * count against the model.
 */
function isTransient(err: unknown): boolean {
  const m = String(err);
  return (
    /\b(429|500|502|503|504)\b/.test(m) ||
    /UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|overloaded|deadline|INTERNAL|ETIMEDOUT|ECONNRESET/i.test(
      m,
    )
  );
}

function pickUsage(response: { usageMetadata?: object | null }): VLMUsage | null {
  const u = response?.usageMetadata as Record<string, unknown> | null | undefined;
  if (!u || typeof u !== 'object') return null;
  const out: VLMUsage = {};
  for (const key of [
    'promptTokenCount',
    'candidatesTokenCount',
    'totalTokenCount',
    'thoughtsTokenCount',
  ] as const) {
    const n = Number(u[key]);
    if (Number.isFinite(n)) out[key] = n;
  }
  return Object.keys(out).length ? out : null;
}

async function generateWithRetry(params: GenerateParams) {
  const maxAttempts = Math.max(1, Number(process.env.VLM_MAX_RETRIES) || 5);
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await getClient().models.generateContent(params);
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === maxAttempts - 1) throw err;
      const backoffMs = Math.min(30000, 750 * 2 ** attempt) + Math.floor(Math.random() * 500);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  throw lastErr;
}

export type GeminiReply = { text: string; usage: VLMUsage | null };

export async function askGemini(req: VLMRequest): Promise<GeminiReply> {
  const model = process.env.GEMINI_MODEL ?? DEFAULT_MODEL;
  const contents: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    { text: buildUserText(req.transcript, req.userText) },
  ];
  // Text-only requests (e.g. SWR prompt v2 with DOM letter-string) omit the image.
  if (req.pngBase64) {
    contents.push({ inlineData: { mimeType: 'image/png', data: req.pngBase64 } });
  }
  const baseConfig = {
    systemInstruction: req.systemPrompt,
    temperature: resolveTemperature(),
    maxOutputTokens: 32,
  };

  try {
    const response = await generateWithRetry({
      model,
      contents,
      config: {
        ...baseConfig,
        // Keep fast, short outputs on models that support this.
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    return { text: response.text ?? '', usage: pickUsage(response) };
  } catch (err) {
    const message = String(err);
    const requiresThinkingMode =
      message.includes('Budget 0 is invalid') || message.includes('only works in thinking mode');
    const invalidArg = /INVALID_ARGUMENT|invalid argument/i.test(message);
    // Some models reject thinkingBudget:0 with a clear error; others return a
    // generic INVALID_ARGUMENT — retry without thinkingConfig in both cases.
    if (!requiresThinkingMode && !invalidArg) throw err;

    // Some models (e.g. gemini-2.5-pro) require thinking mode; retry once
    // without forcing a zero thinking budget. Thinking tokens count against
    // maxOutputTokens, so the 32-token cap would be fully consumed by reasoning
    // and leave NOTHING for the visible answer (empty text -> non-response).
    // Raise the cap on this path so the digit survives the thinking budget.
    const retry = await generateWithRetry({
      model,
      contents,
      config: { ...baseConfig, maxOutputTokens: 2048 },
    });
    return { text: retry.text ?? '', usage: pickUsage(retry) };
  }
}
