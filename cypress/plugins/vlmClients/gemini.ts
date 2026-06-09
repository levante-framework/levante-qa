import { GoogleGenAI } from '@google/genai';
import type { VLMRequest } from '../../support/tasks/types';
import { buildUserText } from './index';

// Current vision-capable default (the legacy gemini-1.5 family is deprecated).
// Override per run with GEMINI_MODEL, e.g. gemini-2.5-pro or gemini-3-flash-preview.
const DEFAULT_MODEL = 'gemini-2.5-flash';

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

export async function askGemini(req: VLMRequest): Promise<string> {
  const model = process.env.GEMINI_MODEL ?? DEFAULT_MODEL;
  const contents = [
    { text: buildUserText(req.transcript, req.userText) },
    { inlineData: { mimeType: 'image/png', data: req.pngBase64 } },
  ];
  const baseConfig = {
    systemInstruction: req.systemPrompt,
    temperature: 0,
    maxOutputTokens: 32,
  };

  try {
    const response = await getClient().models.generateContent({
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

    // Gemini 3 Pro variants can require thinking mode; retry once without
    // forcing a zero thinking budget.
    const retry = await getClient().models.generateContent({
      model,
      contents,
      config: baseConfig,
    });
    return retry.text ?? '';
  }
}
