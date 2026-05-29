import { GoogleGenerativeAI } from '@google/generative-ai';
import type { Action, VLMRequest } from '../../support/tasks/types';
import { parseAction } from './index';

const DEFAULT_MODEL = 'gemini-1.5-pro';

let client: GoogleGenerativeAI | null = null;

function getClient(): GoogleGenerativeAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set.');
  }
  if (!client) {
    client = new GoogleGenerativeAI(apiKey);
  }
  return client;
}

export async function askGemini(req: VLMRequest): Promise<Action> {
  const modelName = process.env.GEMINI_MODEL ?? DEFAULT_MODEL;
  const model = getClient().getGenerativeModel({
    model: modelName,
    generationConfig: { temperature: 0, maxOutputTokens: 8 },
  });

  // The pinned SDK version exposes no systemInstruction field, so the shared
  // system prompt is prepended to the user content instead.
  const result = await model.generateContent([
    { text: `${req.systemPrompt}\n\nWhich action? Reply with one word.` },
    { inlineData: { mimeType: 'image/png', data: req.pngBase64 } },
  ]);

  const raw = result.response.text();
  return parseAction(raw);
}
