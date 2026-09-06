# PART II — THE SCHEMA IS THE ETHICS

---

## Chapter 4: Why the Database Chapter Comes This Early

Most books about AI systems put the database in an appendix, if they mention it at
all. The interesting part is the agents, right? The prompts, the reasoning, the
emergent behavior.

I'm putting it in Part II because in this system, **the schema is where the ethics
live.**

Not the prompts. Not the charter. The schema.

Here's what I mean. There's a rule that BMDC must never message someone who opted
out. You can write that rule three ways:

1. **In the prompt:** "Never message anyone who sent STOP." A preference. A
   sufficiently confused model ignores it.

2. **In application code:** `if (lead.optedOut) return;` Better. But it's one
   `if` statement in one function, and the next person to add a sending path
   doesn't know it exists.

3. **In the schema:** a `consent_status` column with a check constraint, a unique
   index on phone, and a function that structurally refuses to move a lead out of
   `opted_out`. Now the database itself won't hold the invalid state.

The third is the only one that survives you. Prompts get rewritten. Application
code gets refactored by someone in a hurry. The schema is the thing that's still
there in eighteen months telling everyone what's allowed.

So: ten tables. Let's walk them.

---

## Chapter 5: The Roster Table, or, Replication as Rows

```sql
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
  fitness real not null default 0,
  runs integer not null default 0
);
```

This is the self-replication table. Every agent that exists is a row here. Look at
what that buys us.

**`parent_id` references the same table.** A self-referencing foreign key, which
makes the roster a tree. You can walk any agent's ancestry with a recursive query.
When something goes wrong with a fourth-generation specialist, you can trace
exactly which decision created it and why.

**`generation` is a plain integer with a `>= 0` check.** The lineage depth limit is
enforced in application code (Chapter 12), but the column makes depth *visible* in
every query. You never have to compute it by walking the tree.

**`codename` is unique.** This is load-bearing. The manager proposes codenames for
new specialists, and models are not creative about names — ask one to name a
sales-analytics specialist twice and you'll get "BMDC-ANALYTICS" twice. The unique
constraint turns a duplicate-name collision from a confusing double-agent bug into
a clean rejection the spawn logic handles.

**`status` and `retired_at` rather than deletion.** A retired agent stays in the
table. Its `agent_runs` history stays intact. You can look back at a specialist
that didn't work out and read exactly what it was asked to do and what it produced.
Deleting rows to represent "no longer active" destroys the record of why.

**`fitness` and `runs` — the two most important columns.** These are how the system
knows which agents are earning. We'll cover the math in Chapter 11, but note the
comment in the migration:

```sql
  -- rolling performance signal the manager uses to decide who to clone,
  -- re-task, or retire. Updated from realized outcomes, not self-assessment.
  fitness real not null default 0,
```

*Not self-assessment.* No agent writes its own fitness. It's updated by the sales
pipeline when money moves.

---

## Chapter 6: Leads, Consent, and the Column That Can't Go Backwards

```sql
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
    check (stage in ('new','contacted','engaged','qualified','checkout_sent','won','lost')),
  score real not null default 0,
  attributes jsonb not null default '{}'::jsonb
);
```

This is the most carefully designed table in the system. Every choice here is about
one thing: making it structurally difficult to message someone who didn't ask to be
messaged.

### Consent is a column, not a flag in a JSON blob

There's an `attributes jsonb` column right there. It would have been easy to put
consent in it — `attributes.opted_in = true`. Flexible, no migration needed.

That would have been a serious mistake, and here's the specific reason: **you can't
put a check constraint on a JSON key.** You can't index it meaningfully. You can't
write a query that the database will guarantee is correct. `attributes.opted_in`
can be `true`, `"true"`, `"yes"`, `1`, or missing entirely, and the database is
fine with all of it.

`consent_status` is one of exactly three values, and the database rejects anything
else. When outreach code filters on `consent_status = 'opted_in'`, that comparison
is meaningful, because the column can't hold a fourth thing.

### Three states, not two

The naive model is a boolean: opted in, or not.

The real model has three states, and the third is the important one:

- **`unknown`** — we have this person's number, but nobody has confirmed they want
  messages. This is the default, and it is *not contactable*.
- **`opted_in`** — someone affirmatively agreed.
- **`opted_out`** — they said stop.

The gap between `unknown` and `opted_out` is where the ethics live. Both are
"don't message," but they mean different things: `unknown` might become `opted_in`
if the person signs up. `opted_out` never becomes anything else.

A boolean collapses these, and the collapse always fails the same direction —
toward treating "we haven't asked" as "go ahead."

### Consent has provenance

```sql
  consent_at timestamptz,
  consent_source text,
  opted_out_at timestamptz,
```

Not just *whether*, but *when* and *how*. When a lead is added from the CLI, the
source is recorded as `cli_manual` — which is a claim that a human actually
collected that opt-in. When someone texts the number first, it's `inbound_sms`.

If you're ever asked to demonstrate that you had permission — by a carrier, a
platform, or a regulator — "the database says true" is not an answer. "Opted in on
this date via this mechanism" is.

### The one-way door

`opted_out_at` is separate from `consent_at`, and the reason shows up in
application code:

```typescript
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

  if ((data as { consent_status: ConsentStatus }).consent_status === 'opted_out'
      && params.status !== 'opted_out') {
    throw new Error(
      `Lead ${params.leadId} has opted out; consent cannot be restored programmatically.`
    );
  }
  // ...proceed with the update
}
```

**Opting out is terminal.** Not "terminal unless the agent has a good reason."
Terminal. The function that sets consent refuses the transition and throws.

Re-subscribing someone requires a human running SQL against the database directly.
That friction is the point. It means no agent, no bug, no clever prompt, and no
future refactor can walk a STOP backwards. The only path back is one that requires
a person to deliberately act.

This is three lines of defensive code that will, in the entire life of the system,
probably never fire. That's what correct looks like.

### `stage` is a funnel, and funnels have exits

```sql
  stage text not null default 'new'
    check (stage in ('new','contacted','engaged','qualified','checkout_sent','won','lost')),
```

Seven stages. Two of them — `won` and `lost` — are terminal, and the query that
finds contactable leads excludes both:

```typescript
.not('stage', 'in', '("won","lost")')
```

Someone who bought doesn't get pitched the same thing again. Someone who said no
isn't pursued. Both of those are obvious in principle and both are things sales
automation gets wrong constantly, because the system is optimized for volume and
nobody wrote the exclusion.

---

## Chapter 7: The Ledger — Making Revenue Un-Arguable

```sql
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
```

This is the scoreboard. Everything the crew believes about its own performance is
computed from this table.

### `stripe_session_id text unique` — four words doing enormous work

Stripe retries webhooks. This isn't an edge case; it's documented, expected
behavior. If your endpoint is slow, or returns a 500, or the network hiccups,
Stripe sends the event again. Sometimes several times.

Without the unique constraint, each retry books another sale. Revenue inflates.
Campaign fitness inflates. The manager scales a campaign that isn't actually
working, because the numbers say it's working, because the same $79 got counted
four times.

With the unique constraint plus an upsert:

```typescript
const { data, error } = await client
  .from('sales')
  .upsert(
    { /* ...fields... */ },
    { onConflict: 'stripe_session_id' }
  )
```

...a retry updates the existing row instead of creating a new one. The operation
becomes idempotent. Stripe can send the same event a hundred times and the revenue
figure doesn't move.

**This is the single highest-leverage constraint in the entire schema.** It's four
words in a column definition, and without it every number the system reasons about
is wrong in a direction that causes it to spend more.

### Three foreign keys, all nullable

`lead_id`, `offer_id`, `campaign_id` — all `on delete set null`.

The nullability is deliberate. A sale might arrive with incomplete attribution — a
payment link shared by someone we never tracked, a checkout completed after a
campaign was deleted. When that happens, the sale still gets recorded. It just has
less attribution.

The alternative — requiring full attribution — means an unattributable sale either
fails to record or invents an attribution. Both are worse than a real row with
null columns. **Never lose the money to protect the metadata.**

### `amount_cents integer`

Integers. Cents. Not floats, not dollars.

If you've been near financial code you already know why. If you haven't: `0.1 + 0.2`
in floating point equals `0.30000000000000004`. Sum enough float dollar amounts and
your total drifts from reality. Stripe reports in the smallest currency unit for
exactly this reason, and the schema matches it.

---

## Chapter 8: The Function That Makes the System Adaptive

Everything so far has been storage. This is the piece that turns stored facts into
a signal the crew can act on.

```sql
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
```

One query, and it's the difference between a system that adapts and one that just
runs.

### `left join`, not `join`

This is the most important word in the function.

An inner join returns only campaigns that have both messages and sales. Which means
**a campaign that sent 200 messages and sold nothing would not appear in the
results at all.**

Think about what that does. The manager asks "how are my campaigns doing?" and gets
back only the ones that made money. The failures are invisible. It has no way to
know there's something to kill, because from where it sits, the losing campaign
doesn't exist.

The left join makes that campaign show up as a row with `sales_count: 0` and
`revenue_cents: 0`. Which is exactly the information needed to stop it.

**The system's ability to recognize failure depends on one word in one SQL query.**
I want that to sit with you, because it generalizes: adaptive systems fail far more
often from not seeing the failure than from not knowing what to do about it.

### `count(distinct ...)` and why the distinct matters

We're joining two tables to one. A campaign with 50 messages and 3 sales produces
150 rows in the join. A naive `count(om.id)` would report 150 messages.

`count(distinct om.id)` counts unique messages regardless of how many times the
join duplicated the row. Standard fan-out handling, and the kind of thing that
silently triples your metrics if you skip it.

### `filter (where ...)` instead of subqueries

Postgres's `filter` clause applies a condition to a single aggregate. It lets us
compute four different aggregates with four different conditions in one pass over
the joined data.

The alternative is four correlated subqueries, which is four extra scans and a
query nobody wants to read.

Note the specific conditions:

- `om.direction = 'outbound' and om.status <> 'failed'` — sent messages, excluding
  ones that errored. A message Twilio rejected wasn't sent, and counting it would
  make a broken campaign look like a campaign with a terrible response rate.
- `s.status = 'paid'` — pending checkouts aren't revenue. Someone who clicked
  through and abandoned isn't a sale.

### `coalesce(sum(...), 0)`

`sum()` over zero rows returns `NULL`, not `0`. Without the coalesce, a campaign
with no sales reports `null` revenue, which propagates into the report, which the
manager then has to reason about. `coalesce` turns it into a `0`, which is what it
means.

### What this looks like to the manager

```
- 4f2a... "Deposit Link — indie tattoo artists" (variant urgency, sms):
  180 sent, 22 replies, 0 sales, $0.00
- 7b91... "Deposit Link — indie tattoo artists" (variant proof, sms):
  180 sent, 9 replies, 4 sales, $316.00
```

The first variant is more engaging. It got more than twice the replies. Every
engagement metric says it's the winner.

It made no money. The second one did.

A system that optimizes for replies scales the wrong variant. A system that
optimizes for revenue kills it. That's the entire argument for why this function
returns `revenue_cents` and why the charter's first rule is what it is.

### The Takeaway

**Design your metrics query before your agent logic.**

The shape of what your system can see determines the shape of what it can do. If
your reporting query hides failures — through an inner join, a filter, a default
that turns zero into null — no amount of prompt engineering downstream will make
the agent notice them.

Write the query that shows you the losers. Then build the agent that reads it.
