import { getServiceClient } from '../lib/supabaseClient.js';
import type { LongTermMemoryEntry, MemoryCategory } from './types.js';

export async function storeLongTermMemory(params: {
  summary: string;
  embedding: number[];
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
