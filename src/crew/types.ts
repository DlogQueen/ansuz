export type CrewRole = 'manager' | 'researcher' | 'social' | 'specialist';
export type CrewAgentStatus = 'active' | 'paused' | 'retired';

export interface CrewAgent {
  id: string;
  created_at: string;
  retired_at: string | null;
  codename: string;
  role: CrewRole;
  generation: number;
  parent_id: string | null;
  status: CrewAgentStatus;
  mandate: string;
  config: Record<string, unknown>;
  fitness: number;
  runs: number;
}

export interface CrewCycle {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: 'running' | 'succeeded' | 'failed';
  summary: string | null;
  decisions: CrewDecision[];
  metrics: Record<string, unknown>;
}

/** One thing the manager decided to do, recorded before it is carried out. */
export interface CrewDecision {
  agent: string;
  action: string;
  rationale: string;
  target?: string;
}

export interface MarketGap {
  id: string;
  created_at: string;
  discovered_by: string | null;
  title: string;
  segment: string;
  description: string;
  evidence: string[];
  confidence: number;
  status: 'hypothesis' | 'testing' | 'validated' | 'killed';
  metrics: Record<string, unknown>;
}

export interface Offer {
  id: string;
  created_at: string;
  gap_id: string | null;
  name: string;
  pitch: string;
  price_cents: number;
  currency: string;
  stripe_product_id: string | null;
  stripe_price_id: string | null;
  payment_link_url: string | null;
  status: 'draft' | 'live' | 'retired';
}

export type ConsentStatus = 'unknown' | 'opted_in' | 'opted_out';
export type LeadStage =
  | 'new'
  | 'contacted'
  | 'engaged'
  | 'qualified'
  | 'checkout_sent'
  | 'won'
  | 'lost';

export interface Lead {
  id: string;
  created_at: string;
  updated_at: string;
  phone: string | null;
  email: string | null;
  name: string | null;
  segment: string | null;
  source: string;
  consent_status: ConsentStatus;
  consent_at: string | null;
  consent_source: string | null;
  opted_out_at: string | null;
  stage: LeadStage;
  score: number;
  attributes: Record<string, unknown>;
}

export type CampaignChannel = 'sms' | 'whatsapp' | 'voice' | 'social';

export interface Campaign {
  id: string;
  created_at: string;
  created_by: string | null;
  gap_id: string | null;
  offer_id: string | null;
  name: string;
  channel: CampaignChannel;
  variant: string;
  hypothesis: string;
  status: 'draft' | 'running' | 'paused' | 'complete';
  metrics: Record<string, unknown>;
}

export interface OutreachMessage {
  id: string;
  created_at: string;
  campaign_id: string | null;
  lead_id: string | null;
  direction: 'outbound' | 'inbound';
  channel: 'sms' | 'whatsapp' | 'voice';
  body: string;
  provider_sid: string | null;
  status: 'queued' | 'sent' | 'delivered' | 'failed' | 'received';
  error: string | null;
}

export interface SocialPost {
  id: string;
  created_at: string;
  campaign_id: string | null;
  created_by: string | null;
  platform: string;
  body: string;
  hashtags: string[];
  status: 'draft' | 'approved' | 'published' | 'rejected';
  scheduled_for: string | null;
  external_id: string | null;
  metrics: Record<string, unknown>;
}

export interface Sale {
  id: string;
  created_at: string;
  lead_id: string | null;
  offer_id: string | null;
  campaign_id: string | null;
  stripe_session_id: string | null;
  stripe_payment_intent: string | null;
  amount_cents: number;
  currency: string;
  status: 'pending' | 'paid' | 'refunded' | 'failed';
}

/** One row of campaign_performance() -- realized outcomes, not self-report. */
export interface CampaignPerformance {
  campaign_id: string;
  campaign_name: string;
  variant: string;
  channel: string;
  messages_sent: number;
  replies: number;
  sales_count: number;
  revenue_cents: number;
}
