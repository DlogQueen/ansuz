# PART III — HOW AN AGENT THINKS

---

## Chapter 9: One Function, Every Agent

Here's a structural decision that surprises people: **BMDC has no agent framework
and no per-agent code.**

There's no `ManagerAgent` class. No `ResearcherAgent` inheriting from `BaseAgent`.
No message bus, no orchestration DSL, no LangChain, no CrewAI.

There is one function, called `think()`, and every agent in the system — the three
founders and every specialist they'll ever spawn — goes through it.

```typescript
export interface ThinkParams<T> {
  agent: CrewAgent;
  cycleId: string | null;
  /** Short label for the audit trail, e.g. 'find-gaps'. */
  kind: string;
  /** What this agent is being asked to do right now, plus the facts to do it with. */
  task: string;
  /** Literal shape the model must return, embedded in the prompt. */
  schema: string;
  /** Text used to pull relevant long-term memories. Defaults to the task. */
  memoryQuery?: string;
  /** Validates + narrows the parsed JSON. Throwing here fails the run. */
  parse: (value: unknown) => T;
}
```

Agents differ by **mandate** (text in a database row) and **schema** (the JSON shape
they must return). That's the entire difference. There is no third axis.

### Why not a framework?

Agent frameworks solve message routing, agent lifecycle, and tool dispatch.

BMDC needs none of those. Routing is a `for` loop in the orchestrator. Lifecycle is
a `status` column. Tool dispatch doesn't exist — agents don't call tools, they
return structured decisions that ordinary functions act on.

Adopting a framework would mean inheriting abstractions for problems we don't have,
plus a dependency that has opinions about the parts we do care about. The whole
`think()` function is under a hundred lines. You can read it in one sitting and
know exactly what happens when an agent runs. That's worth more than any
convenience a framework would provide here.

### What happens in one call

```typescript
export async function think<T>(params: ThinkParams<T>): Promise<T> {
  const startedAt = Date.now();
  const memories = await recallForAgent(params.memoryQuery ?? params.task);

  const memoryBlock =
    memories.length > 0
      ? `\n\nWhat the crew has already learned that bears on this:\n${memories
          .map((memory) => `- [${memory.category}] ${memory.summary}`)
          .join('\n')}`
      : '\n\nThe crew has no prior learnings relevant to this yet. Say so rather than inventing history.';

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `${CREW_CHARTER}

You are ${params.agent.codename}, the crew's ${params.agent.role}.

${params.agent.mandate}${memoryBlock}

Reply with ONLY a JSON object of exactly this shape:
${params.schema}`,
    },
    { role: 'user', content: params.task },
  ];

  try {
    const raw = await chatCompletion(messages);
    const parsed = params.parse(extractJson(raw));
    await recordRun({ /* success */ });
    return parsed;
  } catch (error) {
    await recordRun({ /* failure, with the error message */ });
    throw error;
  }
}
```

Five steps: recall relevant memory, assemble the prompt, call the model, parse and
validate, record the attempt.

Three details worth pulling out.

**The empty-memory case says something specific.** When there's nothing relevant to
recall, the prompt doesn't just omit the section — it says *"The crew has no prior
learnings relevant to this yet. Say so rather than inventing history."*

That's the anti-fabrication rule applied at the exact moment fabrication is most
likely. An agent handed an empty context and asked to produce analysis will produce
analysis; this tells it that "I have nothing to go on" is a valid, expected answer.

**The audit trail records failures too.** Look at the catch block — it calls
`recordRun` with `success: false` and the error message, then rethrows. Every
attempt lands in `agent_runs`, including the ones that blew up.

Systems that only log successes are systems where you cannot debug the failures.
When an agent starts returning malformed JSON at 3am, the record of *what it
returned* is the only thing that will tell you why.

**The parse function is a gate, not a formality.** `parse` is supplied by the
caller, it throws on anything unexpected, and a throw fails the run. Which brings
us to the next chapter.

---

## Chapter 10: Getting JSON Out of a Text Generator

You asked for JSON. The charter says JSON only. The schema is right there in the
prompt.

Here's what actually comes back sometimes:

````
Sure! Here's the analysis you requested:

```json
{"gaps": [{"title": "..."}]}
```

Let me know if you'd like me to expand on any of these!
````

The model was helpful. It framed its answer. It offered follow-up. All of which
makes `JSON.parse()` throw.

You cannot prompt your way out of this reliably. You can reduce it — the charter's
final rule does — but across thousands of calls it will happen, and when it does
you've lost a cycle for a formatting quirk.

So we parse defensively:

```typescript
export function extractJson(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error(`Agent reply was not JSON: ${raw.slice(0, 300)}`);
  }
}
```

Three attempts, cheapest first:

1. **Strip fences and parse.** Handles the clean case and the fenced case.
2. **Find the outermost braces.** `indexOf('{')` to `lastIndexOf('}')` — note
   *last*, not first. That's what makes nested objects work; taking the first `}`
   would truncate `{"a":{"b":4}}` into `{"a":{"b":4`.
3. **Throw, with the raw text in the message.** Truncated to 300 characters so a
   runaway response doesn't flood the logs, but present, so you can see what
   happened.

This is tested against all four shapes — plain, fenced, prose-wrapped, and
nested-brace — plus the failure case. Five assertions covering maybe fifteen lines
of code, and they're worth writing, because this function sits between every agent
and every action the system takes.

### Validation as narrowing

`extractJson` gets you an `unknown`. Turning that into a typed value the rest of the
code can trust is the `parse` function's job:

```typescript
parse: (value) => {
  const gaps = asArray((value as { gaps?: unknown }).gaps, 'gaps');
  return gaps.slice(0, maxGaps).map((raw) => {
    const gap = raw as Record<string, unknown>;
    return {
      title: asString(gap.title, 'title'),
      segment: asString(gap.segment, 'segment'),
      description: asString(gap.description, 'description'),
      evidence: Array.isArray(gap.evidence) ? gap.evidence.map(String) : [],
      confidence: Math.min(1, Math.max(0, asNumber(gap.confidence, 'confidence', 0.4))),
    };
  });
},
```

Every field is checked. The helpers are three lines each:

```typescript
export function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Expected non-empty string for "${field}"`);
  }
  return value.trim();
}
```

Note the specific behaviors:

- **`.slice(0, maxGaps)`** — the model was asked for at most three gaps. If it
  returns seven, we take three. The prompt is a request; the slice is the limit.
- **`Math.min(1, Math.max(0, ...))`** — confidence is clamped to 0–1 regardless of
  what came back, because the database has a check constraint on that range and a
  model that returns `85` (thinking percent) would otherwise fail the insert.
- **`asNumber(gap.confidence, 'confidence', 0.4)`** — a default. Confidence is the
  one field where a missing value shouldn't kill the whole batch; a middling default
  is better than losing four good gaps to one absent number.
- **Every other field throws.** A gap with no segment is not a gap.

The pattern: **be strict about what you must have, lenient about what you can
default, and clamp anything the database has an opinion about.**

---

## Chapter 11: The Manager, and the Discipline of Only Reading Numbers

BMDC-CHIEF's mandate is short, and the most important sentence is what it *doesn't*
do:

> You are the crew's manager. You do not research, write copy, or send messages
> yourself — you read the state of the business and decide what the crew does next.

Every cycle, the manager gets a situation report. Here's how it's assembled:

```typescript
export async function buildSituationReport(): Promise<SituationReport> {
  const [gaps, campaigns, performance, agents, totals] = await Promise.all([
    listMarketGaps(),
    listCampaigns(['running', 'paused']),
    getCampaignPerformance(),
    listAgents(),
    getSalesTotals(),
  ]);
  // ...assembled into a typed report
}
```

Five parallel queries. Every one of them reads measured state. **No agent's opinion
of its own work is anywhere in this report.** The researcher doesn't get to say its
gaps were good. The copywriter doesn't get to say the messages were strong. The
manager sees message counts, reply counts, sale counts, and revenue.

The prompt it receives leads with the number that matters:

```
REVENUE TO DATE: $0.00 across 0 sale(s).

MARKET GAPS:
- 8c31... "Deposit collection for DM bookings" [testing, confidence 0.60] — indie tattoo artists

CAMPAIGNS:
- 4f2a... "Deposit Link" (variant urgency, sms): 180 sent, 22 replies, 0 sales, $0.00
- 7b91... "Deposit Link" (variant proof, sms): 180 sent, 9 replies, 4 sales, $316.00

ROSTER:
- BMDC-CHIEF (manager, gen 0): fitness 0.000 over 0 runs
- BMDC-PROSPECT (researcher, gen 0): fitness 0.220 over 4 runs
- BMDC-SIGNAL (social, gen 0): fitness 0.310 over 6 runs
```

And then the instructions that shape the decision:

```
Replication limits you must plan within: at most 8 active agents (currently 3), at
most 1 new specialist per cycle, lineage depth at most 3. Set "spawn" to null unless
there is a concrete job none of the current agents covers -- an extra agent with an
overlapping mandate makes the crew slower, not smarter.

Kill campaigns that have sent a meaningful number of messages and produced no sales.
Kill gaps the outcome data has argued against. If the crew has sent nothing yet, say
so and get one campaign running rather than planning a second round of research.
```

Three things are being prevented here, each learned from watching this class of
system misbehave:

**Empire-building.** Left alone, a manager agent asked "do you need more staff?"
says yes. Every time. The limits are stated, and the reason not to spawn is stated
alongside them — an overlapping agent makes things *worse*, not just costlier.

**Sunk-cost persistence.** "Kill campaigns that have produced no sales" is explicit
because models are reluctant to abandon things. Without it you get "let's give it
more time" indefinitely.

**Analysis paralysis.** That last sentence — *"If the crew has sent nothing yet,
say so and get one campaign running rather than planning a second round of
research"* — is there because a cold-start system will happily research forever.
Research is safe. Sending is scary. The prompt closes that escape hatch.

### The manager's output

```json
{
  "assessment": "2-4 sentences on where the crew actually stands, revenue first",
  "decisions": [
    { "agent": "codename", "action": "what they do this cycle", "rationale": "why", "target": "id or empty string" }
  ],
  "research_focus": "what BMDC-PROSPECT should investigate, or empty string for open-ended",
  "kill_campaign_ids": ["campaign ids to stop"],
  "kill_gap_ids": ["gap ids no longer worth pursuing"],
  "spawn": { "codename": "BMDC-SOMETHING", "mandate": "what this specialist owns" }
}
```

Note what's here: `kill_campaign_ids` and `kill_gap_ids` are top-level fields, not
buried in the prose of `assessment`. **Killing things is a first-class output.**

If stopping a campaign required the manager to write a sentence that some downstream
code then interpreted, it would happen rarely and unreliably. Making it an array of
IDs means the decision is structured, actionable, and easy to audit.

Design your schemas so the hard decisions are as easy to express as the easy ones.

### Fitness: the memory of performance

```typescript
export async function recordAgentOutcome(agentId: string, outcomeScore: number): Promise<void> {
  const { data } = await client
    .from('crew_agents').select('fitness, runs').eq('id', agentId).single();

  const alpha = 0.3;
  const current = data.fitness;
  const runs = data.runs;
  const blended = runs === 0 ? outcomeScore : current * (1 - alpha) + outcomeScore * alpha;

  await client.from('crew_agents')
    .update({ fitness: blended, runs: runs + 1 }).eq('id', agentId);
}
```

An exponential moving average with α = 0.3. Each new outcome contributes 30%; the
existing fitness keeps 70%.

Why not a plain average? Because a plain average has no sense of time. An agent
that produced five sales in its first ten runs and nothing in the next forty still
shows a respectable lifetime average. It looks fine. It stopped working weeks ago.

With exponential decay, recent zeros pull fitness down. An agent that stops earning
fades toward zero and eventually crosses the retirement threshold. **An agent's
fitness answers "is this working *now*," not "did this ever work."**

The `runs === 0` special case matters too: the first outcome sets fitness directly
rather than blending against the default of zero. Otherwise an agent's first
success would register as 0.3 instead of 1.0, and it would take several wins just
to climb out of the starting hole.

### The Takeaway

**Separate the thing that judges from the thing that's judged, and feed the judge
only measurements.**

This is an old organizational principle — you don't let people grade their own
homework — and it applies with more force to language models, because they are
*better* at producing convincing self-assessment than humans are, and just as
motivated by their training to be encouraging.

The manager in this system has no access to any agent's opinion. It sees counts and
dollars. That constraint is what makes its decisions worth anything.
