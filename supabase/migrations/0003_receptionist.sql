-- BMDC Receptionist: the manager/social agents split out as a standalone
-- 24/7 call answering + appointment booking product.
--
-- Two things ship here, and the first serves both products:
--
--   * business_profiles -- the per-business configuration that makes BMDC
--     sellable to someone other than us. The crew reads it to know whose
--     voice to write in; the receptionist reads it to know whose calls it is
--     answering. One table, both SKUs.
--   * The receptionist's own tables: availability, appointments, call sessions.
--
-- The appointments table carries an exclusion constraint rather than an
-- application-level conflict check. Double-booking is the one failure a
-- receptionist absolutely cannot have, and "we check before inserting" loses
-- to two calls arriving in the same second. The database refuses instead.

create extension if not exists btree_gist;

-- ---------------------------------------------------------------------------
-- business_profiles: who the crew/receptionist is working for.
--
-- `voice` and `never_say` are injected into every agent prompt for this
-- business. `escalate_to_human` is a hard list the receptionist refuses to
-- handle -- it transfers instead, and unlike the prompt guidance it is checked
-- in code before the model is consulted.
-- ---------------------------------------------------------------------------
create table if not exists business_profiles (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  slug text not null unique,
  name text not null,
  industry text,
  -- The phone number this business's calls arrive on. One number, one
  -- business -- that's how an inbound call is routed to the right profile.
  phone_number text unique,
  timezone text not null default 'America/New_York',
  -- How this business sounds. Prose, injected verbatim into agent prompts.
  voice text not null default 'Warm, direct, and brief. No corporate filler.',
  -- Things this business never claims or discusses. Also prose, also injected.
  never_say text not null default '',
  greeting text not null default 'Thanks for calling. How can I help you today?',
  -- Topics that must go to a person. Checked in code, not just prompted.
  escalate_to_human text[] not null default
    '{pricing negotiation,complaint,legal,medical advice,refund}',
  -- Where an escalated call is forwarded. Null = take a message instead.
  transfer_number text,
  appointment_minutes smallint not null default 30 check (appointment_minutes between 5 and 480),
  status text not null default 'active' check (status in ('active', 'paused')),
  config jsonb not null default '{}'::jsonb
);

create index if not exists idx_business_profiles_status on business_profiles (status);

-- ---------------------------------------------------------------------------
-- availability_rules: recurring weekly opening hours, per business.
-- Slots are computed from these rather than stored, so a business changing
-- its hours doesn't require regenerating a calendar.
-- ---------------------------------------------------------------------------
create table if not exists availability_rules (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references business_profiles (id) on delete cascade,
  -- 0 = Sunday, matching JS getDay()
  weekday smallint not null check (weekday between 0 and 6),
  start_minute smallint not null check (start_minute between 0 and 1439),
  end_minute smallint not null check (end_minute between 1 and 1440),
  constraint availability_rules_order check (end_minute > start_minute)
);

create index if not exists idx_availability_rules_business on availability_rules (business_id, weekday);

-- ---------------------------------------------------------------------------
-- availability_blocks: one-off closures (holidays, someone's day off).
-- Subtracted from the recurring rules when computing open slots.
-- ---------------------------------------------------------------------------
create table if not exists availability_blocks (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references business_profiles (id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text,
  constraint availability_blocks_order check (ends_at > starts_at)
);

create index if not exists idx_availability_blocks_business on availability_blocks (business_id, starts_at);

-- ---------------------------------------------------------------------------
-- appointments: the product's actual output.
--
-- The exclusion constraint is the important line. Two callers asking for the
-- same 2pm slot at the same moment is not a hypothetical -- it is exactly what
-- happens when a business gets busy, which is when they most need this to
-- work. An application-level "is it free?" check has a race between the read
-- and the write; this does not. Cancelled appointments are excluded from the
-- constraint so a cancelled slot immediately becomes bookable again.
-- ---------------------------------------------------------------------------
create table if not exists appointments (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  business_id uuid not null references business_profiles (id) on delete cascade,
  lead_id uuid references leads (id) on delete set null,
  caller_phone text,
  caller_name text,
  purpose text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'booked'
    check (status in ('booked', 'confirmed', 'cancelled', 'completed', 'no_show')),
  booked_by text not null default 'receptionist',
  notes text,
  constraint appointments_order check (ends_at > starts_at),
  constraint appointments_no_overlap exclude using gist (
    business_id with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (status <> 'cancelled')
);

create index if not exists idx_appointments_business_start on appointments (business_id, starts_at);
create index if not exists idx_appointments_status on appointments (status);

-- ---------------------------------------------------------------------------
-- call_sessions: one row per inbound call, with the full turn-by-turn
-- transcript. This is the receptionist's audit trail -- the equivalent of
-- agent_runs for the crew. A business that wants to know what its AI said to
-- a customer reads this.
-- ---------------------------------------------------------------------------
create table if not exists call_sessions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  ended_at timestamptz,
  business_id uuid references business_profiles (id) on delete set null,
  call_sid text unique,
  from_number text,
  to_number text,
  -- Appended to on every turn: [{role, text, at}]
  transcript jsonb not null default '[]'::jsonb,
  outcome text not null default 'in_progress'
    check (outcome in ('in_progress', 'booked', 'message_taken', 'escalated', 'answered', 'abandoned')),
  appointment_id uuid references appointments (id) on delete set null,
  escalation_reason text,
  turns smallint not null default 0
);

create index if not exists idx_call_sessions_business on call_sessions (business_id, created_at desc);
create index if not exists idx_call_sessions_outcome on call_sessions (outcome);

-- ---------------------------------------------------------------------------
-- messages_taken: when the receptionist can't book or answer, it takes a
-- message. Separate from call_sessions so the business has one clean list of
-- things needing a human callback.
-- ---------------------------------------------------------------------------
create table if not exists messages_taken (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  business_id uuid not null references business_profiles (id) on delete cascade,
  call_session_id uuid references call_sessions (id) on delete set null,
  caller_phone text,
  caller_name text,
  message text not null,
  urgency text not null default 'normal' check (urgency in ('normal', 'urgent')),
  handled boolean not null default false
);

create index if not exists idx_messages_taken_unhandled on messages_taken (business_id, handled, created_at desc);

-- ---------------------------------------------------------------------------
-- The crew's agents gain a 'receptionist' role so the receptionist runs
-- through the same think()/agent_runs machinery as everything else rather
-- than getting its own parallel path.
-- ---------------------------------------------------------------------------
alter table crew_agents drop constraint if exists crew_agents_role_check;
alter table crew_agents add constraint crew_agents_role_check
  check (role in ('manager', 'researcher', 'social', 'specialist', 'receptionist'));

-- Business scoping for the crew tables, so one deployment can serve more than
-- one customer. Nullable: existing single-tenant rows stay valid.
alter table campaigns add column if not exists business_id uuid references business_profiles (id) on delete cascade;
alter table leads add column if not exists business_id uuid references business_profiles (id) on delete cascade;
alter table crew_agents add column if not exists business_id uuid references business_profiles (id) on delete cascade;

create index if not exists idx_leads_business on leads (business_id);
create index if not exists idx_campaigns_business on campaigns (business_id);
create index if not exists idx_crew_agents_business on crew_agents (business_id);

-- ---------------------------------------------------------------------------
-- Same deny-by-default posture as everything else.
-- ---------------------------------------------------------------------------
alter table business_profiles enable row level security;
alter table availability_rules enable row level security;
alter table availability_blocks enable row level security;
alter table appointments enable row level security;
alter table call_sessions enable row level security;
alter table messages_taken enable row level security;

-- ---------------------------------------------------------------------------
-- Booked ranges for a business over a window. Used by slot computation --
-- returns only what's taken, so the caller subtracts rather than scanning.
-- ---------------------------------------------------------------------------
create or replace function booked_ranges(
  p_business_id uuid,
  p_from timestamptz,
  p_to timestamptz
) returns table (starts_at timestamptz, ends_at timestamptz)
language sql
stable
as $$
  select a.starts_at, a.ends_at
  from appointments a
  where a.business_id = p_business_id
    and a.status <> 'cancelled'
    and a.starts_at < p_to
    and a.ends_at > p_from
  union all
  select b.starts_at, b.ends_at
  from availability_blocks b
  where b.business_id = p_business_id
    and b.starts_at < p_to
    and b.ends_at > p_from
  order by 1;
$$;

-- ---------------------------------------------------------------------------
-- Receptionist performance: what a business actually bought. Call volume,
-- how many became appointments, how many needed a human.
-- ---------------------------------------------------------------------------
create or replace function receptionist_performance(p_business_id uuid)
returns table (
  calls bigint,
  booked bigint,
  messages_taken bigint,
  escalated bigint,
  abandoned bigint
)
language sql
stable
as $$
  select
    count(*),
    count(*) filter (where outcome = 'booked'),
    count(*) filter (where outcome = 'message_taken'),
    count(*) filter (where outcome = 'escalated'),
    count(*) filter (where outcome = 'abandoned')
  from call_sessions
  where business_id = p_business_id;
$$;
