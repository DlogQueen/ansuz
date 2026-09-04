// Routed through OpenRouter (OpenAI-compatible /embeddings endpoint) rather
// than OpenAI directly, so the conversation loop only needs the one funded
// key -- see .env.example.
const OPENROUTER_EMBEDDINGS_URL = 'https://openrouter.ai/api/v1/embeddings';
// Must match EMBEDDING_DIMENSIONS / the vector(1536) column in
// supabase/migrations/0001_init_memory_schema.sql -- change together.
const EMBEDDING_MODEL = 'openai/text-embedding-3-small';

export async function embedText(text: string): Promise<number[]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY must be set to generate embeddings.');
  }

  const response = await fetch(OPENROUTER_EMBEDDINGS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
  });

  if (!response.ok) {
    throw new Error(`OpenRouter embeddings request failed (${response.status}): ${await response.text()}`);
  }

  const data = (await response.json()) as { data: Array<{ embedding: number[] }> };
  return data.data[0].embedding;
}

/**
 * Embed, or return null if embedding isn't possible right now.
 *
 * Distinct from `isEmbeddingsAvailable()`, which only answers "is a key
 * configured". A key can be present and still fail per-call -- an unfunded
 * OpenRouter account returns 402, which is the common case once a
 * pay-as-you-go balance runs out. Callers that are *storing* something use
 * this: a memory written without an embedding is degraded but recoverable,
 * whereas letting the throw propagate loses the write entirely.
 *
 * Callers that are *retrieving* should keep using embedText() and handle the
 * failure themselves -- there, silence would hide a real outage.
 */
export async function tryEmbedText(text: string): Promise<number[] | null> {
  try {
    return await embedText(text);
  } catch (error) {
    console.warn(
      '[embeddings] unavailable, storing without a vector:',
      error instanceof Error ? error.message : error
    );
    return null;
  }
}
