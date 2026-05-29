import OpenAI from 'openai';
import type { Action, VLMRequest } from '../../support/tasks/types';
import { buildUserText, parseAction } from './index';

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

export async function askOpenAI(req: VLMRequest): Promise<Action> {
  const model = process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
  const response = await getClient().chat.completions.create({
    model,
    max_tokens: 8,
    temperature: 0,
    messages: [
      { role: 'system', content: req.systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'text', text: buildUserText(req.transcript) },
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${req.pngBase64}` },
          },
        ],
      },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? '';
  return parseAction(typeof raw === 'string' ? raw : '');
}
