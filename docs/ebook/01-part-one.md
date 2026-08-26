# PART I — THE IDEA

---

## Chapter 1: Three Agents Walk Into a Database

Here's the whole system in one paragraph, so you know where we're going.

Three AI agents share a database. One of them reads the numbers and decides what
the crew works on. One researches which groups of people have a problem nobody's
solving well, and turns that into something sellable. One writes the messages and
handles the replies. When someone buys, Stripe tells the system, the system writes
a row, and that row changes what all three agents do next. If the crew needs a
skill none of them have, the manager can create a fourth agent — but only under
limits it cannot talk its way past.

That's it. That's BMDC — the Byte Me Dev Crew.

Now let's talk about why almost every version of this you've seen doesn't work.

### The demo that always works and the system that never does

You've seen the demo. Someone wires up a few agents with names like "Researcher"
and "Copywriter," they pass messages to each other, and the transcript looks
incredible. The Researcher produces a market analysis. The Copywriter writes
something punchy. The Manager says "Great work team!" and summarizes.

Then you run it a second time and it produces a completely different, equally
confident market analysis. Run it a third time and it invents a customer testimonial.

The demo works because a language model is extremely good at producing text that
*looks like* the output of a process. It is not, by default, doing the process.

The gap between those two things is the entire subject of this book.

### What makes a system real

A real system has something in it that can tell the model it was wrong.

Not a human reviewing output — that doesn't scale and isn't automation. Something
structural. Some fact in the world that the model doesn't control, that gets
written down, that the model has to look at next time.

In BMDC, that thing is money.

Specifically: a row in a table called `sales`, written only by a cryptographically
verified webhook from Stripe, containing an amount that actually moved between two
real bank accounts. No agent can write to it. No agent can argue with it. The
manager agent reads it at the start of every cycle and has to plan around what it
says.

That single design decision is what makes this a system rather than a demo. Every
other choice in this book flows downhill from it.

### The three roles, and why exactly three

**BMDC-CHIEF** is the manager. Its entire job is allocation — deciding what the
crew does this cycle. It never writes copy. It never sends a message. It never
touches a customer. It reads measured outcomes and makes decisions.

The separation matters more than it looks. If the agent that writes the marketing
copy is also the agent that judges whether the marketing worked, you have built a
machine for generating flattering self-assessments. Every organization discovers
this eventually; we just built it in from the start.

**BMDC-PROSPECT** is research and offer design. It finds gaps — groups of people
with a specific unmet need — and turns them into things that can actually be
purchased. It also sets the price.

**BMDC-SIGNAL** is the voice. Outbound copy, social drafts, and replies to inbound
messages. It's the only agent whose words reach a human being.

Three is not arbitrary. It's the minimum number of roles where the important
separations exist:

- The one who decides is not the one who executes.
- The one who creates the offer is not the one who pitches it.
- The one who talks to customers is not the one who grades the results.

Add a fourth agent and you're adding specialization, not structure. That's why the
crew *can* grow to eight — but it starts at three, and the three are these three.

### The part where I define "self-replicating" honestly

Let's deal with this now, because it's the phrase most likely to be misunderstood.

BMDC is self-replicating in exactly one sense: **the manager can add new agents to
the roster.** When it identifies a job none of the current agents covers, it writes
a codename and a mandate, and a new specialist starts running on the next cycle,
inheriting the crew's shared rules and shared memory.

What it does **not** do:

- It does not write code.
- It does not copy itself to other machines.
- It does not provision servers, create accounts, or acquire resources.
- It does not spend money beyond the API keys a human explicitly configured.
- It cannot remove its own limits.

A "spawned agent" is a row in a Postgres table with a `parent_id` and a
`generation` number. It runs inside the same process, on the same schedule, under
the same constraints as its parent. The replication is organizational, not viral.

I'm being precise about this for two reasons. The boring reason is accuracy. The
interesting reason is that **the bounded version is the useful version.** A system
that could genuinely propagate itself would be uncontrollable, and uncontrollable
systems don't get deployed by anyone sensible. What you actually want is a system
that can grow the *right amount* in the *right direction* and then stop. We'll
build exactly that in Chapter 12, and the stopping is the hard part.

### The Takeaway

**A multi-agent system is only as real as its cheapest way to be proven wrong.**

Before you build anything with agents, answer one question: what fact, outside the
model's control, will tell this system it's failing? If the answer is "a human will
notice eventually," you're building a demo. Find the number that can't be argued
with, make it the scoreboard, and design everything else around getting that number
in front of the decision-maker.

---

## Chapter 2: Standing on What's Already There

BMDC wasn't built from nothing. It was built inside a project called Ansuz — a
persistent VR space with a continuously running AI presence, complete with a memory
system, a language-model client, and a small HTTP server.

When the crew needed a place to store what it learned, there were two options:
build a new memory system, or use the one already sitting there.

This chapter is about why "use the one already there" was correct, and about the
one place where being clever would have cost us.

### What already existed

Ansuz had a two-tier memory architecture:

**`short_term_memory`** — a rolling 24-hour log. Every message, every observation,
raw and unprocessed. It has an `expires_at` column and a function that prunes
what's past it.

**`long_term_memory`** — consolidated summaries with vector embeddings. A background
job takes finished conversations, summarizes them into a few sentences, assigns an
importance score from 1 to 5, generates an embedding, and stores it. Later, when
something relevant comes up, a cosine-similarity search pulls the summaries that
relate to the current question.

This is a good architecture. It mirrors something real about how memory works: you
don't store every moment forever, you store compressed versions of what mattered,
and you retrieve them by association rather than by scanning everything.

### The decision: one memory or two?

The crew needed to remember things. "This segment didn't convert." "This price
point worked." "We spawned a specialist for X."

Option A: give BMDC its own learnings table, separate from Ansuz's memory.

Option B: write crew learnings into `long_term_memory` alongside everything else.

I chose B, and the reason is worth sitting with, because it's a general principle
about building on existing systems.

**Two memory systems means two retrieval paths, two consolidation strategies, two
places to look when something's forgotten, and an eventual third system to reconcile
them.** The cost isn't the second table. It's every future decision that now has to
be made twice.

The existing table already had a `category` column with a check constraint listing
valid values. Adding crew categories was four lines of SQL:

```sql
alter table long_term_memory drop constraint if exists long_term_memory_category_check;
alter table long_term_memory add constraint long_term_memory_category_check
  check (category in (
    'interaction',
    'built-artifact',
    'self-repair-success',
    'self-repair-failure',
    'market-gap',        -- new
    'campaign-result',   -- new
    'sales-outcome',     -- new
    'crew-spawn',        -- new
    'other'
  ));
```

Now a crew learning and a conversation memory live in the same store, get retrieved
by the same vector search, and compete for relevance on equal terms. When the
research agent asks "what do I know about this segment," it can surface something
learned from a sales outcome *and* something learned from a conversation, because
they're in the same index.

### Episodic versus operational: the line that matters

Here's the distinction that made the whole thing coherent.

**Episodic memory** is what happened and what it meant. "The tattoo-artist segment
replied well but didn't buy; the price was probably the issue." Fuzzy, summarized,
retrieved by similarity. That goes in `long_term_memory`.

**Operational state** is what currently is. Who's on the crew. Which campaigns are
running. Which leads have opted in. How much revenue exists. Exact, queryable,
authoritative. That needs its own tables.

Getting this line wrong in either direction is a real failure mode:

- Put operational state in fuzzy memory and your system can't reliably answer "how
  many leads have opted in," which means it can't be trusted with anything.
- Put episodic learning in rigid tables and you lose the associative retrieval that
  makes the crew's experience useful.

So BMDC added ten new tables for operational state — we'll walk through all of them
in Part II — and wrote its learnings into the existing memory.

### One inherited decision I kept

Ansuz's memory tables have Row Level Security enabled with **no policies at all.**

If you're not deep in Postgres: RLS with no policies means the table denies
everything by default. The public-facing API key can't read or write a single row.
All access happens server-side with a service-role key that bypasses RLS entirely.

Some developers see this and think it's a mistake — an unfinished configuration.
It isn't. It's a posture: **this data is not client-accessible, full stop, and
that's enforced by the database rather than by remembering to be careful.**

BMDC's ten tables use the same posture. Every one of them:

```sql
alter table crew_agents enable row level security;
alter table leads enable row level security;
alter table sales enable row level security;
-- ...and so on for all ten
```

No policies. Nothing reachable from a browser. When you're storing phone numbers,
consent records, and payment attribution, the correct number of ways for a client
to reach that data directly is zero, and the correct place to enforce it is the
layer that can't be bypassed by a bug in your application code.

### The Takeaway

**Extend the system that exists until it genuinely can't stretch — then extend it
anyway if the alternative is a parallel system.**

The instinct to build clean and separate is usually the expensive instinct. Two
systems that do similar things don't stay similar; they diverge, and then you're
maintaining the divergence forever. Before you build a parallel anything, check
whether the existing thing has a `category` column you could add four values to.

And when you inherit a security posture that seems paranoid, find out whether it's
paranoid or just correct before you loosen it.

---

## Chapter 3: The Charter — Rules That Survive Their Author

Every agent in BMDC, in every generation, gets the same block of text at the top of
its prompt. It's called the charter, and it's the closest thing this system has to
a constitution.

Here it is, in full, exactly as it ships:

```
You are part of BMDC (Byte Me Dev Crew), an autonomous crew whose goal is
completing real sales.

Shared charter -- these hold for every member of the crew, in every generation:
- Revenue is the only scoreboard. A campaign that produces engagement and no paid
  Stripe checkout has failed. Say so plainly rather than reframing it as a win.
- Never contact anyone who has not opted in, and never message anyone who sent STOP.
  If you are unsure whether consent exists, the answer is no.
- Never claim a result, credential, endorsement, scarcity, deadline, or discount
  that isn't real. Marketing copy that misrepresents the offer is a failure even
  if it sells.
- Identify as an AI assistant when a person asks, without hedging.
- Work from the numbers you are given. If the data doesn't support a conclusion,
  say the data doesn't support a conclusion -- do not invent evidence to justify
  a plan.
- You reply with JSON only, matching the schema in your instructions. No markdown
  fences, no commentary outside the JSON.
```

Six rules. Let's talk about why each one is there, because each is a specific
failure this system would otherwise have.

### "Revenue is the only scoreboard"

Language models are relentlessly encouraging. Ask one how a campaign went and it
will find the bright side, because being encouraging is what most of its training
rewarded.

That instinct is poison in a system that has to decide what to kill.

Without this rule, a campaign that sent 200 messages, got 40 replies, and made zero
sales gets described as "strong engagement, promising signal, worth iterating on."
With this rule, it gets described as what it is: a failure that should be changed
or stopped.

Note the second sentence: *"Say so plainly rather than reframing it as a win."* The
first sentence sets the standard; the second closes the loophole. Without it, a
model can technically honor "revenue is the scoreboard" while burying the zero
under enough positive framing that the decision never gets made.

### "Never contact anyone who has not opted in"

This is a legal requirement before it's an ethical one — unsolicited commercial SMS
runs into the TCPA in the US, with statutory damages per message that can reach
four figures. It's also, practically, how you get a phone number killed by carriers
in the first week.

But here's the thing: **this rule in the prompt is not what enforces it.**

Consent is enforced in code — three separate gates that we'll build in Chapter 15,
none of which a model can talk past. The charter rule exists so the agent doesn't
*try*, and so it doesn't design campaigns that assume access it doesn't have. The
enforcement is elsewhere.

That distinction is one of the most important ideas in this book, and I'll state
it as bluntly as I can: **a rule in a prompt is a preference, not a constraint.**
It shapes behavior. It does not guarantee it. Anything that must not happen has to
be prevented by code that runs regardless of what the model decided.

Say the rule anyway — the two layers together are better than either alone. Just
never mistake the first for the second.

### "Never claim a result that isn't real"

The specific list is deliberate: *result, credential, endorsement, scarcity,
deadline, or discount.* Those are the six things marketing copy fabricates, and a
model trained on the internet has seen millions of examples of all of them.

"Only 3 spots left!" "Join 10,000+ founders!" "Offer ends midnight!" — these are
the native idiom of the genre. Without an explicit prohibition, they show up
because they're what marketing copy *sounds like*.

And then the last clause: *"Marketing copy that misrepresents the offer is a
failure even if it sells."* That's there because the first rule says revenue is the
scoreboard, and a sufficiently clever agent could conclude that a lie which
produces revenue is therefore a success. This closes that door explicitly.

### "Identify as an AI assistant when a person asks"

Short, absolute, no conditions. Someone texting this system might genuinely want to
know whether they're talking to a person. That question deserves a straight answer,
and "without hedging" rules out the technically-true-but-evasive reply.

### "Work from the numbers you are given"

The failure this prevents is the most subtle one in the list.

Ask a model to justify a plan and it will produce justification. If the data
supports the plan, it cites the data. If the data doesn't, it *still produces
justification* — now made of plausible-sounding claims that appeared from nowhere.

In a system where research feeds into spending decisions, invented evidence is the
worst possible output, because it's indistinguishable from real evidence
downstream. Everything after it inherits the fabrication.

There's evidence this rule actually works. When BMDC-PROSPECT was tested against a
completely empty database — no campaigns, no outcomes, nothing to reason from — it
returned its market gaps with a confidence score of **0**. It could have invented a
confident story. It reported that it had nothing to go on. We'll look at that test
in detail in Chapter 19.

### "You reply with JSON only"

The boring one, and the one that makes the other five enforceable.

Structured output is what lets code validate agent output. If an agent returns
prose, all you can do is pass it along and hope. If it returns JSON matching a
schema, you can check the fields, reject malformed responses, and log exactly what
was decided. The audit trail in Chapter 8 exists because of this rule.

### The part that makes it a charter

The charter isn't just prepended at prompt time. When the manager spawns a new
specialist, the charter is baked into the *stored mandate* of the new agent:

```typescript
const spawned = await upsertAgent({
  codename,
  role: 'specialist',
  // The charter is prepended at spawn time, not merely at prompt time, so
  // that an agent's stored mandate is self-contained -- reading the row tells
  // you everything that agent operates under.
  mandate: `${CREW_CHARTER}\n\nYour specialist mandate:\n${request.mandate}`,
  generation,
  parentId: request.parent.id,
});
```

Two consequences, both intentional.

**One:** you can read any agent's row in the database and see the complete set of
rules it operates under. Nothing is implicit. There's no "well, the charter gets
added at runtime" — the constraints are visible in the record.

**Two:** the manager writes the *specialist* mandate, but it does not write the
charter. It can create an agent with a new job. It cannot create an agent with new
rules. Every descendant inherits the same six constraints, and the mechanism for
inheriting them isn't under the manager's control.

That's what "survives replication" means. The crew adapts its tactics every cycle.
The charter doesn't move.

### The Takeaway

**Write your constraints where they get inherited, not where they get remembered.**

If the rules live in one prompt, they apply to one agent. If they live in the
spawn function, they apply to everything that will ever exist in the system.

And keep a clear line in your head between rules you're *asking* for and rules
you're *enforcing*. The charter is the asking. Part V is the enforcing. A system
with only the first is trusting a text generator with things that shouldn't be
trusted to one.
