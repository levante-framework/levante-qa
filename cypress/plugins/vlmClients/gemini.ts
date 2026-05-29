import { GoogleGenAI } from '@google/genai';
import type { Action, VLMRequest } from '../../support/tasks/types';
import { buildUserText, parseAction } from './index';

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

export async function askGemini(req: VLMRequest): Promise<Action> {
  const model = process.env.GEMINI_MODEL ?? DEFAULT_MODEL;
  const response = await getClient().models.generateContent({
    model,
    contents: [
      { text: buildUserText(req.transcript) },
      { inlineData: { mimeType: 'image/png', data: req.pngBase64 } },
    ],
    config: {
      systemInstruction: req.systemPrompt,
      temperature: 0,
      maxOutputTokens: 32,
      // Disable "thinking" so the single-word answer isn't starved of tokens
      // and latency stays representative. Supported on 2.5-flash; pro models
      // may ignore it, which is fine — parseAction tolerates longer output.
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  return parseAction(response.text ?? '');
}
