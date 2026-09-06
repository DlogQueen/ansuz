-- BMDC (Byte Me Dev Crew): an adaptive, self-replicating sales crew built on
-- Ansuz's memory backend.
--
-- Design notes that matter for anyone reading this later:
--   * The crew's *episodic* memory stays in short_term_memory / long_term_memory
--     (0001) -- this migration only adds the crew's *operational* state: who is
--     on the crew, what gaps they found, who they contacted, what sold.
--   * Everything here is service-role only (RLS on, no policies), same posture
--     as the memory tables. Nothing in this schema is safe for an anon client.
--   * Consent is modelled as a first-class column on leads, not a metadata flag.
--     The outreach path refuses to send to a lead that isn't `opted_in`, so the
--     schema has to make that state unambiguous.

-- ---------------------------------------------------------------------------
-- long_term_memory gains crew-specific categories so BMDC's learnings live in
-- the same retrievable store as everything else instead of a parallel one.
-- ---------------------------------------------------------------------------
alter table long_term_memory drop constraint if exists long_term_memory_category_check;
alter table long_term_memory add constraint long_term_memory_category_check
  check (category in (
    'interaction',
    'built-artifact',
    'self-repair-success',
    'self-repair-failure',
    'market-gap',
    'campaign-result',
    'sales-outcome',
    'crew-spawn',
    'other'
  ));

-- ---------------------------------------------------------------------------
-- crew_agents: the roster. Self-replication is *rows in this table*, not code
-- writing itself to disk -- a spawned agent is a new row with a mandate, a
-- parent, and a generation number, run by the same orchestrator as its parent.
-- `depth`/generation caps are enforced in src/crew/replication.ts.
-- ---------------------------------------------------------------------------
create table if not exists crew_agents (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  retired_at timestamptz,
  codename text not null unique,
  role text not null check (role in ('manager', 'researcher', 'social', 'specialist')),
  generation smallint not null default 0 check (generation >= 0),
  parent_id uuid references crew_agents (id) on delete set null,
  status text not null default 'active' check (status in ('active', 'paused', 'retired')),
  mandate text not null,
  config jsonb not null default '{}'::jsonb,
  -- rolling performance signal the manager uses to decide who to clone,
  -- re-task, or retire. Updated from realized outcomes, not self-assessment.
  fitness real not null default 0,
  runs integer not null default 0
);

create index if not exists idx_crew_agents_role on crew_agents (role);
create index if not exists idx_crew_agents_status on crew_agents (status);

-- ---------------------------------------------------------------------------
-- crew_cycles: one pass of the adapt loop (observe -> decide -> act -> learn).
-- ---------------------------------------------------------------------------
create table if not exists crew_cycles (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  summary text,
  decisions jsonb not null default '[]'::jsonb,
  metrics jsonb not null default '{}'::jsonb
);

create index if not exists idx_crew_cycles_started_at on crew_cycles (started_at desc);

-- ---------------------------------------------------------------------------
-- agent_runs: per-agent audit trail. Every model call an agent makes lands
-- here, success or failure -- this is what makes the crew's behaviour
-- reviewable after the fact rather than a black box.
-- ---------------------------------------------------------------------------
create table if not exists agent_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  agent_id uuid references crew_agents (id) on delete cascade,
  cycle_id uuid references crew_cycles (id) on delete set null,
  kind text not null,
  input jsonb not null default '{}'::jsonb,
  output jsonb not null default '{}'::jsonb,
  success boolean not null default true,
  error text,
  duration_ms integer
);

create index if not exists idx_agent_runs_agent_id on agent_runs (agent_id, created_at desc);
create index if not exists idx_agent_runs_cycle_id on agent_runs (cycle_id);

-- ---------------------------------------------------------------------------
-- market_gaps: what the research agent believes is underserved. `status`
-- tracks the gap from hypothesis to validated//killed by real outcomes.
-- ---------------------------------------------------------------------------
create table if not exists market_gaps (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  discovered_by uuid references crew_agents (id) on delete set null,
  title text not null,
  segment text not null,
  description text not null,
  evidence jsonb not null default '[]'::jsonb,
  confidence real not null default 0.5 check (confidence between 0 and 1),
  status text not null default 'hypothesis'
    check (status in ('hypothesis', 'testing', 'validated', 'killed')),
  metrics jsonb not null default '{}'::jsonb
);

create index if not exists idx_market_gaps_status on market_gaps (status);

-- ---------------------------------------------------------------------------
-- offers: the sellable thing aimed at a gap. stripe_* columns are populated
-- once src/integrations/stripe.ts has created the product/price/payment link.
-- ---------------------------------------------------------------------------
create table if not exists offers (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  gap_id uuid references market_gaps (id) on delete set null,
  name text not null,
  pitch text not null,
  price_cents integer not null check (price_cents > 0),
  currency text not null default 'usd',
  stripe_product_id text,
  stripe_price_id text,
  payment_link_url text,
  status text not null default 'draft' check (status in ('draft', 'live', 'retired'))
);

create index if not exists idx_offers_status on offers (status);

-- ---------------------------------------------------------------------------
-- leads: people. consent_status gates every outbound message -- see
-- src/crew/pipeline.ts. `opted_out_at` is permanent: nothing in the crew is
-- allowed to flip a lead back to opted_in on its own.
-- ---------------------------------------------------------------------------
create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  phone text unique,
  email text,
  name text,
  segment text,
  source text not null default 'unknown',
  consent_status text not null default 'unknown'
    check (consent_status in ('unknown', 'opted_in', 'opted_out')),
  consent_at timestamptz,
  consent_source text,
  opted_out_at timestamptz,
  stage text not null default 'new'
    check (stage in ('new', 'contacted', 'engaged', 'qualified', 'checkout_sent', 'won', 'lost')),
  score real not null default 0,
  attributes jsonb not null default '{}'::jsonb
);

create index if not exists idx_leads_stage on leads (stage);
create index if not exists idx_leads_consent_status on leads (consent_status);
create index if not exists idx_leads_segment on leads (segment);

-- ---------------------------------------------------------------------------
-- campaigns: one hypothesis, one channel, one variant. The crew adapts by
-- spawning variants and comparing realized revenue, so `variant` and
-- `hypothesis` are required reading for the learning step.
-- ---------------------------------------------------------------------------
create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by uuid references crew_agents (id) on delete set null,
  gap_id uuid references market_gaps (id) on delete set null,
  offer_id uuid references offers (id) on delete set null,
  name text not null,
  channel text not null check (channel in ('sms', 'whatsapp', 'voice', 'social')),
  variant text not null default 'a',
  hypothesis text not null,
  status text not null default 'draft' check (status in ('draft', 'running', 'paused', 'complete')),
  metrics jsonb not null default '{}'::jsonb
);

create index if not exists idx_campaigns_status on campaigns (status);

-- ---------------------------------------------------------------------------
-- outreach_messages: every inbound and outbound message, both directions, with
-- the provider's id so replies can be threaded back to the campaign that
-- caused them.
-- ---------------------------------------------------------------------------
create table if not exists outreach_messages (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  campaign_id uuid references campaigns (id) on delete set null,
  lead_id uuid references leads (id) on delete cascade,
  direction text not null check (direction in ('outbound', 'inbound')),
  channel text not null check (channel in ('sms', 'whatsapp', 'voice')),
  body text not null,
  provider_sid text,
  status text not null default 'queued'
    check (status in ('queued', 'sent', 'delivered', 'failed', 'received')),
  error text
);

create index if not exists idx_outreach_messages_lead_id on outreach_messages (lead_id, created_at desc);
create index if not exists idx_outreach_messages_campaign_id on outreach_messages (campaign_id);
create unique index if not exists idx_outreach_messages_provider_sid
  on outreach_messages (provider_sid) where provider_sid is not null;

-- ---------------------------------------------------------------------------
-- social_posts: the social agent's output. Drafted and stored here rather than
-- auto-published -- `status` starts at 'draft' and a human (or an explicitly
-- configured publisher) moves it forward.
-- ---------------------------------------------------------------------------
create table if not exists social_posts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  campaign_id uuid references campaigns (id) on delete set null,
  created_by uuid references crew_agents (id) on delete set null,
  platform text not null,
  body text not null,
  hashtags text[] not null default '{}',
  status text not null default 'draft' check (status in ('draft', 'approved', 'published', 'rejected')),
  scheduled_for timestamptz,
  external_id text,
  metrics jsonb not null default '{}'::jsonb
);

create index if not exists idx_social_posts_status on social_posts (status);

-- ---------------------------------------------------------------------------
-- sales: realized revenue, keyed on the Stripe object so webhook replays are
-- idempotent. This table is the crew's ground truth -- fitness, gap validation
-- and campaign winners are all computed from here, never from self-report.
-- ---------------------------------------------------------------------------
create table if not exists sales (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  lead_id uuid references leads (id) on delete set null,
  offer_id uuid references offers (id) on delete set null,
  campaign_id uuid references campaigns (id) on delete set null,
  stripe_session_id text unique,
  stripe_payment_intent text,
  amount_cents integer not null default 0,
  currency text not null default 'usd',
  status text not null default 'pending'
    check (status in ('pending', 'paid', 'refunded', 'failed'))
);

create index if not exists idx_sales_status on sales (status);
create index if not exists idx_sales_campaign_id on sales (campaign_id);

-- ---------------------------------------------------------------------------
-- Deny-by-default, matching the memory tables: the anon key gets nothing.
-- ---------------------------------------------------------------------------
alter table crew_agents enable row level security;
alter table crew_cycles enable row level security;
alter table agent_runs enable row level security;
alter table market_gaps enable row level security;
alter table offers enable row level security;
alter table leads enable row level security;
alter table campaigns enable row level security;
alter table outreach_messages enable row level security;
alter table social_posts enable row level security;
alter table sales enable row level security;

-- ---------------------------------------------------------------------------
-- Realized revenue per campaign -- the input to campaign fitness. A left join
-- so a campaign that sent messages and sold nothing shows up as a zero row
-- rather than vanishing (a losing variant is exactly what the crew needs to
-- see in order to kill it).
-- ---------------------------------------------------------------------------
create or replace function campaign_performance()
returns table (
  campaign_id uuid,
  campaign_name text,
  variant text,
  channel text,
  messages_sent bigint,
  replies bigint,
  sales_count bigint,
  revenue_cents bigint
)
language sql
stable
as $$
  select
    c.id,
    c.name,
    c.variant,
    c.channel,
    count(distinct om.id) filter (where om.direction = 'outbound' and om.status <> 'failed'),
    count(distinct om.id) filter (where om.direction = 'inbound'),
    count(distinct s.id) filter (where s.status = 'paid'),
    coalesce(sum(s.amount_cents) filter (where s.status = 'paid'), 0)
  from campaigns c
  left join outreach_messages om on om.campaign_id = c.id
  left join sales s on s.campaign_id = c.id
  group by c.id, c.name, c.variant, c.channel;
$$;
