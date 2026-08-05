const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OpenRouterModel {
  id: string;
  name: string;
}

function requireApiKey(): string {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY must be set -- see .env.example.');
  }
  return apiKey;
}

/**
 * OpenRouter rather than a single provider's SDK: the build plan's
 * Experiment Protocol compares persistent-memory behavior across models, so
 * a model must be chosen explicitly per call -- either passed in (e.g. from
 * the web UI's model dropdown) or falling back to OPENROUTER_MODEL, never
 * silently guessed.
 */
export async function chatCompletion(messages: ChatMessage[], model?: string): Promise<string> {
  const apiKey = requireApiKey();
  const resolvedModel = model ?? process.env.OPENROUTER_MODEL;
  if (!resolvedModel) {
    throw new Error('A model must be provided, or OPENROUTER_MODEL set -- see .env.example.');
  }

  const response = await fetch(OPENROUTER_CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: resolvedModel, messages }),
  });

  if (!response.ok) {
    throw new Error(`OpenRouter request failed (${response.status}): ${await response.text()}`);
  }

  const data = (await response.json()) as { choices: Array<{ message: { content: string } }> };
  return data.choices[0].message.content;
}

/** Full catalog of models OpenRouter currently offers, for the web UI's model dropdown. */
export async function listModels(): Promise<OpenRouterModel[]> {
  const apiKey = requireApiKey();

  const response = await fetch(OPENROUTER_MODELS_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!response.ok) {
    throw new Error(`OpenRouter model list request failed (${response.status}): ${await response.text()}`);
  }

  const data = (await response.json()) as { data: Array<{ id: string; name: string }> };
  return data.data.map((model) => ({ id: model.id, name: model.name }));
}
