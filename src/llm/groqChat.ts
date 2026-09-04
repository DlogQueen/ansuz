const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';

import type { ChatMessage } from './openrouter.js';

/**
 * Groq chat completions, OpenAI-compatible.
 *
 * Here so the crew can run on Groq's free tier -- OpenRouter is the better
 * model selection, but it's pay-as-you-go, and an unfunded key stops every
 * agent dead. Groq's free tier has rate limits but no balance to run out of.
 *
 * Groq offers no embeddings endpoint (its model list is chat + Whisper + TTS
 * only), so running the crew here means long-term memory falls back to
 * recency/importance instead of semantic similarity -- see
 * src/memory/longTermMemory.ts and docs/bmdc.md.
 */
export async function groqChatCompletion(messages: ChatMessage[]): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error('GROQ_API_KEY must be set to use the Groq chat provider.');
  }
  const model = process.env.GROQ_MODEL;
  if (!model) {
    throw new Error('GROQ_MODEL must be set (e.g. openai/gpt-oss-120b) -- see .env.example.');
  }

  const response = await fetch(GROQ_CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages }),
  });

  if (!response.ok) {
    const detail = await response.text();
    // 429 is the free tier's rate limit, not a broken key -- worth naming,
    // since the fix (wait, or slow the cycle down) is different from the fix
    // for an auth failure.
    if (response.status === 429) {
      throw new Error(`Groq rate limit hit (free tier). Retry shortly or slow the cycle cadence. ${detail}`);
    }
    throw new Error(`Groq request failed (${response.status}): ${detail}`);
  }

  const data = (await response.json()) as { choices: Array<{ message: { content: string } }> };
  return data.choices[0].message.content;
}
