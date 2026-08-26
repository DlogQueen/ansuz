# Ansuz

Persistent VR/XR space with a continuously-running AI presence named **Sophie**:
memory, feedback loop, self-improvement, MediaPipe-driven perception. Ansuz is the
environment/research space Sophie is embodied in (the specific product built on it is
called IBI). Reuses IBI's architecture pattern -- MediaPipe in-browser -> WebSocket ->
structured JSON, not raw video. See `docs/persona.md` for Sophie's character.

## Status

Phase 0/1 done, Phase 2 scaffolded. See the build plan for the full phase breakdown.

- [x] Repo scaffolded
- [x] Supabase schema/migration written (`short_term_memory`, `long_term_memory`)
- [x] Supabase client (service + anon) added
- [x] Migration applied to the live Supabase project
- [x] WebXR scene shell (Three.js, humanoid avatars for Ansuz and Ryleigh)
- [x] Retrieval wired into an actual conversation loop (`npm run chat`)
- [ ] Consolidation job (Edge Function / cron) -- not yet built, so long-term
      memory stays empty until something populates it
- [ ] Scene driven by real memory state instead of demo oscillation (Phase 3/4)

## Setup

1. Install dependencies:

   ```sh
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in your Supabase project's URL and keys
   (Project Settings > API in the Supabase dashboard):

   ```sh
   cp .env.example .env
   ```

   `SUPABASE_URL` and `SUPABASE_ANON_KEY` are the public-ish client values.
   `SUPABASE_SERVICE_ROLE_KEY` bypasses RLS and must stay server-side only --
   grab it from the dashboard, it isn't something you'd paste into client code.

3. Apply the migration. This project doesn't include the Supabase CLI project
   link, so the simplest path is pasting the file into the SQL Editor:

   - Open your Supabase project's SQL Editor
   - Paste the contents of `supabase/migrations/0001_init_memory_schema.sql`
   - Run it

   (If you have the Supabase CLI linked to this project instead, `supabase db push`
   will apply migrations from `supabase/migrations/` the normal way.)

4. Verify the connection:

   ```sh
   npm run test:connection
   ```

   This requires `SUPABASE_SERVICE_ROLE_KEY` to be set, since memory tables have no
   policies for the anon role (see below).

5. To use the conversation loop (`npm run chat`), also fill in `OPENROUTER_API_KEY`
   and `OPENROUTER_MODEL` in `.env` -- see [Conversation loop](#conversation-loop)
   below.

## Schema

### `short_term_memory`

Raw interaction/perception log, rolling 24-hour window.

| column | notes |
|---|---|
| `role` | `user` \| `assistant` \| `system` \| `perception` |
| `content` | raw text |
| `session_id` | groups entries from one session |
| `expires_at` | defaults to `created_at + 24h`; used for pruning |
| `metadata` | jsonb, freeform |

### `long_term_memory`

Consolidated summaries with pgvector embeddings for semantic retrieval.

| column | notes |
|---|---|
| `category` | `interaction` \| `built-artifact` \| `self-repair-success` \| `self-repair-failure` \| `other` |
| `summary` | consolidated text |
| `embedding` | `vector(1536)` -- matches OpenAI `text-embedding-3-small`; change the dimension in the migration if you use a different embedding model |
| `importance` | 1-5, used to filter retrieval |
| `source_ids` | short_term_memory ids this entry was consolidated from |

The `category` set is wider than Phase 1 strictly needs -- it already has room for
Phase 5's self-improvement loop (built artifacts, failed/successful repair attempts)
so that phase doesn't need a schema migration later.

Two SQL functions ship with the migration:

- `match_long_term_memories(query_embedding, match_count, min_importance)` -- cosine
  similarity search, used by `retrieveRelevantMemories()` in `src/memory/longTermMemory.ts`.
- `prune_short_term_memory()` -- deletes expired short-term rows. Intended to be called
  by the consolidation job once it's built (Phase 1, not yet implemented), after
  summarizing/promoting what's worth keeping.

### Row Level Security

Both tables have RLS enabled with no policies, so the anon key has zero access to
memory. All reads/writes go through the service_role key from server-side code
(`getServiceClient()` in `src/lib/supabaseClient.ts`). `getAnonClient()` exists for
whatever client-facing Supabase use later phases need (scene state, auth, etc.) --
it just isn't wired to the memory tables.

## Project layout

```
supabase/migrations/   -- SQL schema/migrations
src/lib/                -- Supabase client setup
src/memory/             -- short-term / long-term memory read+write + types
src/llm/                -- OpenRouter chat completion + embeddings clients
src/conversation/       -- the conversation loop (retrieve -> log -> generate -> log)
src/crew/               -- BMDC: the agentic sales crew (see docs/bmdc.md)
src/receptionist/       -- BMDC Receptionist: 24/7 call answering (docs/receptionist.md)
src/integrations/       -- Twilio (SMS + Voice) and Stripe clients + webhook verification
scripts/                -- one-off scripts (connection check, chat REPL, etc.)
web/                    -- WebXR scene shell (Three.js + Vite)
```

## Conversation loop

```sh
npm run chat
```

Interactive REPL (`scripts/chat.ts` -> `src/conversation/loop.ts`): each turn logs
the user message to `short_term_memory`, embeds it and retrieves relevant
`long_term_memory` entries, sends the session's recent history plus that context to
the model via OpenRouter, and logs the reply back to `short_term_memory`.

Requires `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` in `.env` -- see
`.env.example`. `OPENROUTER_MODEL` is deliberately not defaulted: the build
plan's Experiment Protocol compares persistent-memory behavior across models,
so pick one per run rather than silently defaulting.

Long-term memory retrieval will return nothing until the consolidation job (below,
still unbuilt) has actually promoted something into it -- expected early on, not a
bug.

## WebXR scene shell (Phase 2)

`web/` is a separate Vite project (different runtime target than the Node backend
above -- browser vs. server). Run it with:

```sh
cd web
npm install
npm run dev
```

Open the printed local URL in a browser -- no headset or install required, it
renders as a normal 3D scene. On a WebXR-capable browser/headset (e.g. Quest
Browser reaching this machine over the network via the printed "Network" URL),
the "ENTER VR" button becomes active.

Design, matching the build plan's Phase 2 intent:

- **Open expanse, not a room**: no walls or ceiling. A sparse field of points
  (`web/src/scene/environment.ts`) extends to the horizon with fog softening the
  edges instead of hard geometry.
- **Memory load -> geometry/particle density**: `Environment.setMemoryLoad(0..1)`
  scales how many of the field's points are drawn.
- **Retrieval state -> light/color**: `Environment.setRetrievalCoherence(0..1)` and
  `Presence.setCoherence(0..1)` shift ambient light and presence color between cold
  scattered blue and warm coherent gold.
- **Humanoid avatars for both**: Sophie (`web/src/scene/ansuzAvatar.ts`, Mixamo X
  Bot reskinned with a translucent fresnel-glow `ShaderMaterial`,
  `web/src/materials/glowMaterial.ts`) and Ryleigh (`web/src/scene/ryleighAvatar.ts`,
  Avaturn export). `presence.ts` no longer renders a body -- it originally did (a
  point cloud), superseded by Sophie's avatar per the build plan's Phase 2; it now
  only provides the ambient `PointLight` it always carried, still coherence-driven.

`web/src/main.ts` currently drives memory load and coherence with a slow sine
oscillation so the effect is visible before real data exists -- that's a
placeholder for Phase 3/4, which will feed it actual short-term memory volume and
retrieval-similarity scores over the WebSocket instead.

## BMDC — Byte Me Dev Crew

An adaptive, self-replicating sales crew running on this repo's memory backend:
three agents (manager, market researcher, social) that find market gaps, price
offers, run SMS outreach through Twilio, and close through Stripe. Its learnings
go into the same `long_term_memory` store Sophie uses, so the crew starts each
cycle from what the last one found out.

```sh
npm run bmdc -- seed                 # create the founding three agents
npm run bmdc -- cycle --dry-run      # plan + draft without sending anything
npm run bmdc -- status               # roster, gaps, campaigns, revenue
```

Needs `supabase/migrations/0002_bmdc_crew.sql` applied and the BMDC block in
`.env` filled in. Full setup, the adapt loop, the replication caps, and the
consent model: **[docs/bmdc.md](docs/bmdc.md)**.

## BMDC Receptionist

The crew's agents split out and pointed at a phone line: answers calls 24/7,
books appointments, takes messages, escalates what a human should handle.
Sold separately from the crew, built on the same foundations.

```sh
npm run receptionist -- add smiles "Smiles Dental" +15551234567 America/Chicago
npm run receptionist -- hours smiles mon-fri 09:00 17:00
npm run receptionist -- slots smiles     # preview what a caller would hear
```

Double-booking is refused by a Postgres exclusion constraint rather than an
application check, so two callers racing for the same slot is resolved by the
database. Setup, the three safety guards, and per-business configuration:
**[docs/receptionist.md](docs/receptionist.md)**.

## Next steps

- Build the consolidation job (Edge Function or cron): summarize the short-term
  window, decide what gets promoted to long-term, call `prune_short_term_memory()`.
  Without this, `npm run chat` keeps working but long-term retrieval stays empty.
- Decide promotion criteria (what counts as "important enough" for `importance`).
- Exposed-joint/circuitry texture detail for Ansuz's avatar (modeling/texture
  authoring, not shader work -- no assets exist yet).
- Replace `web/src/main.ts`'s demo oscillation with real memory-state input.
- Phase 3: MediaPipe perception layer (WASM, client-side) streaming structured JSON
  over WebSocket into the scene.
- Phase 4+: self-improvement loop.

---

## Copyright

Copyright © 2026 **Byte Me Studios**. All rights reserved.
Ryleigh Maloy · Trey Maloy

Proprietary. See [`COPYRIGHT`](COPYRIGHT) for scope and terms.
