# Ansuz — status as of 2026-07-23

Snapshot written mid-session, right before a planned pause to think through the
realtime-voice architecture decision. Not a permanent doc — check git history /
README.md for anything that drifts from this over time.

## What's fully working and verified

**Backend / memory (Phase 0/1)**
- Supabase schema applied (`short_term_memory`, `long_term_memory`), service-role
  client wired, connection verified live (`npm run test:connection`).
- Conversation loop core (`src/conversation/loop.ts`, `npm run chat`): logs user
  message → embeds it (OpenRouter, `openai/text-embedding-3-small`) → retrieves
  relevant long-term memories → sends session history + context to
  `OPENROUTER_MODEL` → logs the reply. **Verified end-to-end with real data** —
  Supabase row counts confirmed before/after a real exchange.
- `scripts/server.ts`: local HTTP bridge exposing `/api/chat` and
  `/api/transcribe` so the browser (untrusted) can reach conversation-loop logic
  that holds real secrets, without those secrets ever reaching the browser.
  `web/vite.config.ts` proxies `/api` here — same-origin from the browser, so it
  works identically over `localhost` and the Quest's LAN URL with no CORS/cert
  wrangling.

**WebXR scene (Phase 2)**
- Both avatars grounded, animated, correctly scaled:
  - Ryleigh (`ryleighAvatar.ts`, Avaturn glb) — hidden from her own first-person
    XR camera via `three.js` layer 3 (NOT 1 or 2 — those are hardcoded
    reserved-for-controllers layers the XR camera always force-includes,
    regardless of app-level layer settings).
  - Ansuz (`ansuzAvatar.ts`, Mixamo X Bot + "Breathing Idle") — reskinned with
    a custom translucent fresnel rim-glow `ShaderMaterial`
    (`materials/glowMaterial.ts`, hand-written skinning-aware vertex shader)
    plus an internal spine/head `THREE.Points` glow. Both tied to the same
    `coherence` signal driving `environment.ts`. Stands where the old
    point-cloud "presence" used to be — that point cloud is retired;
    `presence.ts` now only keeps the ambient `PointLight` it always carried
    (repositioned overhead, was sitting inside Ansuz's chest before).
  - Missing from Ansuz's avatar: exposed-joint/circuitry texture detail
    (modeling/texture authoring — no assets exist).
- Thumbstick locomotion (`xr/locomotion.ts`) — moves a camera-parent `dolly`
  group since the XR system owns the camera's local transform directly.
  **User-confirmed working in-headset.**
- DOM overlay requested (`xr/xrSession.ts`) so HTML UI (voice status text,
  buttons) stays visible inside an immersive session — just added, unverified.

## What's built but not fully verified

**Voice pipeline** (mid-rebuild after `SpeechRecognition` turned out to be
unsupported in Meta Quest Browser — confirmed by on-device testing, and Wolvic
doesn't support it either per
[a Wolvic GitHub issue](https://github.com/Igalia/wolvic/issues/1443)):

- Current architecture: `getUserMedia`/`MediaRecorder` (browser, standard
  WebRTC, not the flaky Speech API) → `/api/transcribe` → Deepgram Nova-3 via
  OpenRouter (~$0.0043/min) → existing chat loop → `speechSynthesis` (browser
  TTS).
- Mic permission prompt **confirmed appearing** on the Quest — real progress,
  proves `getUserMedia` works where `SpeechRecognition` didn't.
- Full record → transcribe → reply round trip **not yet confirmed working
  in-headset**.
- TTS confirmed **not producing audible speech** on the desktop test machine —
  diagnosed as likely zero system TTS voices on this Linux dev box
  (`speechSynthesis.getVoices().length === 0`, confirmed via direct query) —
  separately, a real Chrome quirk exists where the "user activation" window
  needed for `speechSynthesis.speak()` can expire during the transcribe+chat
  async round trip. Both a defensive fix (`primeVoiceOutput()`, called
  synchronously on press) and error logging were added, but **neither
  confirmed fixed** — untested on the actual headset.
- User reported "text no voice" and "no audio captured [on quick taps]" — the
  latter is very likely just tap-vs-hold confusion (a real click is too fast to
  capture meaningful audio), not a bug.

## Explicitly not built at all

- **Consolidation job** — long-term memory stays empty until this exists.
  Single biggest remaining backend gap.
- **MediaPipe perception** (Phase 3) — Ansuz doesn't perceive Ryleigh's actual
  presence/movement; the scene only reacts to a placeholder sine-wave
  oscillator standing in for real memory-load/coherence data.
- **Self-improvement loop** (Phase 4+).
- **Realtime voice (OpenAI Realtime API)** — decision made this session (go
  with OpenAI, `gpt-realtime-2.1`, over Gemini Live or self-hosting Kyutai's
  Moshi on Hugging Face) but **not implemented**. This is where we paused.

## The open decision (why we stopped here)

OpenAI's Realtime API connects the browser directly to OpenAI via WebRTC after
an initial handshake — our backend relays the SDP offer/answer once (so the
real `OPENAI_API_KEY` never reaches the browser) but is **not in the audio path
after that**. That breaks the current per-turn "retrieve relevant memory, then
respond" pattern the text loop uses, since our backend never sees individual
turns once the call is live. Two options, not yet chosen:

1. Bake long-term memory into the realtime session's instructions once, at
   call start, no per-turn retrieval.
2. Have the browser report transcripts back to a logging-only endpoint after
   each turn, keeping memory *logging* intact even though retrieval isn't
   per-turn.

Given long-term memory is empty right now anyway (no consolidation job yet),
this matters less today than it will later — worth deciding deliberately
rather than defaulting into it.

## Costs / accounts

- **OpenRouter**: funded (~$11 total), currently used for chat completions,
  embeddings, and transcription (Deepgram Nova-3). `OPENROUTER_MODEL` is
  deliberately not defaulted in code — the build plan's Experiment Protocol
  calls for comparing persistent-memory behavior across models, so it's a
  per-run choice (currently set to `anthropic/claude-sonnet-5`).
- **OpenAI**: decision made to fund directly for the Realtime API. Account/key
  **not yet set up** as of this writing.
- **Hugging Face**: account connected (`Thatbtchryleigh`), unused so far.
  Kyutai's Moshi (open-weight audio-to-audio model) was scouted as an
  alternative to a managed realtime API but would mean self-hosting via
  Inference Endpoints (GPU-hour billing, real infra work), not a quick key
  swap — set aside in favor of OpenAI.

## Currently running (if you want to keep testing without me)

- Vite dev server: `https://localhost:5183` / `https://192.168.12.132:5183`
  (LAN, for the Quest)
- Chat server: `localhost:8787` (only reached via the Vite proxy, not exposed
  directly to the LAN)

## Bugs found and fixed this session (for the record)

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
  covers chat, embeddings, and transcription.
