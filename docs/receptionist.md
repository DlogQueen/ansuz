# BMDC Receptionist

An AI receptionist that answers a business phone line 24/7, books appointments
into a real calendar, takes messages, and hands off to a human when it should.

Sold separately from the crew (SKU 03), but built on the same foundations: the
same LLM client, the same Twilio account, the same database, the same posture
of enforcing in code what matters rather than asking for it in a prompt.

## How a call goes

```
ring  →  /api/twilio/voice
         Look up the business by the number that was called.
         Greet, and <Gather input="speech">.
   ↓
turn  →  /api/twilio/voice/turn         (once per thing the caller says)
         1. Verify Twilio's signature. Reject if it fails.
         2. Escalation check — in code, before the model runs.
         3. Turn-limit check.
         4. Compute open slots, offer three spread across days.
         5. Ask the model what to say and what the caller wants.
         6. Act: book / take a message / escalate / keep talking.
   ↓
end   →  Every ending writes an outcome to call_sessions:
         booked · message_taken · escalated · answered · abandoned
```

### Why `<Gather>` and not media streams

Twilio offers two ways to run a voice bot. Bidirectional **media streams** give
lower latency and let the caller interrupt, but need a WebSocket bridge, an
audio codec path, and a realtime model connection held open for the whole call.
**`<Gather input="speech">`** is turn-based: Twilio does the speech-to-text and
posts the result to a webhook; we reply with what to say next.

For booking an appointment, turn-based is the right shape — the conversation is
a short sequence of questions with a structured outcome, not free-form chat.
It also runs on the HTTP server that already exists and fails in ways that are
easy to see in a log.

Ansuz already has a working realtime voice pipeline (`src/llm/xaiVoice.ts`).
That's the upgrade path when latency becomes the thing worth paying for, not a
prerequisite for shipping.

## The three guards

Same principle as the crew's consent gates: the things that must not happen are
prevented by code, not requested in a prompt.

**1. Double-booking is refused by Postgres.**

```sql
constraint appointments_no_overlap exclude using gist (
  business_id with =,
  tstzrange(starts_at, ends_at) with &&
) where (status <> 'cancelled')
```

Two callers asking for the same 2pm slot in the same second is not
hypothetical — it's what happens when a business gets busy, which is exactly
when this has to work. An application-level "is it free?" check has a race
between the read and the write. This doesn't. `SlotTakenError` is caught in the
call flow and recovered from by offering another time, in conversation.

Verified against the live database: identical slots refused, partial overlaps
refused, abutting slots allowed, cancelled slots immediately rebookable.

**2. Escalation runs before the model does.**

```typescript
const escalation = mustEscalate({ callerSaid, business });
if (escalation.escalate) return endWithEscalation({ ... });
```

A fixed safety list (`emergency`, `chest pain`, `lawyer`, …) plus the
business's own `escalate_to_human` topics. Deliberately blunt substring
matching: a false positive transfers someone to a human, which costs little. A
false negative has an AI handling a medical emergency, which is not a mistake
worth optimizing toward.

**3. The receptionist can only offer times it was given.**

`parseDecision()` clamps the model's chosen slot index to the range actually
offered. A model returning index 7 when three slots exist books nothing.
Inventing an availability is the failure that turns into a customer standing
outside a locked door.

Plus: transcripts below `MIN_SPEECH_CONFIDENCE` (0.4) are treated as unheard
and the caller is asked to repeat. Acting on a bad transcript is how you book
the wrong day and don't find out until the no-show.

## Setup

1. **Apply the migration** — `supabase/migrations/0003_receptionist.sql`
   (needs `btree_gist`, which it creates).

2. **Register the business:**

   ```sh
   npm run receptionist -- add smiles "Smiles Dental" +15551234567 America/Chicago
   npm run receptionist -- hours smiles mon-fri 09:00 17:00
   npm run receptionist -- slots smiles      # preview what a caller hears
   ```

3. **Point the number at the server.** In the Twilio console, the number's
   "A call comes in" webhook → `POST {BMDC_PUBLIC_URL}/api/twilio/voice`.

4. **Check the config:**

   ```sh
   npm run receptionist -- status smiles
   ```

   This warns if `TWILIO_AUTH_TOKEN` or `BMDC_PUBLIC_URL` is missing — without
   either, every call webhook is rejected and **the line silently won't
   answer.**

## Commands

| Command | Does |
|---|---|
| `add <slug> <name> [+phone] [tz]` | Register or update a business |
| `hours <slug> <mon-fri\|all\|sat\|…> <HH:MM> <HH:MM>` | Set weekly opening hours |
| `slots <slug>` | Preview open slots and what a caller would be offered |
| `book-list <slug>` | Upcoming appointments |
| `messages <slug>` | Unhandled callbacks |
| `status [slug]` | Config warnings + call outcomes |
| `npm run test:receptionist` | 58 offline checks — no network, database, or model |

## Per-business configuration

`business_profiles` is where a deployment stops being ours and becomes theirs.
It also serves the crew (SKU 02): `voice` and `never_say` are injected into
agent prompts, so the same engine writes in a different business's voice.

| Column | Effect |
|---|---|
| `voice` | Prose, injected into the prompt. "Warm and brief" vs. "Formal, precise." |
| `never_say` | Topics or claims this business never makes |
| `greeting` | The first line of every call |
| `escalate_to_human` | Topics that transfer, enforced in code |
| `transfer_number` | Where escalations go. Null = take an urgent message instead |
| `appointment_minutes` | Slot length, 5–480 |
| `timezone` | IANA zone; DST is followed via `Intl`, not a hardcoded table |

## What's verified, and what isn't

**Verified:** the exclusion constraint against live Postgres (all five cases),
and 58 offline checks covering slot computation (bookings removed, lead time,
closed days, abutting slots), spoken time formatting, timezone offsets,
escalation matching, decision parsing including the out-of-range slot guard,
TwiML generation, and speech-confidence handling.

**Not verified:** no real phone call has been placed. The whole flow —
Twilio's signature on a voice webhook, its speech-to-text quality, TTS
pronunciation of the slot descriptions, and transfer behaviour — is untested
against an actual handset. Treat the first call as a test, to a number you
control.

**Not built:** SMS confirmation and reminders after booking (the Twilio send
path exists; nothing calls it from here yet), rescheduling and cancelling by
phone (the intents parse, the flow doesn't act on them), calendar sync to
Google/Cal.com, and multi-agent handoff between the crew and the receptionist.

## Compliance notes

Call recording consent is two-party in several US states. This system stores
**transcripts**, not audio, which is a lower bar — but check your jurisdiction
before enabling any recording, and consider a disclosure line in the greeting.

The charter requires the receptionist to identify itself as an AI when asked,
without hedging. That's the same rule the crew operates under, and it should
stay in place for the same reason: someone on a phone line deserves a straight
answer to a straight question.
