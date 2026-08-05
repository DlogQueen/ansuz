/**
 * Talks to scripts/server.ts via Vite's /api proxy (see vite.config.ts) --
 * same-origin from the browser, so this works identically over localhost and
 * over the Quest's LAN URL with no CORS setup.
 */
const sessionId = crypto.randomUUID();

export interface OpenRouterModel {
  id: string;
  name: string;
}

export async function sendMessage(message: string, model: string): Promise<string> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sessionId, model }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({ error: response.statusText }))) as {
      error?: string;
    };
    throw new Error(body.error ?? `Chat request failed (${response.status})`);
  }

  const data = (await response.json()) as { reply: string };
  return data.reply;
}

export async function fetchModels(): Promise<OpenRouterModel[]> {
  const response = await fetch('/api/models');

  if (!response.ok) {
    const body = (await response.json().catch(() => ({ error: response.statusText }))) as {
      error?: string;
    };
    throw new Error(body.error ?? `Model list request failed (${response.status})`);
  }

  const data = (await response.json()) as { models: OpenRouterModel[] };
  return data.models;
}
