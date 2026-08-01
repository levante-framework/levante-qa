import { GoogleGenAI } from '@google/genai';
import type { VLMRequest } from '../../support/tasks/types';
import { buildUserText } from './index';

// Current vision-capable default (the legacy gemini-1.5 family is deprecated).
// Override per run with GEMINI_MODEL, e.g. gemini-2.5-pro or gemini-3-flash-preview.
const DEFAULT_MODEL = 'gemini-2.5-flash';

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
    /UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|overloaded|deadline|INTERNAL|ETIMEDOUT|ECONNRESET/i.test(m)
  );
}

const MAX_ATTEMPTS = Math.max(1, Number(process.env.VLM_MAX_RETRIES ?? 8));

async function generateWithRetry(
  params: GenerateParams,
): Promise<Awaited<ReturnType<GoogleGenAI['models']['generateContent']>>> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      return await getClient().models.generateContent(params);
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === MAX_ATTEMPTS - 1) throw err;
      // Exponential backoff with jitter, capped at 30s.
      const backoffMs = Math.min(30000, 750 * 2 ** attempt) + Math.floor(Math.random() * 500);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  throw lastErr;
}

export async function askGemini(req: VLMRequest): Promise<string> {
  const model = process.env.GEMINI_MODEL ?? DEFAULT_MODEL;
  const contents = [
    { text: buildUserText(req.transcript, req.userText) },
    { inlineData: { mimeType: 'image/png', data: req.pngBase64 } },
  ];
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
    return response.text ?? '';
  } catch (err) {
    const message = String(err);
    const requiresThinkingMode =
      message.includes('Budget 0 is invalid') || message.includes('only works in thinking mode');
    if (!requiresThinkingMode) throw err;

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
    return retry.text ?? '';
  }
}
