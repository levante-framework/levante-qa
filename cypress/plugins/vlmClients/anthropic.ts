import Anthropic from '@anthropic-ai/sdk';
import type { VLMRequest } from '../../support/tasks/types';
import { buildUserText } from './index';

const DEFAULT_MODEL = 'claude-3-5-sonnet-latest';

let client: Anthropic | null = null;

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set.');
  }
  if (!client) {
    client = new Anthropic({ apiKey });
  }
  return client;
}

export async function askAnthropic(req: VLMRequest): Promise<string> {
  const model = process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
  const response = await getClient().messages.create({
    model,
    max_tokens: 16,
    temperature: 0,
    system: req.systemPrompt,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: req.pngBase64 },
          },
          { type: 'text', text: buildUserText(req.transcript, req.userText) },
        ],
      },
    ],
  });

  const block = response.content.find((c) => c.type === 'text');
  return block && block.type === 'text' ? block.text : '';
}
