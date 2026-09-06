import { randomUUID } from 'node:crypto';
import { logInteraction, getRecentMemory } from '../memory/shortTermMemory.js';
import { retrieveRecentMemories, retrieveRelevantMemories } from '../memory/longTermMemory.js';
import { embedText } from '../llm/embeddings.js';
import { chatCompletion, isEmbeddingsAvailable, type ChatMessage } from '../llm/chat.js';
import { buildSystemPrompt } from './systemPrompt.js';

/**
 * One turn: log the user's message, retrieve whatever long-term memory is
 * relevant to it, pull the session's recent short-term history for
 * conversational context, call the model, log its reply, return it.
 *
 * Long-term memory will be empty until the consolidation job (still unbuilt
 * -- see README) has actually promoted something from short-term into it;
 * that's expected early on, not a bug.
 */
export async function respond(params: { message: string; sessionId?: string }): Promise<string> {
  const sessionId = params.sessionId ?? randomUUID();

  await logInteraction({ role: 'user', content: params.message, sessionId });

  // Semantic retrieval needs an embeddings endpoint; Groq has none, so on that
  // provider Sophie recalls recent important memories instead of relevant ones.
  const relevant = isEmbeddingsAvailable()
    ? await retrieveRelevantMemories({
        queryEmbedding: await embedText(params.message),
        matchCount: 5,
      })
    : await retrieveRecentMemories({ matchCount: 5, minImportance: 3 });

  const recent = await getRecentMemory(24);
  const sessionHistory: ChatMessage[] = recent
    .filter((entry) => entry.session_id === sessionId)
    .filter((entry): entry is typeof entry & { role: 'user' | 'assistant' } =>
      entry.role === 'user' || entry.role === 'assistant'
    )
    .map((entry) => ({ role: entry.role, content: entry.content }));

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(relevant) },
    ...sessionHistory,
  ];

  const reply = await chatCompletion(messages);

  await logInteraction({ role: 'assistant', content: reply, sessionId });

  return reply;
}
