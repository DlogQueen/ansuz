import { getServiceClient } from '../lib/supabaseClient.js';
import type { MemoryRole, ShortTermMemoryEntry } from './types.js';

export async function logInteraction(params: {
  role: MemoryRole;
  content: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}): Promise<ShortTermMemoryEntry> {
  const client = getServiceClient();
  const { data, error } = await client
    .from('short_term_memory')
    .insert({
      role: params.role,
      content: params.content,
      session_id: params.sessionId ?? null,
      metadata: params.metadata ?? {},
    })
    .select()
    .single();

  if (error) throw error;
  return data as ShortTermMemoryEntry;
}

/** Fetch the rolling short-term window (defaults to the last 24h). */
export async function getRecentMemory(sinceHours = 24): Promise<ShortTermMemoryEntry[]> {
  const client = getServiceClient();
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();
  const { data, error } = await client
    .from('short_term_memory')
    .select('*')
    .gte('created_at', since)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data as ShortTermMemoryEntry[];
}

/** Delete entries past their 24h expiry. Call after consolidation has run. */
export async function pruneExpiredMemory(): Promise<void> {
  const client = getServiceClient();
  const { error } = await client.rpc('prune_short_term_memory');
  if (error) throw error;
}
