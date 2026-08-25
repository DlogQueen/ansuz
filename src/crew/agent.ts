import { chatCompletion, type ChatMessage } from '../llm/openrouter.js';
import { embedText } from '../llm/embeddings.js';
import { retrieveRelevantMemories, storeLongTermMemory } from '../memory/longTermMemory.js';
import type { MemoryCategory } from '../memory/types.js';
import { CREW_CHARTER } from './roster.js';
import { recordRun } from './store.js';
import type { CrewAgent } from './types.js';

/**
 * The one place an agent actually thinks.
 *
 * Every agent -- founding or spawned -- runs through `think()`: retrieve what
 * the crew already learned that's relevant, hand the model the charter + its
 * own mandate + the current operational facts, get structured JSON back, and
 * write the attempt to the audit trail either way. Agents differ by mandate
 * and by the schema they ask for, not by having their own model plumbing.
 */

export interface ThinkParams<T> {
  agent: CrewAgent;
  cycleId: string | null;
  /** Short label for the audit trail, e.g. 'find-gaps'. */
  kind: string;
  /** What this agent is being asked to do right now, plus the facts to do it with. */
  task: string;
  /** Literal shape the model must return, embedded in the prompt. */
  schema: string;
  /** Text used to pull relevant long-term memories. Defaults to the task. */
  memoryQuery?: string;
  /** Validates + narrows the parsed JSON. Throwing here fails the run. */
  parse: (value: unknown) => T;
}

export async function think<T>(params: ThinkParams<T>): Promise<T> {
  const startedAt = Date.now();
  const memories = await recallForAgent(params.memoryQuery ?? params.task);

  const memoryBlock =
    memories.length > 0
      ? `\n\nWhat the crew has already learned that bears on this:\n${memories
          .map((memory) => `- [${memory.category}] ${memory.summary}`)
          .join('\n')}`
      : '\n\nThe crew has no prior learnings relevant to this yet. Say so rather than inventing history.';

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `${CREW_CHARTER}

You are ${params.agent.codename}, the crew's ${params.agent.role}.

${params.agent.mandate}${memoryBlock}

Reply with ONLY a JSON object of exactly this shape:
${params.schema}`,
    },
    { role: 'user', content: params.task },
  ];

  try {
    const raw = await chatCompletion(messages);
    const parsed = params.parse(extractJson(raw));
    await recordRun({
      agentId: params.agent.id,
      cycleId: params.cycleId,
      kind: params.kind,
      input: { task: params.task, memoriesUsed: memories.length },
      output: parsed as unknown as Record<string, unknown>,
      success: true,
      durationMs: Date.now() - startedAt,
    });
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordRun({
      agentId: params.agent.id,
      cycleId: params.cycleId,
      kind: params.kind,
      input: { task: params.task, memoriesUsed: memories.length },
      output: {},
      success: false,
      error: message,
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}

/**
 * Models wrap JSON in prose or fences often enough that a bare JSON.parse is a
 * real source of failed cycles. Try the whole string first (the common case),
 * then the outermost brace-delimited span.
 */
export function extractJson(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error(`Agent reply was not JSON: ${raw.slice(0, 300)}`);
  }
}

async function recallForAgent(
  query: string
): Promise<Array<{ summary: string; category: string }>> {
  try {
    const queryEmbedding = await embedText(query);
    const memories = await retrieveRelevantMemories({ queryEmbedding, matchCount: 6, minImportance: 2 });
    return memories.map((memory) => ({ summary: memory.summary, category: memory.category }));
  } catch (error) {
    // Retrieval is an enhancement, not a precondition -- an embeddings hiccup
    // should degrade the agent to memoryless, not fail the whole cycle.
    console.warn('[crew] memory recall failed, continuing without it:', error instanceof Error ? error.message : error);
    return [];
  }
}

/**
 * Write a durable learning straight into long_term_memory. The crew's
 * conversational memory arrives via consolidation of short_term_memory; its
 * *operational* learnings (a gap validated, a variant that won, a specialist
 * spawned) are written here directly, since they're already summaries and
 * there's nothing to consolidate.
 */
export async function rememberLearning(params: {
  summary: string;
  category: MemoryCategory;
  importance: number;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    const embedding = await embedText(params.summary);
    await storeLongTermMemory({
      summary: params.summary,
      embedding,
      category: params.category,
      importance: Math.min(5, Math.max(1, Math.round(params.importance))),
      metadata: params.metadata ?? {},
    });
  } catch (error) {
    console.error('[crew] failed to store learning:', error instanceof Error ? error.message : error);
  }
}

/** Small helpers the agents share for validating model output. */
export function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Expected non-empty string for "${field}"`);
  }
  return value.trim();
}

export function asNumber(value: unknown, field: string, fallback?: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Expected number for "${field}"`);
  }
  return parsed;
}

export function asArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Expected array for "${field}"`);
  return value;
}
