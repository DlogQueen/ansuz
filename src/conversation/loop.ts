import { randomUUID } from 'node:crypto';
import { logInteraction, getRecentMemory } from '../memory/shortTermMemory.js';
import { retrieveRelevantMemories } from '../memory/longTermMemory.js';
import { embedText } from '../llm/embeddings.js';
import { chatCompletion, type ChatMessage } from '../llm/openrouter.js';
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

  const queryEmbedding = await embedText(params.message);
  const relevant = await retrieveRelevantMemories({ queryEmbedding, matchCount: 5 });

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
