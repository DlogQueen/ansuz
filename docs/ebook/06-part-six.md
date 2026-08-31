# PART VI — REALITY

---

## Chapter 17: Running It for Free, and What That Costs You

Partway through building this, the OpenRouter account ran out of credits.

```
402 Insufficient credits. Add more using https://openrouter.ai/settings/credits
```

Every agent stopped. The manager couldn't plan, research couldn't research, the
copywriter couldn't write, and embeddings couldn't embed — all of it routed through
one pay-as-you-go key with a zero balance.

That's a design flaw, not an accounting problem. A system with one paid dependency
has one way to stop completely.

### The provider dispatcher

```typescript
export type LlmProvider = 'openrouter' | 'groq';

export function getProvider(): LlmProvider {
  const configured = process.env.LLM_PROVIDER?.toLowerCase();
  if (configured === 'groq' || configured === 'openrouter') return configured;

  if (process.env.OPENROUTER_API_KEY) return 'openrouter';
  if (process.env.GROQ_API_KEY) return 'groq';
  return 'openrouter';
}

export async function chatCompletion(messages: ChatMessage[]): Promise<string> {
  return getProvider() === 'groq'
    ? groqChatCompletion(messages)
    : openrouterChatCompletion(messages);
}
```

Explicit config wins; otherwise infer from which key exists, preferring OpenRouter
when both are present. Groq's free tier is rate-limited but has no balance to
exhaust — which is exactly the property you want in a fallback.

The Groq client distinguishes rate limits from auth failures, because the fix is
different:

```typescript
if (response.status === 429) {
  throw new Error(`Groq rate limit hit (free tier). Retry shortly or slow the cycle cadence. ${detail}`);
}
```

### The honest cost: no embeddings

Groq serves chat models and speech models. It does not serve embeddings. I checked
the live model list rather than assuming — thirteen models, all chat, Whisper, or
TTS.

No embeddings endpoint means no vector similarity search. Which means the memory
system, the one described lovingly in Chapter 2, cannot do the thing that makes it
good.

There were three options:

1. **Pretend it's fine.** Let embedding calls fail, catch the error, run
   memoryless. The system works; it just quietly forgets everything.
2. **Require OpenRouter.** Make embeddings mandatory, no free tier.
3. **Degrade honestly.** Fall back to a worse retrieval that still works, and say
   so.

Option three:

```typescript
/**
 * Non-semantic fallback: the most important recent memories, newest first.
 *
 * Used when the active provider has no embeddings endpoint (Groq). This is a
 * genuinely worse retrieval -- it surfaces what's recent and flagged important
 * rather than what's *relevant to the question being asked* -- but it keeps
 * learnings flowing across cycles instead of the crew starting cold every time.
 * Prefer vector search whenever OpenRouter is funded.
 */
export async function retrieveRecentMemories(params: {
  matchCount?: number;
  minImportance?: number;
  categories?: MemoryCategory[];
}): Promise<LongTermMemoryEntry[]> {
  let query = client
    .from('long_term_memory')
    .select('*')
    .gte('importance', params.minImportance ?? 3)
    .order('importance', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(params.matchCount ?? 6);
  // ...
}
```

Importance first, then recency. It surfaces what was flagged as mattering, most
recent first. It is *not* relevance — it will happily hand the copywriter a memory
about a completely different segment.

But the crew still accumulates experience across cycles, which is the property
that makes it adaptive at all. Worse retrieval beats no retrieval.

And the status command says which mode is running:

```
Model:  groq / openai/gpt-oss-120b   (no embeddings on this provider — memory falls back to recency+importance)
```

Nobody has to discover this by noticing the crew seems forgetful.

### The Takeaway

**When a dependency degrades a capability, degrade the capability visibly rather
than hiding it or refusing to run.**

The instinct is to make things "just work." But a system that silently lost its
memory would look identical to one that had it, right up until you wondered why the
crew kept re-learning the same lesson. Name the degradation in the code, in the
comment, and in the status output.

---

## Chapter 18: Two Bugs That Would Have Shipped Silently

Both of these were found by testing against real APIs rather than mocks. Both would
have looked completely healthy in production. Both are the kind of bug that makes
me distrust any system whose author says everything worked first try.

### Bug one: the memory that quietly stopped being written

Recall the embeddings availability check:

```typescript
export function isEmbeddingsAvailable(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}
```

It answers *is a key configured*. It cannot answer *does that key work*.

Now consider the exact state the project was in: an OpenRouter key present, and
zero balance. So:

1. `isEmbeddingsAvailable()` returns `true`
2. `embedText()` is called, and throws 402
3. In `rememberLearning`, that throw escapes to the outer catch
4. The catch logs and returns
5. **The learning is never stored**

The crew would run cycles. Campaigns would launch. Messages would send. Every
dashboard green. And `long_term_memory` would stay empty forever, because every
write died on an embedding call that nobody noticed failing.

An adaptive system that has stopped accumulating experience is just a system. It
would have kept re-deriving the same conclusions until someone thought to check the
row count.

The fix separates "is it configured" from "did it work":

```typescript
/**
 * Embed, or return null if embedding isn't possible right now.
 *
 * Distinct from `isEmbeddingsAvailable()`, which only answers "is a key
 * configured". A key can be present and still fail per-call -- an unfunded
 * OpenRouter account returns 402, which is the common case once a
 * pay-as-you-go balance runs out. Callers that are *storing* something use
 * this: a memory written without an embedding is degraded but recoverable,
 * whereas letting the throw propagate loses the write entirely.
 *
 * Callers that are *retrieving* should keep using embedText() and handle the
 * failure themselves -- there, silence would hide a real outage.
 */
export async function tryEmbedText(text: string): Promise<number[] | null> {
  try {
    return await embedText(text);
  } catch (error) {
    console.warn('[embeddings] unavailable, storing without a vector:', /* ... */);
    return null;
  }
}
```

Storing callers use `tryEmbedText` and write the row with a null embedding.
Retrieving callers keep the throwing version and fall back to recency.

Same failure, two correct responses, depending on whether you're about to lose data.

Consolidation matters most here, because it *deletes its source rows* after
summarizing:

```typescript
// tryEmbedText, not embedText: a failed embedding must not cost us the
// consolidated summary, since consolidation deletes its source rows.
const embedding = isEmbeddingsAvailable() ? await tryEmbedText(summary) : null;
```

A failed embedding there would have destroyed the conversation *and* failed to
store the summary. Permanent loss from a billing problem.

Verified against the real 402:

```
isEmbeddingsAvailable() = true  (key present, but unfunded)
[embeddings] unavailable, storing without a vector: OpenRouter embeddings request failed (402)
tryEmbedText -> null (degrades, write survives)
embedText -> throws, as retrieval callers expect

PASS: learning would be stored with a null embedding, not dropped.
```

### Bug two: the credentials that could send but not listen

Twilio has two credential types, and they look interchangeable:

- **Account SID** (`AC...`) + Auth Token — the account's root credentials
- **API Key SID** (`SK...`) + secret — scoped, revocable independently

When I was handed an `SK` SID to configure, the original code did this:

```typescript
// original
const auth = Buffer.from(`${credentials.accountSid}:${credentials.authToken}`).toString('base64');
const response = await fetch(
  `${TWILIO_API_BASE}/Accounts/${credentials.accountSid}/Messages.json`, /* ... */
);
```

The account SID is used for two different things: the Basic-auth username, and a
segment of the URL path. An API key can serve the first. It cannot serve the second
— the path always needs `AC...`.

I verified this against the live API, with a control:

```
=== Does the SK key authenticate at all? ===
  Keys.json with SK as path sid -> HTTP 401
  IncomingPhoneNumbers.json with SK as path sid -> HTTP 401

=== Error code check ===
  code=70051 -> CREDENTIALS VALID, permission-scoped

=== Wrong secret, as a control ===
  code=20003 message=Authenticate
```

The real secret gives `70051` (valid, permission-scoped). A deliberately wrong
secret gives `20003` (authentication failure). So the credentials were genuinely
good — the path was wrong.

But that's the *small* half of the bug. Here's the dangerous half.

**Twilio signs inbound webhooks with the account auth token.** Not the API key
secret. There is no API-key-based webhook verification.

So an API-key-only configuration produces this:

- Outbound sending: works perfectly
- Inbound webhook verification: fails for every single message
- Which means every inbound message is rejected with 403
- Which means **`STOP` never reaches the system**
- Which means opt-outs never register
- Which means the crew keeps texting people who explicitly told it to stop

And from the outside, everything looks *great*. Messages are sending. No errors in
the outbound path. The only symptom is silence on the inbound side, which reads as
"nobody's replying" rather than "we are ignoring everyone including the people
asking us to leave them alone."

That is the worst failure shape this system can have. It's a compliance violation,
a carrier-complaint generator, and a genuine harm to real people, all presenting as
a quiet Tuesday.

The fix models credentials as three things instead of two, and refuses the confusion
by name:

```typescript
if (!accountSid.startsWith('AC')) {
  throw new Error(
    `TWILIO_ACCOUNT_SID must be the account SID starting with "AC" (got "${accountSid.slice(0, 2)}..."). ` +
      'An API key SID starts with "SK" and belongs in TWILIO_API_KEY_SID.'
  );
}
```

Plus a capability check that's separate from "is Twilio configured":

```typescript
/**
 * Whether inbound webhooks can be verified. Separate from
 * isTwilioConfigured(): an API-key-only setup can send but cannot verify a
 * reply, and the server refuses unverified inbound rather than trusting it --
 * so this is worth surfacing before a campaign goes out, not after the first
 * STOP fails to register.
 */
export function canVerifyTwilioWebhooks(): boolean {
  return Boolean(process.env.TWILIO_AUTH_TOKEN);
}
```

And a warning in the status command that says what to do:

```
Twilio: configured   Stripe: configured
  ⚠ TWILIO_AUTH_TOKEN not set — outbound sending works, but inbound webhooks
    cannot be verified and will be rejected, so STOP opt-outs will not register.
    Do not run a live campaign in this state.
```

### What both bugs have in common

Neither produces an error message. Neither shows up in a health check. Both make
the system look like it's working while it silently fails at the thing it exists
to do.

And both were found the same way: **by running the real code against real APIs with
the actual credentials**, rather than against mocks that return what I expected.

A mock returns what you think the API returns. Reality returns 402 on a key you
thought was fine, and 401 on a SID you thought was the right shape.

### The Takeaway

**The dangerous bugs are the ones where the failure path looks like the success
path.**

When you review a system like this, don't ask "what happens when it breaks?" Ask:
*what would still look normal if this were broken?* Then check that specific thing
against reality.

---

## Chapter 19: An Honest Inventory

Books in this genre end with everything working. This one ends with a table.

### Verified against live APIs

**Agent reasoning.** All three founding agents were run against Groq's live API on
`openai/gpt-oss-120b`, with the real charter, real mandates, and real parsers.

The results are worth reporting in detail because they tell you something about
whether the constraints actually hold:

- **BMDC-CHIEF** read a cold start correctly — $0 revenue, nothing running — and
  returned `spawn: null`. It did not invent a specialist it didn't need, which is
  the failure the replication limits exist to catch.
- **BMDC-PROSPECT** returned its market gaps with `confidence: 0`. Given no outcome
  data, it reported having no basis rather than fabricating one. That's the
  anti-fabrication rule surviving contact with a real model.
- **BMDC-SIGNAL** produced copy at 241 characters, with the STOP line present and
  the checkout link intact — every stated constraint met.

**Stripe, end to end.** Product, price, payment link, and checkout session all
created against the live test-mode API. The attribution metadata round trip was
verified explicitly: `lead_id`, `campaign_id`, and `offer_id` came back intact off
the fetched session at the correct amount. Test artifacts were archived afterward
rather than left in the account.

**Webhook signatures.** Both schemes, thirty-five offline assertions total,
including tampering, wrong URL, replay, re-serialization, and the
`"stop by later"` case.

**The database.** All twelve tables live with RLS enabled, and
`campaign_performance()` executing cleanly.

### Not verified

**Twilio, against a real phone.** The credential logic is tested and the signature
logic is tested, but no message has been sent to or received from an actual handset.
The first campaign should be a test to a number you control.

**A live webhook completing the loop.** Stripe's API is verified; a real
`checkout.session.completed` arriving at `handleStripeEvent()` and writing a `sales`
row requires the public tunnel running, and hasn't happened yet.

**A full cycle end to end.** Every component works. The complete
observe→decide→act→learn sequence with real data has not been run.

**Anything about outcomes.** No campaign has run. Nothing has sold. Every claim in
this book is about how the system is built, not about what it earns. If a book in
this genre shows you revenue screenshots, ask which quarter, ask for the refund
rate, and ask what else was running.

### Deliberately not built

**Social auto-publishing.** Posts are drafted into `social_posts` with status
`draft` and stay there. Publishing reaches an audience you can't un-reach — that
stays behind a human.

**Voice campaigns.** The schema has `channel: 'voice'`; nothing implements it.

**Automated lead sourcing.** No scraper, no list purchase. Leads arrive by CLI with
a recorded consent source, or by texting the number first. That's a deliberate
constraint on growth, and it's the constraint that keeps the consent model honest.

### What to do with this

Take the pieces that transfer:

- Find the fact your system can't argue with, and make it the scoreboard.
- Enforce what must not happen in code, at every layer, not in the prompt.
- Put your limits where a model can't reach them, and make hitting one a normal
  outcome rather than an error.
- Design the query that shows you failures before you design the agent that reads
  it.
- Degrade visibly.
- Test against reality, and go looking specifically for the failures that would
  still look like success.

The specific system in this book sells SMS offers to opted-in leads. The structure
underneath it — measured ground truth, structural constraints, bounded growth,
honest degradation — is what you'd want in any system you let operate on its own.

That's the part worth keeping.

---

## Appendix A: The Complete File Map

```
src/crew/
  types.ts          158 lines   Every entity, typed
  roster.ts          95         The charter + three founding mandates
  agent.ts          192         think(), extractJson(), rememberLearning()
  store.ts          584         All database access, one module
  manager.ts        217         BMDC-CHIEF: situation report + planning
  researcher.ts     173         BMDC-PROSPECT: gaps + offer design
  social.ts         219         BMDC-SIGNAL: copy, variants, replies
  pipeline.ts       301         Consent gates, outreach, inbound, sales
  replication.ts    131         Spawn caps, retirement
  orchestrator.ts   315         runCycle(): the adapt loop

src/integrations/
  twilio.ts         255         Send, verify, classify keywords
  stripe.ts         220         Products, checkout, signature verification

src/llm/
  chat.ts            47         Provider dispatch
  groqChat.ts        49         Groq client

scripts/
  bmdc.ts           153         CLI: seed, status, cycle, lead, social
  test-bmdc.ts      164         35 offline assertions

supabase/migrations/
  0002_bmdc_crew.sql 298        Ten tables, one function
```

About 3,600 lines. No agent framework. Two integrations, both hand-rolled from
`fetch` and `node:crypto`. Zero new dependencies.

## Appendix B: Commands

```sh
npm run bmdc -- seed              # create the founding three
npm run bmdc -- status            # roster, gaps, campaigns, revenue, config
npm run bmdc -- cycle --dry-run   # plan and draft, send nothing
npm run bmdc -- cycle             # for real
npm run bmdc -- lead <e164> [name] [segment]
npm run bmdc -- social            # drafted posts
npm run test:bmdc                 # 35 offline checks, no credentials needed
```

Start with `--dry-run`. Always start with `--dry-run`.

---

## About the Authors

**Byte Me Studios** is Ryleigh Maloy and Trey Maloy.

BMDC came out of a simpler question than it looks: what would it take for a
small team to sell something without hiring a sales department? Not in the
aspirational sense — in the sense of actually building the thing and finding
out where it breaks.

The answer turned out to be less about AI than about plumbing. The interesting
work wasn't getting three agents to talk to each other; it was deciding what
they were forbidden to do, and then making those rules something the model
couldn't argue with. Most of this book is about that distinction.

Byte Me Studios builds AI systems that touch real customers — sales outreach
that respects a STOP, an AI receptionist that hands off when it should. The
common thread is a preference for constraints you can point at in a schema over
promises made in a prompt.

They write about what breaks, including their own work.

**bytemedevstudio.com**

---

## Also from Byte Me Studios

**BMDC — the crew, deployed.** The system in this book, configured for one
business: their segment, their offer, their voice. The self-replication is the
feature — the manager grows the roster into whatever the business actually
needs.

**BMDC Receptionist.** One agent, split out and pointed at a phone line.
Answers 24/7, books into a real calendar, takes messages, escalates what a
person should handle. Built on the same refusal-first foundations described in
Part V — a booking cannot double-book, and an emergency reaches a human before
the AI is asked what to think.

Both at **bytemedevstudio.com**.
