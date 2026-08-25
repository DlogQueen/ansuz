import { getServiceClient } from '../lib/supabaseClient.js';
import type { LongTermMemoryEntry, MemoryCategory } from './types.js';

export async function storeLongTermMemory(params: {
  summary: string;
  /**
   * Null when the active provider has no embeddings endpoint (Groq). The row
   * is still written -- a learning without an embedding is worth keeping and
   * is still reachable via retrieveRecentMemories(); losing it entirely
   * because retrieval happens to be degraded would be the worse trade.
   */
  embedding: number[] | null;
  category?: MemoryCategory;
  importance?: number;
  sourceIds?: string[];
  metadata?: Record<string, unknown>;
}): Promise<LongTermMemoryEntry> {
  const client = getServiceClient();
  const { data, error } = await client
    .from('long_term_memory')
    .insert({
      summary: params.summary,
      embedding: params.embedding,
      category: params.category ?? 'interaction',
      importance: params.importance ?? 3,
      source_ids: params.sourceIds ?? [],
      metadata: params.metadata ?? {},
    })
    .select()
    .single();

  if (error) throw error;
  return data as LongTermMemoryEntry;
}

/** Vector-similarity search over long-term memory via match_long_term_memories(). */
export async function retrieveRelevantMemories(params: {
  queryEmbedding: number[];
  matchCount?: number;
  minImportance?: number;
}): Promise<Array<LongTermMemoryEntry & { similarity: number }>> {
  const client = getServiceClient();
  const { data, error } = await client.rpc('match_long_term_memories', {
    query_embedding: params.queryEmbedding,
    match_count: params.matchCount ?? 5,
    min_importance: params.minImportance ?? 1,
  });

  if (error) throw error;
  return data as Array<LongTermMemoryEntry & { similarity: number }>;
}

/**
 * Non-semantic fallback: the most important recent memories, newest first.
 *
 * Used when the active provider has no embeddings endpoint (Groq). This is a
 * genuinely worse retrieval -- it surfaces what's recent and flagged important
 * rather than what's *relevant to the question being asked* -- but it keeps
 * learnings flowing across cycles instead of the crew starting cold every time.
 * Prefer vector search whenever OpenRouter is funded.
 */
export async function retrieveRecentMemories(params: {
  matchCount?: number;
  minImportance?: number;
  categories?: MemoryCategory[];
}): Promise<LongTermMemoryEntry[]> {
  const client = getServiceClient();
  let query = client
    .from('long_term_memory')
    .select('*')
    .gte('importance', params.minImportance ?? 3)
    .order('importance', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(params.matchCount ?? 6);
  if (params.categories?.length) query = query.in('category', params.categories);

  const { data, error } = await query;
  if (error) throw error;
  return data as LongTermMemoryEntry[];
}
