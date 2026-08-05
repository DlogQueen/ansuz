# Ansuz — status as of 2026-07-23 (updated same day, after the voice/avatar session)

Snapshot updated after a debug pass (Opus-reviewed) and cleanup on top of the
Phase 2 voice/avatar work. Not a permanent doc — check git history / README.md
for anything that drifts from this over time.

**2026-08-05 update:** the xAI/Groq voice pipeline described below (voice
section, and the "xAI voice" bug entries at the bottom) has been removed
entirely — xAI and Groq are no longer used anywhere in this project. Chat is
OpenRouter-only now, via a text panel in the web UI (`web/src/chat/`) with a
model dropdown fed by `GET /api/models`, replacing the old push-to-talk voice
button. Replies are spoken via on-device TTS (Kokoro-82M, `web/src/tts/`) --
no cloud TTS provider, runs entirely client-side. There is still no speech
*input* and no in-headset text entry — see README.md's "Talking to Sophie in
the browser" section for the current state. The rest of this file (memory
backend, WebXR scene, avatars) is unaffected and still accurate as of the
date above.

## What's fully working and verified

**Backend / memory (Phase 0/1)**
- Supabase schema applied (`short_term_memory`, `long_term_memory`), service-role
  client wired, connection verified live (`npm run test:connection`).
- Conversation loop core (`src/conversation/loop.ts`, `npm run chat`): logs user
  message → embeds it (OpenRouter, `openai/text-embedding-3-small`) → retrieves
  relevant long-term memories → sends session history + context to
  `OPENROUTER_MODEL` → logs the reply. **Verified end-to-end with real data** —
  Supabase row counts confirmed before/after a real exchange.
- `scripts/server.ts`: local HTTP bridge exposing `/api/chat`, `/api/transcribe`,
  `/api/tts`, `/api/voice-session`, `/api/consolidate`, `/api/log-turn`, and a
  `/api/perception` WebSocket, so the browser (untrusted) can reach
  server-side-only work without secrets ever reaching it. `web/vite.config.ts`
  proxies `/api` here — same-origin from the browser, works identically over
  `localhost` and the Quest's LAN URL with no CORS/cert wrangling.

**Voice (resolved, replaces the old "open decision" below)**
- xAI's Voice Agent API — **confirmed working live end-to-end in-browser**
  (typed message, real audio reply heard, transcript rendered). Ryleigh had $10
  already funded on xAI and pivoted here instead of OpenAI Realtime.
  `src/llm/xaiVoice.ts` mints ephemeral tokens server-side, `web/src/voice/
  xaiRealtimeVoice.ts` + `xaiVoiceUI.ts` are the active client path (wired into
  `main.ts`), `web/src/voice/pcmAudio.ts` hand-rolls PCM16 capture/playback
  since xAI's WS speaks raw linear16 JSON, not a container format.
- Groq (Whisper transcribe + Orpheus TTS) is the automatic fallback if xAI
  errors out (`voiceUI` batch path inside `xaiVoiceUI.ts`, `recorder.ts`,
  `chatClient.ts`) — same Sophie persona either way, just a different voice
  transport. Falling back is one-way for the rest of the page session (no
  auto-retry of xAI).
- **Two bugs found in a static/type-level debug pass (Opus) and fixed same
  day, never having shipped to a real session:**
  - `xaiRealtimeVoice.ts`: `release()` was a no-op while `press()` was still
    inside `await connect()` (capture not yet created), so a quick tap during
    a slow first connect left the mic streaming with nothing to stop it —
    hot mic until the *next* release, which then dumped the whole backlog as
    one oversized turn. Fixed with a `releasedDuringConnect` flag that
    `press()` checks once `connect()` resolves.
  - `pcmAudio.ts`: the playback `AudioContext` was never closed on any
    teardown path (disconnect, unexpected close, failed connect) — browsers
    cap concurrent contexts at ~6, so enough reconnects would eventually
    break voice for the rest of the page session. `PcmPlayer` now has a
    `close()`, called everywhere the player is torn down.
- **Dead code removed same pass** (zero importers, all leftovers from before
  the xAI decision): `web/src/voice/voiceUI.ts` (old Groq-only UI, superseded
  by the fallback path folded into `xaiVoiceUI.ts`), `realtimeVoice.ts` +
  `src/llm/realtime.ts` (OpenAI WebRTC client/relay, account never funded),
  `src/llm/transcription.ts` (Deepgram), `src/llm/piperTts.ts` (local TTS).
  The now-unreachable `/api/realtime-session` route and the dead
  `OPENAI_API_KEY` env var were removed too.

**WebXR scene (Phase 2)**
- Both avatars grounded, animated, correctly scaled:
  - Ryleigh (`ryleighAvatar.ts`, Avaturn glb) — hidden from her own first-person
    XR camera via `three.js` layer 3 (NOT 1 or 2 — those are hardcoded
    reserved-for-controllers layers the XR camera always force-includes,
    regardless of app-level layer settings).
  - Ansuz (`ansuzAvatar.ts`, Mixamo X Bot + "Breathing Idle") — reskinned with
    a custom translucent fresnel rim-glow `ShaderMaterial`
    (`materials/glowMaterial.ts`, hand-written skinning-aware vertex shader —
    **verified correct against three r185's internals**: `WebGLPrograms`/
    `WebGLProgram`/`WebGLRenderer` all key skinning support off
    `object.isSkinnedMesh`, independent of material type) plus an internal
    spine/head `THREE.Points` glow. Both tied to the same `coherence` signal
    driving `environment.ts`. Stands where the old point-cloud "presence"
    used to be — that point cloud is retired; `presence.ts` now only keeps
    the ambient `PointLight` it always carried.
  - Missing from Ansuz's avatar: exposed-joint/circuitry texture detail
    (modeling/texture authoring — no assets exist).
- Thumbstick locomotion (`xr/locomotion.ts`) — moves a camera-parent `dolly`
  group since the XR system owns the camera's local transform directly.
  **User-confirmed working in-headset.**
- Hand-tracking perception (`web/src/perception/handTracking.ts`,
  `perceptionUI.ts`) streams discrete gesture/appearance events over the
  `/api/perception` WebSocket, logged server-side with `role: 'perception'`.
  Client-side scaffolding is in and typechecks; not yet confirmed against a
  real headset session.

## Built but not yet verified end-to-end

- **Memory consolidation** (`src/memory/consolidation.ts`) — implemented:
  groups `short_term_memory` by session, summarizes idle-looking sessions via
  OpenRouter into `long_term_memory` (with an embedding), deletes the
  consolidated rows. Wired into `scripts/server.ts` on a 15-min interval plus
  an on-demand `/api/consolidate` (force-mode — see caution below). **Never
  actually run against real data yet** — this is now the biggest
  verification gap, not a build gap: long-term retrieval in the chat loop
  still has nothing to draw on until a real consolidation run is confirmed.
- `POST /api/consolidate` uses `force: true`, which skips the idle check and
  will consolidate + delete short-term rows for a session that's still
  actively mid-conversation. Fine to hit manually right after a test session;
  don't wire a client button to it without a guard.
- Environment/presence (`environment.ts`, `presence.ts`) still driven by a
  placeholder sine-wave oscillator in `main.ts`, not real memory-load/
  retrieval-coherence data — proves the visuals react to state changes, but
  isn't connected to anything real yet.

## Explicitly not built at all

- **MediaPipe perception feeding live per-turn context** — perception events
  are logged and reach memory via consolidation, but `conversation/loop.ts`
  only pulls `user`/`assistant` rows into the model's message history, so
  Sophie/Ansuz doesn't yet perceive Ryleigh's presence *during* a live turn.
- **Self-improvement loop** (Phase 4+).
- **Passthrough/AR (ARI)** — per Ryleigh's explicit reprioritization, this is
  the actual next milestone (ahead of further avatar/VR polish), not yet
  scoped into code at all.

## Costs / accounts

- **OpenRouter**: funded (~$11 total) — chat completions + embeddings
  (`openai/text-embedding-3-small`). `OPENROUTER_MODEL` deliberately not
  defaulted in code (currently `anthropic/claude-sonnet-5`) — the build
  plan's Experiment Protocol calls for comparing persistent-memory behavior
  across models.
- **Groq**: free tier — Whisper transcription + Orpheus TTS, the voice
  fallback path.
- **xAI**: funded ($10+) — Voice Agent API (`$0.05/min`), the active voice
  pipeline (`XAI_VOICE_AGENT_ID` points at Sophie's Voice Agent Builder
  persona).
- **Hugging Face**: account connected (`Thatbtchryleigh`), unused so far.
- OpenAI is no longer relevant to this project — the Realtime API path was
  removed as dead code; no account was ever funded for it.

## Bugs found and fixed (for the record)

- Ryleigh's avatar stuck in T-pose: Mixamo FBX exports carry an empty
  reference clip ("Take 001", 0 duration) ahead of the real animation — was
  blindly playing clip index 0.
- Avatar/floor height mismatch: `environment.ts`'s ground plane was at
  `y = -1.5` while the camera/presence convention was eye-height-1.6-above-
  floor-0 — avatars were rendering ~3m below the camera's natural sightline.
- Ryleigh visible to her own first-person XR camera despite layer-based
  hiding: picked layer 1, which `WebXRManager` hardcodes as always-visible
  (reserved for controller models) regardless of app camera settings — moved
  to layer 3.
- Ambient `PointLight` positioned inside Ansuz's chest (leftover from when
  that spot held the old point-cloud visual) — moved overhead.
- `scripts/chat.ts` REPL crashed with a raw stack trace on closed stdin
  (piped input ending, Ctrl+D) instead of exiting cleanly.
- Embeddings originally required a separate `OPENAI_API_KEY` — switched to
  OpenRouter's OpenAI-compatible `/embeddings` endpoint so one funded key
  covers chat and embeddings.
- xAI voice: `release()` no-op during in-flight `connect()` left the mic hot
  with no pending release to stop it (see "Voice (resolved)" above).
- xAI voice: `PcmPlayer`'s `AudioContext` leaked on every reconnect, capped
  at ~6 concurrent contexts in-browser (see "Voice (resolved)" above).
