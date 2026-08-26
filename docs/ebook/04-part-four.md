# PART IV — THE LOOP

---

## Chapter 12: Observe, Decide, Act, Learn

One invocation of `runCycle()` is one turn of the crew's life. Four phases:

```
observe   buildSituationReport() — gaps, campaigns, roster, revenue.
          All measured; no agent's self-assessment reaches the manager.
   ↓
decide    BMDC-CHIEF allocates work, kills losing campaigns and dead gaps,
          optionally requests a specialist.
   ↓
act       BMDC-PROSPECT finds gaps + prices an offer (Stripe objects created),
          BMDC-SIGNAL writes variants, the pipeline sends to opted-in leads,
          one campaign per variant so they compete on revenue.
   ↓
learn     Outcomes → long_term_memory (retrievable next cycle) and → agent
          fitness. Underperforming specialists retire.
```

### The most important structural choice: no `while (true)`

`runCycle()` runs **exactly one cycle** and returns. It does not loop.

Scheduling happens outside — an interval in the server, or a human typing
`npm run bmdc -- cycle`. This looks like a small thing. It isn't.

A `while (true)` loop inside the process means a broken cycle repeats immediately,
forever, at whatever rate the API will accept. A malformed prompt that produces
garbage produces garbage a thousand times before anyone notices. A bug that sends
messages sends them until the account is suspended.

One cycle per invocation means a bad cycle *stops*. The next one only happens if
something outside deliberately triggers it. When you're building autonomous systems
that spend money and contact humans, "fails stopped" beats "fails fast" every time.

The same reasoning drives the default:

```typescript
// BMDC's adapt loop, off unless BMDC_CYCLE_MINUTES is set. Default-off on
// purpose: a cycle spends model credits and sends real messages to real
// people, so running it has to be something you turned on, not something that
// started happening because you booted the server.
const cycleMinutes = Number(process.env.BMDC_CYCLE_MINUTES ?? 0);
if (Number.isFinite(cycleMinutes) && cycleMinutes > 0) {
  setInterval(() => { runCycle()/* ... */ }, cycleMinutes * 60 * 1000);
}
```

The automation is off by default. Booting the server does not start texting people.
Someone has to make a decision, in a config file, for that to begin.

### Research is conditional

```typescript
let gaps = await listMarketGaps(['hypothesis', 'testing']);
if (gaps.length === 0) {
  const found = await findMarketGaps({ agent: prospect, cycleId: cycle.id, /* ... */ });
  gaps = found;
}
```

Research only runs when there's nothing testable in flight.

This prevents the most common autonomous-system pathology: infinite planning. Left
unconstrained, a system with a research agent will research every cycle, because
research always produces output and output feels like progress. Meanwhile nothing
is ever tested against a real market.

The rule here is: **if you have an untested hypothesis, test it before generating
another one.**

### One campaign per variant

```typescript
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
  // ...send this variant to leads
}
```

Two copy variants become two campaign rows. Because `campaign_performance()`
aggregates per campaign, the variants compete on realized revenue automatically.
No separate A/B infrastructure — the schema does it.

And note what the copywriter is required to produce:

> You write variants, not one perfect message — the crew learns by comparing them
> against realized sales, so make variants that differ on something you could
> actually learn from (the angle, the offer framing, the call to action), not on
> wording noise.

Two paraphrases of the same pitch teach nothing. Two genuinely different angles
teach which angle works. The mandate says so explicitly, and the schema asks for a
`hypothesis` field per variant — *"what this variant is testing, stated so the sales
numbers can refute it."*

Refutable. That word is doing work. A hypothesis that can't be proven wrong by the
numbers isn't a hypothesis.

### The learn phase scores honestly

```typescript
// A cycle that moved no money isn't a failure, but it isn't a win either --
// scoring it at zero is what lets fitness decay for agents that stop
// producing rather than plateauing on old results.
await recordAgentOutcome(manager.id, result.messagesSent > 0 ? 0.25 : 0);
```

A cycle that did work but made no sales scores 0.25. A cycle that did nothing
scores 0. Neither scores well.

This is the charter's first rule expressed as arithmetic. Activity is worth a
little. Revenue is worth a lot. And because fitness decays exponentially, a long
run of activity-without-revenue drags fitness down over time rather than holding it
flat.

### Errors accumulate; they don't abort

```typescript
try {
  const found = await findMarketGaps({ /* ... */ });
  result.gapsFound = found.length;
  gaps = found;
} catch (error) {
  errors.push(`research: ${describe(error)}`);
}
```

Each phase catches its own failures into an array and keeps going. Research failing
doesn't stop the crew from running an existing campaign. Social drafting failing
doesn't stop outreach.

At the end, the cycle is recorded with whatever happened:

```typescript
await finishCycle({
  cycleId: cycle.id,
  status: errors.length > 0 ? 'failed' : 'succeeded',
  summary: plan.assessment,
  decisions: plan.decisions,
  metrics: { gapsFound, campaignsLaunched, messagesSent, socialDrafts, spawned, retired, errors },
});
```

The cycle is marked failed *and* the partial work is preserved *and* the specific
errors are stored. You can query `crew_cycles` and see exactly which phase broke on
which day.

---

## Chapter 13: Replication, and the Art of Refusing

This is the chapter the title of the book is really about.

```typescript
/** Total active agents, founders included. */
export const MAX_ACTIVE_AGENTS = 8;
/** How far a lineage can get from a founding agent. */
export const MAX_GENERATION = 3;
/** New specialists per cycle -- growth stays gradual enough to observe. */
export const MAX_SPAWNS_PER_CYCLE = 1;
```

Three numbers. They are the entire safety story of BMDC's self-replication, and
they are enforced in code, not in the prompt.

Say that again, because it's the thesis: **the limits on self-replication are not
in the prompt.**

The prompt *mentions* them, so the manager can plan sensibly. But if the manager
ignores them entirely — if it returns a spawn request at generation 9 with a roster
of 40 — the code refuses. It doesn't matter what the model decided.

```typescript
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
  // ...only now does it create anything
}
```

### Refusals are returned, not thrown

Look at the return type: `{ spawned: CrewAgent | null, refused: string | null }`.

Hitting a cap isn't an error. It's a normal, expected outcome that the manager needs
to know about so it can plan differently next cycle. Throwing would abort the
cycle; returning a refusal message means the cycle completes and the manager learns
that the roster is full.

There's a general design point here. **When a limit is hit, the question is whether
the caller needs to adapt or whether something is broken.** Caps are the first;
they should return information. A missing database is the second; that should throw.

### Names get normalized

```typescript
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
```

The manager suggests a name. The code decides what it actually is. Uppercase,
alphanumerics and hyphens only, collapsed runs, trimmed edges, capped at 32
characters, prefixed with `BMDC-` if it isn't already, and a fallback if the model
returned something that normalizes to nothing.

Small function. It means no agent name can contain a quote, a newline, a
thousand-character string, or anything else that would make life interesting
downstream.

### Founders are never auto-retired

```typescript
for (const agent of active) {
  if (agent.role !== 'specialist') continue;
  if (agent.runs < minRuns) continue;
  if (agent.fitness >= fitnessFloor) continue;

  await setAgentStatus(agent.id, 'retired');
  // ...
}
```

`if (agent.role !== 'specialist') continue;` — the first line of the retirement
loop, and the most important one.

Consider a crew going through a rough patch. Nothing is selling. Fitness drops
across the board. Without that guard, the retirement pass could retire the manager.

Now there's no agent that can plan. No agent that can decide to change strategy. The
crew is a set of rows in a database that will never do anything again, and recovery
requires a human to notice and intervene.

**A system that can retire its own recovery mechanism cannot recover.** Founders
are structural, not performance-managed.

There's also a threshold before any retirement happens: `minRuns = 5`. An agent
needs a track record before it gets judged. One bad cycle isn't a verdict.

### Every spawn is remembered

```typescript
await rememberLearning({
  summary: `${request.parent.codename} spawned specialist ${codename} (generation ${generation}): ${request.mandate}`,
  category: 'crew-spawn',
  importance: 4,
  metadata: { agentId: spawned.id, parentId: request.parent.id, generation },
});
```

And every retirement:

```typescript
await rememberLearning({
  summary: `Retired specialist ${agent.codename} after ${agent.runs} runs at fitness ${agent.fitness.toFixed(3)} — its mandate did not produce sales.`,
  category: 'crew-spawn',
  importance: 3,
  metadata: { agentId: agent.id, fitness: agent.fitness, runs: agent.runs },
});
```

Both go into long-term memory, which means both get retrieved later. When the
manager considers spawning a similar specialist six weeks from now, the memory of
the last one that didn't work is available to the retrieval that shapes its prompt.

The crew learns from its own organizational history, not just its campaign history.

### The Takeaway

**Put your limits in the code path, and make hitting one a normal outcome.**

Anything that must not exceed a bound needs that bound enforced by something that
can't be reasoned with. State the bound in the prompt too — that's how the model
plans well — but never let the prompt be the only thing standing there.

And when a system is allowed to grow itself, decide in advance what it must never
be able to remove. In BMDC, that's the three founders and the charter. Everything
else is negotiable.
