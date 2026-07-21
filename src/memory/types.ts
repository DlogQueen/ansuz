export type MemoryRole = 'user' | 'assistant' | 'system' | 'perception';

export type MemoryCategory =
  | 'interaction'
  | 'built-artifact'
  | 'self-repair-success'
  | 'self-repair-failure'
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
