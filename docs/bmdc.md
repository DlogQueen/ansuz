# BMDC — Byte Me Dev Crew

An adaptive, self-replicating sales crew built on Ansuz's memory backend. Three
founding agents research market gaps, generate offers, run SMS outreach through
Twilio, and close through Stripe. The crew's goal is completed sales, and its
scoreboard is the `sales` table — nothing else counts.

It reuses Ansuz's existing pieces rather than standing up a parallel stack:
`long_term_memory` (with pgvector retrieval) is where its learnings live,
`src/llm/openrouter.ts` is how its agents think, and `scripts/server.ts` is
where its webhooks land.

## The crew

| Codename | Role | Owns |
|---|---|---|
| `BMDC-CHIEF` | manager | Reads realized outcomes, allocates work, kills what isn't earning, decides when to spawn a specialist. Never writes copy or sends messages. |
| `BMDC-PROSPECT` | researcher | Finds market gaps, generates and prices offers, creates the Stripe product/price/payment link. |
| `BMDC-SIGNAL` | social | Writes SMS variants and social drafts, and handles replies from leads. |

Plus any specialists the crew spawns for itself (see
[Self-replication](#self-replication)).

## The adapt loop

One invocation of `runCycle()` (`src/crew/orchestrator.ts`) is one turn:

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

Cycles are scheduled from outside the loop, never `while(true)` inside it — a
bad cycle stops the crew rather than spinning. Run them by hand with
`npm run bmdc -- cycle`, or set `BMDC_CYCLE_MINUTES` to have `npm run server`
run them on an interval.

**Adaptation is grounded in money, not activity.** `campaign_performance()`
joins outreach to sales, so a variant with great reply rates and no purchases
reads as the failure it is. Agent `fitness` is an exponential blend (α=0.3) of
realized outcomes, which means an agent that stops earning fades instead of
coasting on early wins.

## Self-replication

The crew grows its own roster. When `BMDC-CHIEF` identifies a job none of the
current agents covers, it writes a codename and mandate, and
`spawnSpecialist()` creates the agent — a row in `crew_agents` with a parent, a
generation, and the charter baked into its stored mandate. It runs in the next
cycle, sharing the same memory.

What "self-replicating" does **not** mean here: the crew does not write or
deploy code, copy itself to other machines, provision infrastructure, create
accounts, or spend money beyond the API keys a human configured.

The caps live in `src/crew/replication.ts`, enforced in code rather than
trusted to a prompt:

- `MAX_ACTIVE_AGENTS = 8` — total roster size
- `MAX_GENERATION = 3` — how far a lineage can get from a founder
- `MAX_SPAWNS_PER_CYCLE = 1` — growth stays slow enough to watch

Hitting a cap is returned to the manager as a refusal it can plan around, not
thrown as an error. Founders are never auto-retired: a crew that retired its
own manager couldn't recover.

## Consent, and why it's structural

Every outbound marketing message goes through `src/crew/pipeline.ts`, and it
will not send to a lead who isn't `opted_in`. This is enforced in three places
on purpose:

1. `listReachableLeads()` only returns opted-in leads.
2. `runOutreach()` re-checks each lead immediately before sending — the last
   gate before a real message reaches a real person shouldn't be a query that
   might silently change shape one day.
3. `setLeadConsent()` refuses to move a lead out of `opted_out`. An opt-out is
   terminal; re-subscribing is a deliberate human action against the database,
   not something the crew can do to itself.

`STOP` / `UNSUBSCRIBE` / `CANCEL` and friends are handled before the model ever
sees the message — an opt-out is a state change to apply immediately, not a
conversation to handle well. `HELP` gets a standard identification reply.

The charter in `src/crew/roster.ts` is prepended to every agent's prompt in
every generation: no uncontacted outreach, no invented results or fake scarcity,
identify as an AI when asked, don't dress up a zero-revenue cycle as a win.

If you add a new sending path, put it in `pipeline.ts` rather than importing
`sendMessage` directly — that's what keeps the consent gate un-bypassable.

## Setup

1. **Apply the migration.** Paste `supabase/migrations/0002_bmdc_crew.sql` into
   the Supabase SQL Editor (or `supabase db push` if you have the CLI linked).
   It adds the crew's operational tables and widens `long_term_memory`'s
   category constraint.

2. **Fill in the BMDC block in `.env`** (see `.env.example`): `BMDC_PUBLIC_URL`,
   the Twilio credentials, and the Stripe keys. Use Stripe **test** keys until
   you're happy with what the crew does.

3. **Expose the server publicly** so the webhooks can reach it:

   ```sh
   npm run server                       # listens on :8787
   cloudflared tunnel --url http://localhost:8787   # or ngrok http 8787
   ```

   Set `BMDC_PUBLIC_URL` to the tunnel's HTTPS URL. It has to be exact —
   Twilio's signature is computed over the precise URL it called.

4. **Point the webhooks at it:**
   - Twilio → your number's "A message comes in" → `POST {BMDC_PUBLIC_URL}/api/twilio/inbound`
   - Stripe → Developers → Webhooks → add endpoint `{BMDC_PUBLIC_URL}/api/stripe/webhook`,
     event `checkout.session.completed`. Copy the signing secret (`whsec_…`)
     into `STRIPE_WEBHOOK_SECRET`.

5. **Seed the crew and add a lead:**

   ```sh
   npm run bmdc -- seed
   npm run bmdc -- lead +15551234567 "Sam" "indie tattoo artists"
   npm run bmdc -- cycle --dry-run     # plans and drafts, sends nothing
   npm run bmdc -- cycle               # for real
   npm run bmdc -- status
   ```

   `lead` marks the number opted-in with source `cli_manual`, which is a claim
   that a human actually collected that consent. Don't use it to bulk-load a
   purchased list — the entire outreach path is built on that flag meaning
   something.

## Commands

| Command | Does |
|---|---|
| `npm run bmdc -- seed` | Create the founding three (idempotent) |
| `npm run bmdc -- status` | Roster, gaps, campaigns, revenue, integration status |
| `npm run bmdc -- cycle [--dry-run]` | One adapt cycle; `--dry-run` drafts without sending |
| `npm run bmdc -- lead <e164> [name] [segment]` | Add an opted-in lead |
| `npm run bmdc -- social` | Show drafted social posts |
| `npm run test:bmdc` | Offline checks — webhook signatures, keyword classification, JSON parsing |

## Endpoints

Added to `scripts/server.ts`:

| Route | Purpose |
|---|---|
| `POST /api/twilio/inbound` | Inbound SMS/WhatsApp. Verifies `X-Twilio-Signature`, returns TwiML. |
| `POST /api/stripe/webhook` | Checkout completion. Verifies `Stripe-Signature` over the raw body, books the sale. |
| `POST /api/bmdc/cycle` | Trigger one cycle on demand. |

Both webhooks are publicly reachable by necessity, so the provider signature
*is* the authentication — an unverified request never reaches the crew's
decision loop. The Stripe check includes a 5-minute timestamp tolerance, so a
captured webhook can't be replayed to book phantom sales, and sales are upserted
on `stripe_session_id` so Stripe's own retries are idempotent.

## Known gaps

- **Social publishing is not wired.** Posts are drafted into `social_posts` with
  status `draft` and stay there. Publishing reaches an audience the crew can't
  take a message back from, so it's left behind a human step.
- **Twilio has not been exercised against a real number yet.** Credentials and
  signature logic are covered offline (`npm run test:bmdc`), but no message has
  actually been sent or received. Treat the first campaign as a test, with one
  lead you control.
- **Stripe is verified live** (test mode): `createOfferProducts()` and
  `createCheckoutSession()` were run against the real API — product, price,
  payment link and session all created, and the `lead_id`/`campaign_id`/
  `offer_id` metadata round-tripped intact off the fetched session. That last
  part is what revenue attribution depends on: without it every sale lands
  unattributed and campaign fitness is meaningless. What remains unverified is
  a real `checkout.session.completed` webhook reaching `handleStripeEvent()`
  and booking a row in `sales` — that needs the public tunnel up.
- **Lead sourcing is manual.** There's no inbound landing page or opt-in form
  yet; leads arrive via the CLI or by texting the number first.
- **Voice campaigns** are in the schema (`channel: 'voice'`) but unimplemented.
  Ansuz already has a working realtime voice pipeline (`src/llm/xaiVoice.ts`) —
  connecting it to Twilio Voice is the obvious next build.

---

Copyright © 2026 Byte Me Studios. All rights reserved.
Proprietary — see [`COPYRIGHT`](../COPYRIGHT).
