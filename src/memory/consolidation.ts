import { getServiceClient } from '../lib/supabaseClient.js';
import { tryEmbedText } from '../llm/embeddings.js';
import { chatCompletion, isEmbeddingsAvailable } from '../llm/chat.js';
import { storeLongTermMemory } from './longTermMemory.js';
import type { ShortTermMemoryEntry } from './types.js';

const DEFAULT_IDLE_MINUTES = 10;
const MIN_ENTRIES_TO_CONSOLIDATE = 2;

const SUMMARIZATION_PROMPT = `You distill one finished conversation between Ryleigh and an AI presence \
(Ansuz/Sophie) into a single long-term memory. This isn't a customer support log -- the project's \
actual goal is understanding how a human and an AI relate as distinct-but-complementary minds, so \
weigh facts about Ryleigh, decisions made, and moments where one side corrected or supplemented the \
other's understanding more heavily than small talk.

Reply with ONLY a JSON object, no markdown fences, no commentary:
{"summary": "2-4 sentences, third person, specific enough to be useful weeks from now", "importance": 1-5}

importance guide: 1 = forgettable small talk, 3 = a normal useful exchange, 5 = a fact/decision/moment \
that should clearly shape future conversations.`;

export interface ConsolidationResult {
  sessionsConsolidated: number;
  entriesConsolidated: number;
  sessionsSkippedActive: number;
  sessionsFailed: number;
}

/**
 * Groups short-term memory by session, summarizes any session that looks
 * finished (no activity in the last `idleMinutes`) into a long-term memory
 * entry, and deletes the source rows it just consolidated -- so re-running
 * this doesn't re-summarize the same conversation. Sessions still active
 * (recent activity) and rows with no session_id (can't be grouped into a
 * coherent conversation) are left alone; they age out naturally via
 * short_term_memory's 24h expiry + prune_short_term_memory().
 */
export async function consolidateMemory(params: { idleMinutes?: number; force?: boolean } = {}): Promise<ConsolidationResult> {
  const idleMinutes = params.idleMinutes ?? DEFAULT_IDLE_MINUTES;
  const client = getServiceClient();

  const { data, error } = await client
    .from('short_term_memory')
    .select('*')
    .not('session_id', 'is', null)
    .order('created_at', { ascending: true });
  if (error) throw error;

  const entries = data as ShortTermMemoryEntry[];
  const bySession = new Map<string, ShortTermMemoryEntry[]>();
  for (const entry of entries) {
    const sessionId = entry.session_id as string;
    const group = bySession.get(sessionId);
    if (group) group.push(entry);
    else bySession.set(sessionId, [entry]);
  }

  const idleCutoff = Date.now() - idleMinutes * 60 * 1000;
  const result: ConsolidationResult = {
    sessionsConsolidated: 0,
    entriesConsolidated: 0,
    sessionsSkippedActive: 0,
    sessionsFailed: 0,
  };

  for (const [sessionId, group] of bySession) {
    if (group.length < MIN_ENTRIES_TO_CONSOLIDATE) continue;

    const lastActivity = new Date(group[group.length - 1].created_at).getTime();
    if (!params.force && lastActivity > idleCutoff) {
      result.sessionsSkippedActive += 1;
      continue;
    }

    // One bad session (API hiccup, malformed reply) shouldn't block the rest
    // of the batch -- it just retries on the next interval, same as it would
    // if this whole run had failed outright.
    try {
      await consolidateSession(sessionId, group);
      result.sessionsConsolidated += 1;
      result.entriesConsolidated += group.length;
    } catch (error) {
      result.sessionsFailed += 1;
      console.error(
        `[consolidation] session ${sessionId} failed, will retry next run:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  return result;
}

async function consolidateSession(sessionId: string, group: ShortTermMemoryEntry[]): Promise<void> {
  const transcript = group.map((entry) => `${entry.role}: ${entry.content}`).join('\n');

  const raw = await chatCompletion([
    { role: 'system', content: SUMMARIZATION_PROMPT },
    { role: 'user', content: transcript },
  ]);

  const { summary, importance } = parseSummary(raw);
  // tryEmbedText, not embedText: a failed embedding must not cost us the
  // consolidated summary, since consolidation deletes its source rows.
  const embedding = isEmbeddingsAvailable() ? await tryEmbedText(summary) : null;

  await storeLongTermMemory({
    summary,
    embedding,
    category: 'interaction',
    importance,
    sourceIds: group.map((entry) => entry.id),
    metadata: { sessionId },
  });

  await deleteShortTermEntries(group.map((entry) => entry.id));
}

function parseSummary(raw: string): { summary: string; importance: number } {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : raw) as { summary?: string; importance?: number };
    if (typeof parsed.summary === 'string' && parsed.summary.trim()) {
      const importance = Math.min(5, Math.max(1, Math.round(parsed.importance ?? 3)));
      return { summary: parsed.summary.trim(), importance };
    }
  } catch {
    // fall through to the raw-text fallback below
  }
  console.warn('[consolidation] model reply was not the expected {summary, importance} JSON, using raw text:', raw.slice(0, 200));
  return { summary: raw.trim(), importance: 3 };
}

async function deleteShortTermEntries(ids: string[]): Promise<void> {
  const client = getServiceClient();
  const { error } = await client.from('short_term_memory').delete().in('id', ids);
  if (error) throw error;
}
