export type MemoryRole = 'user' | 'assistant' | 'system' | 'perception';

export type MemoryCategory =
  | 'interaction'
  | 'built-artifact'
  | 'self-repair-success'
  | 'self-repair-failure'
  // BMDC's operational learnings, added in 0002_bmdc_crew.sql -- keep this
  // union in step with that migration's check constraint.
  | 'market-gap'
  | 'campaign-result'
  | 'sales-outcome'
  | 'crew-spawn'
  | 'other';

export interface ShortTermMemoryEntry {
  id: string;
  created_at: string;
  expires_at: string;
  role: MemoryRole;
  content: string;
  session_id: string | null;
  metadata: Record<string, unknown>;
}

export interface LongTermMemoryEntry {
  id: string;
  created_at: string;
  category: MemoryCategory;
  summary: string;
  embedding: number[] | null;
  importance: number;
  source_ids: string[];
  metadata: Record<string, unknown>;
}
