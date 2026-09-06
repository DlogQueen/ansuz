import { rememberLearning } from './agent.js';
import { CREW_CHARTER } from './roster.js';
import { listAgents, setAgentStatus, upsertAgent } from './store.js';
import type { CrewAgent } from './types.js';

/**
 * Self-replication, bounded.
 *
 * "Self-replicating" here means the crew can grow its own roster: when the
 * manager sees a niche its current agents don't cover, it writes a mandate and
 * a new specialist starts running in the next cycle, inheriting the charter and
 * the shared memory. A spawned agent is a row in `crew_agents` executed by this
 * same process -- the crew does not write code, copy itself to other machines,
 * provision infrastructure, or spend money without a human-configured key.
 *
 * The caps below are the whole safety story, so they're enforced here, in one
 * place, rather than trusted to the manager's prompt. A model that decides it
 * needs forty agents gets `MAX_ACTIVE_AGENTS` instead.
 */

/** Total active agents, founders included. */
export const MAX_ACTIVE_AGENTS = 8;
/** How far a lineage can get from a founding agent. */
export const MAX_GENERATION = 3;
/** New specialists per cycle -- growth stays gradual enough to observe. */
export const MAX_SPAWNS_PER_CYCLE = 1;

export interface SpawnRequest {
  codename: string;
  mandate: string;
  parent: CrewAgent;
}

export interface SpawnOutcome {
  spawned: CrewAgent | null;
  refused: string | null;
}

/**
 * Create one specialist under the caps. Refusals are returned rather than
 * thrown: hitting a cap is a normal, expected outcome of a cycle, not an
 * error, and the manager gets told about it so it can plan around it.
 */
export async function spawnSpecialist(request: SpawnRequest): Promise<SpawnOutcome> {
  const active = await listAgents();

  if (active.length >= MAX_ACTIVE_AGENTS) {
    return {
      spawned: null,
      refused: `Roster is at the cap of ${MAX_ACTIVE_AGENTS} active agents. Retire one before spawning another.`,
    };
  }

  const generation = request.parent.generation + 1;
  if (generation > MAX_GENERATION) {
    return {
      spawned: null,
      refused: `${request.parent.codename} is at generation ${request.parent.generation}; the lineage cap is ${MAX_GENERATION}.`,
    };
  }

  const codename = normalizeCodename(request.codename);
  if (active.some((agent) => agent.codename === codename)) {
    return { spawned: null, refused: `An agent named ${codename} is already active.` };
  }

  const spawned = await upsertAgent({
    codename,
    role: 'specialist',
    // The charter is prepended at spawn time, not merely at prompt time, so
    // that an agent's stored mandate is self-contained -- reading the row tells
    // you everything that agent operates under.
    mandate: `${CREW_CHARTER}\n\nYour specialist mandate:\n${request.mandate}`,
    generation,
    parentId: request.parent.id,
    config: { spawnedBy: request.parent.codename, spawnedAt: new Date().toISOString() },
  });

  await rememberLearning({
    summary: `${request.parent.codename} spawned specialist ${codename} (generation ${generation}): ${request.mandate}`,
    category: 'crew-spawn',
    importance: 4,
    metadata: { agentId: spawned.id, parentId: request.parent.id, generation },
  });

  return { spawned, refused: null };
}

/**
 * Retire specialists that have run enough times to have a verdict and aren't
 * earning. Founders are never auto-retired -- losing the manager or the only
 * researcher would leave a crew that can't recover on its own.
 */
export async function retireUnderperformers(params: {
  minRuns?: number;
  fitnessFloor?: number;
}): Promise<CrewAgent[]> {
  const minRuns = params.minRuns ?? 5;
  const fitnessFloor = params.fitnessFloor ?? 0.05;

  const active = await listAgents();
  const retired: CrewAgent[] = [];

  for (const agent of active) {
    if (agent.role !== 'specialist') continue;
    if (agent.runs < minRuns) continue;
    if (agent.fitness >= fitnessFloor) continue;

    await setAgentStatus(agent.id, 'retired');
    retired.push(agent);
    await rememberLearning({
      summary: `Retired specialist ${agent.codename} after ${agent.runs} runs at fitness ${agent.fitness.toFixed(3)} — its mandate did not produce sales.`,
      category: 'crew-spawn',
      importance: 3,
      metadata: { agentId: agent.id, fitness: agent.fitness, runs: agent.runs },
    });
  }

  return retired;
}

function normalizeCodename(raw: string): string {
  const cleaned = raw
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
  const base = cleaned || 'SPECIALIST';
  return base.startsWith('BMDC-') ? base : `BMDC-${base}`;
}
