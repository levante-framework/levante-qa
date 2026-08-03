import OpenAI from 'openai';
import type { VLMRequest, VLMUsage } from '../../support/tasks/types';
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

export type OpenAIReply = { text: string; usage: VLMUsage | null };

export async function askOpenAI(req: VLMRequest): Promise<OpenAIReply> {
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
  const text = typeof raw === 'string' ? raw : '';
  const u = response.usage;
  const usage: VLMUsage | null = u
    ? {
        promptTokenCount: u.prompt_tokens,
        candidatesTokenCount: u.completion_tokens,
        totalTokenCount: u.total_tokens,
      }
    : null;
  return { text, usage };
}
