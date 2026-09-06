import { rememberLearning } from './agent.js';
import { buildSituationReport, planCycle, rememberAssessment, type ManagerPlan } from './manager.js';
import { runOutreach } from './pipeline.js';
import { MAX_SPAWNS_PER_CYCLE, retireUnderperformers, spawnSpecialist } from './replication.js';
import { designOffer, findMarketGaps } from './researcher.js';
import { FOUNDING_CREW } from './roster.js';
import { draftSocialPosts, writeOutreachVariants } from './social.js';
import {
  finishCycle,
  getAgentByCodename,
  listMarketGaps,
  listLiveOffers,
  recordAgentOutcome,
  setCampaignStatus,
  setMarketGapStatus,
  startCycle,
  storeCampaign,
  upsertAgent,
} from './store.js';
import type { CrewAgent, CrewDecision, MarketGap, Offer } from './types.js';

/**
 * One turn of the crew's adapt loop:
 *
 *   observe  -- gather realized outcomes (manager.buildSituationReport)
 *   decide   -- the manager allocates work and prunes what isn't earning
 *   act      -- research finds gaps and prices offers, social writes variants,
 *               the pipeline sends to opted-in leads
 *   learn    -- outcomes go to long_term_memory and to agent fitness, so the
 *               next cycle starts from what this one found out
 *
 * The loop is deliberately one-cycle-per-invocation rather than a `while(true)`
 * inside the process: cycles are scheduled from outside (scripts/server.ts's
 * interval, or `npm run bmdc -- cycle`), which means a bad cycle stops the
 * crew instead of spinning.
 */

export interface CycleResult {
  cycleId: string;
  assessment: string;
  decisions: CrewDecision[];
  gapsFound: number;
  campaignsLaunched: number;
  messagesSent: number;
  socialDrafts: number;
  spawned: string | null;
  retired: string[];
  errors: string[];
}

/** Create the founding three if they aren't on the roster yet. Idempotent. */
export async function seedCrew(): Promise<CrewAgent[]> {
  const agents: CrewAgent[] = [];
  for (const entry of FOUNDING_CREW) {
    agents.push(
      await upsertAgent({
        codename: entry.codename,
        role: entry.role,
        mandate: entry.mandate,
        generation: 0,
      })
    );
  }
  return agents;
}

export async function runCycle(params: { dryRun?: boolean; outreachLimit?: number } = {}): Promise<CycleResult> {
  const cycle = await startCycle();
  const errors: string[] = [];
  const result: CycleResult = {
    cycleId: cycle.id,
    assessment: '',
    decisions: [],
    gapsFound: 0,
    campaignsLaunched: 0,
    messagesSent: 0,
    socialDrafts: 0,
    spawned: null,
    retired: [],
    errors,
  };

  try {
    const manager = await requireAgent('BMDC-CHIEF');
    const prospect = await requireAgent('BMDC-PROSPECT');
    const signal = await requireAgent('BMDC-SIGNAL');

    // --- observe + decide ---------------------------------------------------
    const report = await buildSituationReport();
    const plan = await planCycle({ manager, cycleId: cycle.id, report });
    result.assessment = plan.assessment;
    result.decisions = plan.decisions;

    await applyPruning(plan, errors);

    // --- act: research ------------------------------------------------------
    // Research runs when the crew has nothing testable in flight. Once
    // campaigns are running, more hypotheses are a distraction from the ones
    // already being tested against real money.
    let gaps = await listMarketGaps(['hypothesis', 'testing']);
    if (gaps.length === 0) {
      try {
        const found = await findMarketGaps({
          agent: prospect,
          cycleId: cycle.id,
          focus: plan.researchFocus ?? undefined,
        });
        result.gapsFound = found.length;
        gaps = found;
      } catch (error) {
        errors.push(`research: ${describe(error)}`);
      }
    }

    // --- act: offer + campaign + outreach -----------------------------------
    const targetGap = gaps.find((gap) => gap.status === 'hypothesis') ?? gaps[0];
    if (targetGap) {
      try {
        const offer = await ensureOffer({ prospect, cycleId: cycle.id, gap: targetGap });
        if (offer) {
          const launched = await launchCampaigns({
            signal,
            cycleId: cycle.id,
            gap: targetGap,
            offer,
            dryRun: params.dryRun ?? false,
            outreachLimit: params.outreachLimit,
          });
          result.campaignsLaunched = launched.campaigns;
          result.messagesSent = launched.messagesSent;
          result.socialDrafts = launched.socialDrafts;
          if (launched.campaigns > 0 && targetGap.status === 'hypothesis') {
            await setMarketGapStatus(targetGap.id, 'testing');
          }
        }
      } catch (error) {
        errors.push(`campaign: ${describe(error)}`);
      }
    }

    // --- learn: replication + fitness ---------------------------------------
    if (plan.spawn && MAX_SPAWNS_PER_CYCLE > 0) {
      const outcome = await spawnSpecialist({
        codename: plan.spawn.codename,
        mandate: plan.spawn.mandate,
        parent: manager,
      });
      if (outcome.spawned) result.spawned = outcome.spawned.codename;
      else if (outcome.refused) errors.push(`spawn refused: ${outcome.refused}`);
    }

    const retired = await retireUnderperformers({});
    result.retired = retired.map((agent) => agent.codename);

    // A cycle that moved no money isn't a failure, but it isn't a win either --
    // scoring it at zero is what lets fitness decay for agents that stop
    // producing rather than plateauing on old results.
    await recordAgentOutcome(manager.id, result.messagesSent > 0 ? 0.25 : 0);

    await rememberAssessment(plan, report);

    await finishCycle({
      cycleId: cycle.id,
      status: errors.length > 0 ? 'failed' : 'succeeded',
      summary: plan.assessment,
      decisions: plan.decisions,
      metrics: {
        gapsFound: result.gapsFound,
        campaignsLaunched: result.campaignsLaunched,
        messagesSent: result.messagesSent,
        socialDrafts: result.socialDrafts,
        spawned: result.spawned,
        retired: result.retired,
        errors,
      },
    });

    return result;
  } catch (error) {
    const message = describe(error);
    errors.push(message);
    await finishCycle({
      cycleId: cycle.id,
      status: 'failed',
      summary: `Cycle aborted: ${message}`,
      decisions: result.decisions,
      metrics: { errors },
    });
    return result;
  }
}

async function applyPruning(plan: ManagerPlan, errors: string[]): Promise<void> {
  for (const campaignId of plan.killCampaignIds) {
    try {
      await setCampaignStatus(campaignId, 'complete');
      await rememberLearning({
        summary: `Campaign ${campaignId} stopped by the manager: it was not producing sales.`,
        category: 'campaign-result',
        importance: 3,
        metadata: { campaignId },
      });
    } catch (error) {
      errors.push(`kill campaign ${campaignId}: ${describe(error)}`);
    }
  }

  for (const gapId of plan.killGapIds) {
    try {
      await setMarketGapStatus(gapId, 'killed');
    } catch (error) {
      errors.push(`kill gap ${gapId}: ${describe(error)}`);
    }
  }
}

/** Reuse a live offer already aimed at this gap rather than making a new one each cycle. */
async function ensureOffer(params: {
  prospect: CrewAgent;
  cycleId: string;
  gap: MarketGap;
}): Promise<Offer | null> {
  const live = await listLiveOffers();
  const existing = live.find((offer) => offer.gap_id === params.gap.id);
  if (existing) return existing;

  const offer = await designOffer({ agent: params.prospect, cycleId: params.cycleId, gap: params.gap });
  if (offer.status !== 'live') {
    console.warn(
      `[crew] offer "${offer.name}" could not be made payable (Stripe not configured) -- no outreach this cycle.`
    );
    return null;
  }
  return offer;
}

/**
 * One campaign per copy variant, so the variants compete on realized revenue
 * rather than on anyone's opinion of the copy.
 */
async function launchCampaigns(params: {
  signal: CrewAgent;
  cycleId: string;
  gap: MarketGap;
  offer: Offer;
  dryRun: boolean;
  outreachLimit?: number;
}): Promise<{ campaigns: number; messagesSent: number; socialDrafts: number }> {
  const variants = await writeOutreachVariants({
    agent: params.signal,
    cycleId: params.cycleId,
    gap: params.gap,
    offer: params.offer,
  });

  let campaigns = 0;
  let messagesSent = 0;
  let firstCampaignId: string | null = null;

  for (const variant of variants) {
    const campaign = await storeCampaign({
      createdBy: params.signal.id,
      gapId: params.gap.id,
      offerId: params.offer.id,
      name: `${params.offer.name} — ${params.gap.segment}`,
      channel: 'sms',
      variant: variant.label,
      hypothesis: variant.hypothesis,
    });
    campaigns += 1;
    firstCampaignId ??= campaign.id;

    if (params.dryRun) {
      console.log(`[crew] dry run — would send variant "${variant.label}": ${variant.body}`);
      continue;
    }

    const outreach = await runOutreach({
      campaign,
      offer: params.offer,
      body: variant.body,
      segment: params.gap.segment,
      limit: params.outreachLimit,
    });
    messagesSent += outreach.sent;
  }

  let socialDrafts = 0;
  try {
    const posts = await draftSocialPosts({
      agent: params.signal,
      cycleId: params.cycleId,
      gap: params.gap,
      offer: params.offer,
      campaignId: firstCampaignId,
    });
    socialDrafts = posts.length;
  } catch (error) {
    console.error('[crew] social drafting failed:', describe(error));
  }

  return { campaigns, messagesSent, socialDrafts };
}

async function requireAgent(codename: string): Promise<CrewAgent> {
  const agent = await getAgentByCodename(codename);
  if (!agent) {
    throw new Error(`${codename} is not on the roster. Run \`npm run bmdc -- seed\` first.`);
  }
  return agent;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
