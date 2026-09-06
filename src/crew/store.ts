import { getServiceClient } from '../lib/supabaseClient.js';
import type {
  Campaign,
  CampaignPerformance,
  ConsentStatus,
  CrewAgent,
  CrewCycle,
  CrewDecision,
  CrewRole,
  Lead,
  LeadStage,
  MarketGap,
  Offer,
  OutreachMessage,
  Sale,
  SocialPost,
} from './types.js';

/**
 * Every read/write the crew does against its operational tables. Kept in one
 * module (rather than one per entity) because the agents mostly work across
 * entities -- a manager decision touches gaps, campaigns and agents in the
 * same breath -- and splitting it just meant four imports per agent file.
 *
 * All of this goes through the service-role client, same as memory: the crew
 * tables have RLS on with no policies (see 0002_bmdc_crew.sql).
 */

// --- agents ---------------------------------------------------------------

export async function listAgents(params: { includeRetired?: boolean } = {}): Promise<CrewAgent[]> {
  const client = getServiceClient();
  let query = client.from('crew_agents').select('*').order('generation', { ascending: true });
  if (!params.includeRetired) query = query.eq('status', 'active');

  const { data, error } = await query;
  if (error) throw error;
  return data as CrewAgent[];
}

export async function getAgentByCodename(codename: string): Promise<CrewAgent | null> {
  const client = getServiceClient();
  const { data, error } = await client
    .from('crew_agents')
    .select('*')
    .eq('codename', codename)
    .maybeSingle();
  if (error) throw error;
  return (data as CrewAgent) ?? null;
}

export async function upsertAgent(params: {
  codename: string;
  role: CrewRole;
  mandate: string;
  generation?: number;
  parentId?: string | null;
  config?: Record<string, unknown>;
}): Promise<CrewAgent> {
  const client = getServiceClient();
  const { data, error } = await client
    .from('crew_agents')
    .upsert(
      {
        codename: params.codename,
        role: params.role,
        mandate: params.mandate,
        generation: params.generation ?? 0,
        parent_id: params.parentId ?? null,
        config: params.config ?? {},
      },
      { onConflict: 'codename' }
    )
    .select()
    .single();
  if (error) throw error;
  return data as CrewAgent;
}

export async function setAgentStatus(agentId: string, status: CrewAgent['status']): Promise<void> {
  const client = getServiceClient();
  const { error } = await client
    .from('crew_agents')
    .update({ status, retired_at: status === 'retired' ? new Date().toISOString() : null })
    .eq('id', agentId);
  if (error) throw error;
}

/**
 * Blend a new outcome into an agent's rolling fitness. Exponential rather than
 * a running average so a specialist that stops earning fades quickly instead of
 * coasting on early wins -- the whole point of the fitness signal is to let the
 * manager retire agents that have gone stale.
 */
export async function recordAgentOutcome(agentId: string, outcomeScore: number): Promise<void> {
  const client = getServiceClient();
  const { data, error } = await client
    .from('crew_agents')
    .select('fitness, runs')
    .eq('id', agentId)
    .single();
  if (error) throw error;

  const alpha = 0.3;
  const current = (data as { fitness: number; runs: number }).fitness;
  const runs = (data as { fitness: number; runs: number }).runs;
  const blended = runs === 0 ? outcomeScore : current * (1 - alpha) + outcomeScore * alpha;

  const { error: updateError } = await client
    .from('crew_agents')
    .update({ fitness: blended, runs: runs + 1 })
    .eq('id', agentId);
  if (updateError) throw updateError;
}

// --- cycles and run audit -------------------------------------------------

export async function startCycle(): Promise<CrewCycle> {
  const client = getServiceClient();
  const { data, error } = await client.from('crew_cycles').insert({}).select().single();
  if (error) throw error;
  return data as CrewCycle;
}

export async function finishCycle(params: {
  cycleId: string;
  status: 'succeeded' | 'failed';
  summary: string;
  decisions: CrewDecision[];
  metrics: Record<string, unknown>;
}): Promise<void> {
  const client = getServiceClient();
  const { error } = await client
    .from('crew_cycles')
    .update({
      finished_at: new Date().toISOString(),
      status: params.status,
      summary: params.summary,
      decisions: params.decisions,
      metrics: params.metrics,
    })
    .eq('id', params.cycleId);
  if (error) throw error;
}

export async function recordRun(params: {
  agentId: string | null;
  cycleId: string | null;
  kind: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  success: boolean;
  error?: string;
  durationMs?: number;
}): Promise<void> {
  const client = getServiceClient();
  const { error } = await client.from('agent_runs').insert({
    agent_id: params.agentId,
    cycle_id: params.cycleId,
    kind: params.kind,
    input: params.input,
    output: params.output,
    success: params.success,
    error: params.error ?? null,
    duration_ms: params.durationMs ?? null,
  });
  // An audit-trail write failing shouldn't take down the work it was auditing.
  if (error) console.error('[crew] failed to record agent run:', error.message);
}

// --- market gaps ----------------------------------------------------------

export async function storeMarketGap(params: {
  discoveredBy: string | null;
  title: string;
  segment: string;
  description: string;
  evidence: string[];
  confidence: number;
}): Promise<MarketGap> {
  const client = getServiceClient();
  const { data, error } = await client
    .from('market_gaps')
    .insert({
      discovered_by: params.discoveredBy,
      title: params.title,
      segment: params.segment,
      description: params.description,
      evidence: params.evidence,
      confidence: Math.min(1, Math.max(0, params.confidence)),
    })
    .select()
    .single();
  if (error) throw error;
  return data as MarketGap;
}

export async function listMarketGaps(
  statuses: MarketGap['status'][] = ['hypothesis', 'testing', 'validated']
): Promise<MarketGap[]> {
  const client = getServiceClient();
  const { data, error } = await client
    .from('market_gaps')
    .select('*')
    .in('status', statuses)
    .order('confidence', { ascending: false });
  if (error) throw error;
  return data as MarketGap[];
}

export async function setMarketGapStatus(
  gapId: string,
  status: MarketGap['status'],
  metrics: Record<string, unknown> = {}
): Promise<void> {
  const client = getServiceClient();
  const { error } = await client.from('market_gaps').update({ status, metrics }).eq('id', gapId);
  if (error) throw error;
}

// --- offers ---------------------------------------------------------------

export async function storeOffer(params: {
  gapId: string | null;
  name: string;
  pitch: string;
  priceCents: number;
  currency?: string;
}): Promise<Offer> {
  const client = getServiceClient();
  const { data, error } = await client
    .from('offers')
    .insert({
      gap_id: params.gapId,
      name: params.name,
      pitch: params.pitch,
      price_cents: params.priceCents,
      currency: params.currency ?? 'usd',
    })
    .select()
    .single();
  if (error) throw error;
  return data as Offer;
}

export async function attachStripeToOffer(params: {
  offerId: string;
  productId: string;
  priceId: string;
  paymentLinkUrl: string | null;
}): Promise<Offer> {
  const client = getServiceClient();
  const { data, error } = await client
    .from('offers')
    .update({
      stripe_product_id: params.productId,
      stripe_price_id: params.priceId,
      payment_link_url: params.paymentLinkUrl,
      status: 'live',
    })
    .eq('id', params.offerId)
    .select()
    .single();
  if (error) throw error;
  return data as Offer;
}

export async function getOffer(offerId: string): Promise<Offer | null> {
  const client = getServiceClient();
  const { data, error } = await client.from('offers').select('*').eq('id', offerId).maybeSingle();
  if (error) throw error;
  return (data as Offer) ?? null;
}

export async function listLiveOffers(): Promise<Offer[]> {
  const client = getServiceClient();
  const { data, error } = await client.from('offers').select('*').eq('status', 'live');
  if (error) throw error;
  return data as Offer[];
}

// --- leads ----------------------------------------------------------------

export async function upsertLead(params: {
  phone?: string;
  email?: string;
  name?: string;
  segment?: string;
  source?: string;
  attributes?: Record<string, unknown>;
}): Promise<Lead> {
  const client = getServiceClient();
  const { data, error } = await client
    .from('leads')
    .upsert(
      {
        phone: params.phone ?? null,
        email: params.email ?? null,
        name: params.name ?? null,
        segment: params.segment ?? null,
        source: params.source ?? 'unknown',
        attributes: params.attributes ?? {},
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'phone' }
    )
    .select()
    .single();
  if (error) throw error;
  return data as Lead;
}

export async function getLeadByPhone(phone: string): Promise<Lead | null> {
  const client = getServiceClient();
  const { data, error } = await client.from('leads').select('*').eq('phone', phone).maybeSingle();
  if (error) throw error;
  return (data as Lead) ?? null;
}

/**
 * Consent transitions. Opting out is terminal by design: `opted_out` leads are
 * rejected here rather than quietly flipped back, so no agent (and no bug) can
 * walk a STOP back into an opt-in. Re-subscribing is a deliberate human action
 * against the database, not something the crew can do to itself.
 */
export async function setLeadConsent(params: {
  leadId: string;
  status: ConsentStatus;
  source: string;
}): Promise<void> {
  const client = getServiceClient();
  const { data, error } = await client
    .from('leads')
    .select('consent_status')
    .eq('id', params.leadId)
    .single();
  if (error) throw error;

  if ((data as { consent_status: ConsentStatus }).consent_status === 'opted_out' && params.status !== 'opted_out') {
    throw new Error(
      `Lead ${params.leadId} has opted out; consent cannot be restored programmatically.`
    );
  }

  const now = new Date().toISOString();
  const { error: updateError } = await client
    .from('leads')
    .update({
      consent_status: params.status,
      consent_source: params.source,
      consent_at: params.status === 'opted_in' ? now : null,
      opted_out_at: params.status === 'opted_out' ? now : null,
      updated_at: now,
    })
    .eq('id', params.leadId);
  if (updateError) throw updateError;
}

export async function setLeadStage(leadId: string, stage: LeadStage): Promise<void> {
  const client = getServiceClient();
  const { error } = await client
    .from('leads')
    .update({ stage, updated_at: new Date().toISOString() })
    .eq('id', leadId);
  if (error) throw error;
}

/** Contactable leads only: opted in, not yet won or lost. */
export async function listReachableLeads(params: {
  segment?: string;
  limit?: number;
}): Promise<Lead[]> {
  const client = getServiceClient();
  let query = client
    .from('leads')
    .select('*')
    .eq('consent_status', 'opted_in')
    .not('phone', 'is', null)
    .not('stage', 'in', '("won","lost")')
    .order('score', { ascending: false })
    .limit(params.limit ?? 25);
  if (params.segment) query = query.eq('segment', params.segment);

  const { data, error } = await query;
  if (error) throw error;
  return data as Lead[];
}

// --- campaigns ------------------------------------------------------------

export async function storeCampaign(params: {
  createdBy: string | null;
  gapId: string | null;
  offerId: string | null;
  name: string;
  channel: Campaign['channel'];
  variant: string;
  hypothesis: string;
}): Promise<Campaign> {
  const client = getServiceClient();
  const { data, error } = await client
    .from('campaigns')
    .insert({
      created_by: params.createdBy,
      gap_id: params.gapId,
      offer_id: params.offerId,
      name: params.name,
      channel: params.channel,
      variant: params.variant,
      hypothesis: params.hypothesis,
      status: 'running',
    })
    .select()
    .single();
  if (error) throw error;
  return data as Campaign;
}

export async function setCampaignStatus(
  campaignId: string,
  status: Campaign['status']
): Promise<void> {
  const client = getServiceClient();
  const { error } = await client.from('campaigns').update({ status }).eq('id', campaignId);
  if (error) throw error;
}

export async function listCampaigns(statuses: Campaign['status'][] = ['running']): Promise<Campaign[]> {
  const client = getServiceClient();
  const { data, error } = await client.from('campaigns').select('*').in('status', statuses);
  if (error) throw error;
  return data as Campaign[];
}

export async function getCampaignPerformance(): Promise<CampaignPerformance[]> {
  const client = getServiceClient();
  const { data, error } = await client.rpc('campaign_performance');
  if (error) throw error;
  return data as CampaignPerformance[];
}

// --- outreach -------------------------------------------------------------

export async function recordOutreach(params: {
  campaignId: string | null;
  leadId: string;
  direction: OutreachMessage['direction'];
  channel: OutreachMessage['channel'];
  body: string;
  providerSid?: string | null;
  status: OutreachMessage['status'];
  error?: string | null;
}): Promise<OutreachMessage> {
  const client = getServiceClient();
  const { data, error } = await client
    .from('outreach_messages')
    .insert({
      campaign_id: params.campaignId,
      lead_id: params.leadId,
      direction: params.direction,
      channel: params.channel,
      body: params.body,
      provider_sid: params.providerSid ?? null,
      status: params.status,
      error: params.error ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  return data as OutreachMessage;
}

export async function getConversation(leadId: string, limit = 20): Promise<OutreachMessage[]> {
  const client = getServiceClient();
  const { data, error } = await client
    .from('outreach_messages')
    .select('*')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as OutreachMessage[]).reverse();
}

/** The campaign a lead was last contacted under -- used to attribute replies. */
export async function getLastCampaignForLead(leadId: string): Promise<string | null> {
  const client = getServiceClient();
  const { data, error } = await client
    .from('outreach_messages')
    .select('campaign_id')
    .eq('lead_id', leadId)
    .eq('direction', 'outbound')
    .not('campaign_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as { campaign_id: string } | null)?.campaign_id ?? null;
}

// --- social ---------------------------------------------------------------

export async function storeSocialPost(params: {
  campaignId: string | null;
  createdBy: string | null;
  platform: string;
  body: string;
  hashtags: string[];
}): Promise<SocialPost> {
  const client = getServiceClient();
  const { data, error } = await client
    .from('social_posts')
    .insert({
      campaign_id: params.campaignId,
      created_by: params.createdBy,
      platform: params.platform,
      body: params.body,
      hashtags: params.hashtags,
    })
    .select()
    .single();
  if (error) throw error;
  return data as SocialPost;
}

export async function listSocialPosts(
  statuses: SocialPost['status'][] = ['draft', 'approved']
): Promise<SocialPost[]> {
  const client = getServiceClient();
  const { data, error } = await client
    .from('social_posts')
    .select('*')
    .in('status', statuses)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data as SocialPost[];
}

// --- sales ----------------------------------------------------------------

export async function recordSale(params: {
  leadId: string | null;
  offerId: string | null;
  campaignId: string | null;
  stripeSessionId: string;
  stripePaymentIntent?: string | null;
  amountCents: number;
  currency: string;
  status: Sale['status'];
}): Promise<Sale> {
  const client = getServiceClient();
  // Upsert on the Stripe session id: Stripe retries webhooks, and a retry must
  // not book the same sale twice.
  const { data, error } = await client
    .from('sales')
    .upsert(
      {
        lead_id: params.leadId,
        offer_id: params.offerId,
        campaign_id: params.campaignId,
        stripe_session_id: params.stripeSessionId,
        stripe_payment_intent: params.stripePaymentIntent ?? null,
        amount_cents: params.amountCents,
        currency: params.currency,
        status: params.status,
      },
      { onConflict: 'stripe_session_id' }
    )
    .select()
    .single();
  if (error) throw error;
  return data as Sale;
}

export async function getSalesTotals(): Promise<{ count: number; revenueCents: number }> {
  const client = getServiceClient();
  const { data, error } = await client.from('sales').select('amount_cents').eq('status', 'paid');
  if (error) throw error;
  const rows = data as Array<{ amount_cents: number }>;
  return {
    count: rows.length,
    revenueCents: rows.reduce((total, row) => total + row.amount_cents, 0),
  };
}
