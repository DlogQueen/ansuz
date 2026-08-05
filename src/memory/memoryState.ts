import { getServiceClient } from '../lib/supabaseClient.js';

/**
 * The two scalars the WebXR scene renders itself from (see
 * web/src/scene/environment.ts). Phase 3/4 of the build plan calls for the
 * space to be driven by Sophie's actual memory rather than a placeholder
 * oscillator; this is that signal.
 */
export interface MemoryState {
  /** 0..1 -- how much unconsolidated short-term memory is currently held. */
  memoryLoad: number;
  /** 0..1 -- how well the last retrieval matched. 0.5 until one has happened. */
  coherence: number;
  /** Raw counts, useful for debugging and for the client to display. */
  shortTermRows: number;
  longTermRows: number;
  /** False until a retrieval has actually run this process lifetime. */
  hasRetrieved: boolean;
}

/**
 * Short-term rows that count as "fully loaded". The table is a rolling 24h
 * window, and observed real sessions run ~2-20 rows each, so a few busy
 * sessions' worth is the right ceiling -- high enough that ordinary use
 * doesn't peg the scene at maximum density, low enough to actually reach.
 */
const FULL_LOAD_ROWS = 60;

/**
 * Cosine similarities from `match_long_term_memories` don't span the full
 * 0..1 range, so the working band gets mapped onto 0..1 -- otherwise the
 * scene parks permanently mid-range and the signal is invisible.
 *
 * Calibrated against this project's actual consolidated memories rather than
 * guessed: averaged over 5 retrieved rows, a query that genuinely matches
 * ("the willow tree by the lake") measures ~0.26, and an unrelated one
 * (industrial forklift depreciation) measures below 0.12. An earlier
 * 0.15-0.6 band -- assumed from typical embedding ranges -- squashed a real
 * match down to 0.24, reading as "scattered" when it should read as a hit.
 * Note these are means including weak tail matches, which is why they sit
 * lower than a single top-hit similarity would.
 */
const SIMILARITY_FLOOR = 0.08;
const SIMILARITY_CEILING = 0.4;

let lastCoherence = 0.5;
let hasRetrieved = false;

/**
 * Called by the conversation loop after each retrieval. Averaging beats
 * taking the top hit: one strong match among four weak ones means retrieval
 * is scattered, and the scene should say so.
 */
export function recordRetrievalCoherence(similarities: number[]): void {
  if (similarities.length === 0) {
    // A retrieval that matched nothing at all is meaningful -- it's the
    // least coherent outcome there is, not an absence of data.
    lastCoherence = 0;
    hasRetrieved = true;
    return;
  }

  const mean = similarities.reduce((total, value) => total + value, 0) / similarities.length;
  const normalized = (mean - SIMILARITY_FLOOR) / (SIMILARITY_CEILING - SIMILARITY_FLOOR);
  lastCoherence = Math.min(1, Math.max(0, normalized));
  hasRetrieved = true;
}

export async function getMemoryState(): Promise<MemoryState> {
  const client = getServiceClient();

  const [shortTerm, longTerm] = await Promise.all([
    client.from('short_term_memory').select('*', { count: 'exact', head: true }),
    client.from('long_term_memory').select('*', { count: 'exact', head: true }),
  ]);

  if (shortTerm.error) throw shortTerm.error;
  if (longTerm.error) throw longTerm.error;

  const shortTermRows = shortTerm.count ?? 0;
  const longTermRows = longTerm.count ?? 0;

  return {
    memoryLoad: Math.min(1, shortTermRows / FULL_LOAD_ROWS),
    coherence: lastCoherence,
    shortTermRows,
    longTermRows,
    hasRetrieved,
  };
}
