import { asArray, asString, rememberLearning, think } from './agent.js';
import { MAX_ACTIVE_AGENTS, MAX_GENERATION, MAX_SPAWNS_PER_CYCLE } from './replication.js';
import {
  getCampaignPerformance,
  getSalesTotals,
  listAgents,
  listCampaigns,
  listMarketGaps,
} from './store.js';
import type { CrewAgent, CrewDecision } from './types.js';

/**
 * BMDC-CHIEF: reads the state of the business and decides what happens next.
 *
 * The manager never sends a message or writes copy. Its whole job is
 * allocation: which gap gets tested, which campaign gets killed, whether the
 * crew needs a specialist it doesn't have. It is handed realized outcomes only
 * -- no agent's self-assessment reaches it -- so its decisions are grounded in
 * money moved rather than work done.
 */

export interface SituationReport {
  gaps: Array<{ id: string; title: string; segment: string; status: string; confidence: number }>;
  campaigns: Array<{
    id: string;
    name: string;
    variant: string;
    channel: string;
    sent: number;
    replies: number;
    sales: number;
    revenueCents: number;
  }>;
  roster: Array<{ codename: string; role: string; generation: number; fitness: number; runs: number }>;
  totals: { salesCount: number; revenueCents: number };
}

/** Gather the facts. Everything here is measured, nothing is reported by an agent. */
export async function buildSituationReport(): Promise<SituationReport> {
  const [gaps, campaigns, performance, agents, totals] = await Promise.all([
    listMarketGaps(),
    listCampaigns(['running', 'paused']),
    getCampaignPerformance(),
    listAgents(),
    getSalesTotals(),
  ]);

  const performanceById = new Map(performance.map((row) => [row.campaign_id, row]));

  return {
    gaps: gaps.map((gap) => ({
      id: gap.id,
      title: gap.title,
      segment: gap.segment,
      status: gap.status,
      confidence: gap.confidence,
    })),
    campaigns: campaigns.map((campaign) => {
      const row = performanceById.get(campaign.id);
      return {
        id: campaign.id,
        name: campaign.name,
        variant: campaign.variant,
        channel: campaign.channel,
        sent: Number(row?.messages_sent ?? 0),
        replies: Number(row?.replies ?? 0),
        sales: Number(row?.sales_count ?? 0),
        revenueCents: Number(row?.revenue_cents ?? 0),
      };
    }),
    roster: agents.map((agent) => ({
      codename: agent.codename,
      role: agent.role,
      generation: agent.generation,
      fitness: agent.fitness,
      runs: agent.runs,
    })),
    totals: { salesCount: totals.count, revenueCents: totals.revenueCents },
  };
}

export interface ManagerPlan {
  assessment: string;
  decisions: CrewDecision[];
  researchFocus: string | null;
  killCampaignIds: string[];
  killGapIds: string[];
  spawn: { codename: string; mandate: string } | null;
}

const PLAN_SCHEMA = `{
  "assessment": "2-4 sentences on where the crew actually stands, revenue first",
  "decisions": [
    { "agent": "codename", "action": "what they do this cycle", "rationale": "why", "target": "id or empty string" }
  ],
  "research_focus": "what BMDC-PROSPECT should investigate, or empty string for open-ended",
  "kill_campaign_ids": ["campaign ids to stop"],
  "kill_gap_ids": ["gap ids no longer worth pursuing"],
  "spawn": { "codename": "BMDC-SOMETHING", "mandate": "what this specialist owns" }
}`;

export async function planCycle(params: {
  manager: CrewAgent;
  cycleId: string;
  report: SituationReport;
}): Promise<ManagerPlan> {
  const { report } = params;

  const campaignBlock =
    report.campaigns.length > 0
      ? report.campaigns
          .map(
            (campaign) =>
              `- ${campaign.id} "${campaign.name}" (variant ${campaign.variant}, ${campaign.channel}): ` +
              `${campaign.sent} sent, ${campaign.replies} replies, ${campaign.sales} sales, ` +
              `$${(campaign.revenueCents / 100).toFixed(2)}`
          )
          .join('\n')
      : '- none running';

  const gapBlock =
    report.gaps.length > 0
      ? report.gaps
          .map((gap) => `- ${gap.id} "${gap.title}" [${gap.status}, confidence ${gap.confidence.toFixed(2)}] — ${gap.segment}`)
          .join('\n')
      : '- none recorded';

  const rosterBlock = report.roster
    .map(
      (agent) =>
        `- ${agent.codename} (${agent.role}, gen ${agent.generation}): fitness ${agent.fitness.toFixed(3)} over ${agent.runs} runs`
    )
    .join('\n');

  return think<ManagerPlan>({
    agent: params.manager,
    cycleId: params.cycleId,
    kind: 'plan-cycle',
    memoryQuery: 'what has and has not produced sales for this crew',
    schema: PLAN_SCHEMA,
    task: `Plan this cycle.

REVENUE TO DATE: $${(report.totals.revenueCents / 100).toFixed(2)} across ${report.totals.salesCount} sale(s).

MARKET GAPS:
${gapBlock}

CAMPAIGNS:
${campaignBlock}

ROSTER:
${rosterBlock}

Replication limits you must plan within: at most ${MAX_ACTIVE_AGENTS} active agents
(currently ${report.roster.length}), at most ${MAX_SPAWNS_PER_CYCLE} new specialist per cycle,
lineage depth at most ${MAX_GENERATION}. Set "spawn" to null unless there is a concrete job
none of the current agents covers -- an extra agent with an overlapping mandate makes the
crew slower, not smarter.

Kill campaigns that have sent a meaningful number of messages and produced no sales. Kill
gaps the outcome data has argued against. If the crew has sent nothing yet, say so and get
one campaign running rather than planning a second round of research.`,
    parse: (value) => {
      const plan = value as Record<string, unknown>;
      const decisions = Array.isArray(plan.decisions) ? plan.decisions : [];
      const spawnRaw = plan.spawn as Record<string, unknown> | null | undefined;

      return {
        assessment: asString(plan.assessment, 'assessment'),
        decisions: decisions.map((raw) => {
          const decision = raw as Record<string, unknown>;
          return {
            agent: asString(decision.agent, 'decisions[].agent'),
            action: asString(decision.action, 'decisions[].action'),
            rationale: typeof decision.rationale === 'string' ? decision.rationale : '',
            target: typeof decision.target === 'string' && decision.target ? decision.target : undefined,
          };
        }),
        researchFocus:
          typeof plan.research_focus === 'string' && plan.research_focus.trim()
            ? plan.research_focus.trim()
            : null,
        killCampaignIds: toIdList(plan.kill_campaign_ids),
        killGapIds: toIdList(plan.kill_gap_ids),
        spawn:
          spawnRaw && typeof spawnRaw.codename === 'string' && typeof spawnRaw.mandate === 'string'
            ? { codename: spawnRaw.codename, mandate: spawnRaw.mandate }
            : null,
      };
    },
  });
}

/**
 * Record what the manager concluded, so the next cycle's retrieval can surface
 * it. Only the assessment is stored -- the decisions themselves live on the
 * cycle row, and duplicating them into memory just crowds out learnings.
 */
export async function rememberAssessment(plan: ManagerPlan, report: SituationReport): Promise<void> {
  await rememberLearning({
    summary: `Crew assessment at $${(report.totals.revenueCents / 100).toFixed(2)} revenue: ${plan.assessment}`,
    category: 'campaign-result',
    importance: report.totals.salesCount > 0 ? 4 : 3,
    metadata: {
      revenueCents: report.totals.revenueCents,
      salesCount: report.totals.salesCount,
      campaignsRunning: report.campaigns.length,
    },
  });
}

function toIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return asArray(value, 'ids')
    .map((item) => String(item).trim())
    .filter((item) => item.length > 0);
}
