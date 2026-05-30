import OpenAI from 'openai';
import type { VLMRequest } from '../../support/tasks/types';
import { buildUserText } from './index';

const DEFAULT_MODEL = 'gpt-4o';

let client: OpenAI | null = null;

function getClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set.');
  }
  if (!client) {
    client = new OpenAI({ apiKey });
  }
  return client;
}

export async function askOpenAI(req: VLMRequest): Promise<string> {
  const model = process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
  const response = await getClient().chat.completions.create({
    model,
    max_tokens: 16,
    temperature: 0,
    messages: [
      { role: 'system', content: req.systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'text', text: buildUserText(req.transcript, req.userText) },
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${req.pngBase64}` },
          },
        ],
      },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? '';
  return typeof raw === 'string' ? raw : '';
}
