import 'dotenv/config';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer } from 'ws';
import { respond } from '../src/conversation/loop.js';
import { transcribeAudioGroq } from '../src/llm/groqTranscription.js';
import { synthesizeSpeechGroq } from '../src/llm/groqTts.js';
import { mintVoiceSession } from '../src/llm/xaiVoice.js';
import { logInteraction } from '../src/memory/shortTermMemory.js';
import { consolidateMemory } from '../src/memory/consolidation.js';
import {
  parseInboundMessage,
  twimlResponse,
  verifyTwilioSignature,
} from '../src/integrations/twilio.js';
import { verifyStripeSignature } from '../src/integrations/stripe.js';
import { handleInboundMessage, handleStripeEvent } from '../src/crew/pipeline.js';
import { runCycle } from '../src/crew/orchestrator.js';

/**
 * Small local HTTP bridge so the WebXR scene (browser, untrusted) can reach
 * server-side-only work: the conversation loop and turn logging (hold the
 * Supabase service-role key -- see src/lib/supabaseClient.ts's warning never
 * to import that into browser-facing code), transcription + TTS (hold
 * GROQ_API_KEY -- Whisper + Orpheus, fast and free-tier for personal use),
 * and xAI voice session token minting (holds XAI_API_KEY -- see
 * src/llm/xaiVoice.ts, this is the active voice pipeline), and a WebSocket
 * endpoint (/api/perception) ingesting MediaPipe hand-tracking
 * events from the browser. Not exposed to the LAN directly: web/vite.config.ts
 * proxies /api here so the browser only ever talks to Vite's own (HTTPS)
 * origin, same-origin, no separate cert or CORS needed.
 */
const PORT = process.env.CHAT_SERVER_PORT ? Number(process.env.CHAT_SERVER_PORT) : 8787;

async function readTextBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return JSON.parse(await readTextBody(req)) as T;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * The exact public URL Twilio was configured to call -- what its signature is
 * computed over. Derived from BMDC_PUBLIC_URL (the tunnel/domain Twilio points
 * at) rather than the Host header, since the header is attacker-controlled and
 * this value is half of a signature check.
 */
function publicUrlFor(path: string): string {
  const base = process.env.BMDC_PUBLIC_URL;
  if (!base) {
    throw new Error('BMDC_PUBLIC_URL must be set to verify Twilio webhook signatures.');
  }
  return `${base.replace(/\/$/, '')}${path}`;
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/chat') {
      const body = await readJsonBody<{ message: string; sessionId?: string }>(req);
      if (!body.message || typeof body.message !== 'string') {
        sendJson(res, 400, { error: 'message (string) is required' });
        return;
      }
      const reply = await respond({ message: body.message, sessionId: body.sessionId });
      sendJson(res, 200, { reply });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/transcribe') {
      const body = await readJsonBody<{ audio: string; format: string }>(req);
      if (!body.audio || !body.format) {
        sendJson(res, 400, { error: 'audio (base64 string) and format are required' });
        return;
      }
      const text = await transcribeAudioGroq(body.audio, body.format);
      sendJson(res, 200, { text });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/tts') {
      const body = await readJsonBody<{ text: string }>(req);
      if (!body.text) {
        sendJson(res, 400, { error: 'text is required' });
        return;
      }
      const audio = await synthesizeSpeechGroq(body.text);
      sendJson(res, 200, { audio: audio.toString('base64') });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/voice-session') {
      // Mints a token only -- the browser opens the WebSocket itself (mic +
      // playback have to live client-side). See src/llm/xaiVoice.ts.
      const session = await mintVoiceSession();
      sendJson(res, 200, session);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/consolidate') {
      // On-demand trigger (see the interval below for the automatic version)
      // -- handy right after a test session instead of waiting for it.
      const result = await consolidateMemory({ force: true });
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/log-turn') {
      const body = await readJsonBody<{
        role: 'user' | 'assistant';
        content: string;
        sessionId?: string;
      }>(req);
      if (!body.role || !body.content) {
        sendJson(res, 400, { error: 'role and content are required' });
        return;
      }
      await logInteraction({ role: body.role, content: body.content, sessionId: body.sessionId });
      sendJson(res, 200, { ok: true });
      return;
    }

    // ---- BMDC (Byte Me Dev Crew) -----------------------------------------
    // Both webhooks below verify provider signatures before touching any
    // state. These endpoints are publicly reachable by design (Twilio and
    // Stripe have to reach them), so the signature *is* the authentication --
    // an unverified request must never reach the crew's decision loop.

    if (req.method === 'POST' && req.url === '/api/twilio/inbound') {
      const raw = await readTextBody(req);
      const params = Object.fromEntries(new URLSearchParams(raw));

      const valid = verifyTwilioSignature({
        signature: req.headers['x-twilio-signature'] as string | undefined,
        url: publicUrlFor('/api/twilio/inbound'),
        body: params,
      });
      if (!valid) {
        console.warn('[bmdc] rejected inbound message with an invalid Twilio signature.');
        res.writeHead(403);
        res.end();
        return;
      }

      const inbound = parseInboundMessage(params);
      const result = await handleInboundMessage(inbound);
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(twimlResponse(result.reply ?? undefined));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/stripe/webhook') {
      // Stripe signs the raw bytes -- parsing and re-serializing would break
      // verification, so the raw string is what gets passed through.
      const rawBody = await readTextBody(req);
      let event;
      try {
        event = verifyStripeSignature({
          rawBody,
          signatureHeader: req.headers['stripe-signature'] as string | undefined,
        });
      } catch (error) {
        console.warn('[bmdc] rejected Stripe webhook:', error instanceof Error ? error.message : error);
        res.writeHead(400);
        res.end();
        return;
      }

      const result = await handleStripeEvent(event);
      sendJson(res, 200, { received: true, handled: result.handled });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/bmdc/cycle') {
      const result = await runCycle();
      sendJson(res, 200, result);
      return;
    }

    res.writeHead(404);
    res.end();
  } catch (error) {
    console.error('Chat server error:', error instanceof Error ? error.message : error);
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, () => {
  console.log(`Ansuz chat server listening on http://localhost:${PORT}`);
});

// Perception ingest (Phase 3, see web/src/perception/handTracking.ts): the
// browser reduces MediaPipe hand tracking to discrete events client-side and
// streams them here over a WebSocket (README's stated IBI pattern --
// MediaPipe in-browser -> WebSocket -> structured JSON, not raw video/
// landmarks). Logged with role='perception' -- short_term_memory already had
// this role reserved for exactly this. Not yet wired into the *live*
// per-turn chat context (conversation/loop.ts only pulls 'user'/'assistant'
// rows into the model's message history) -- perception currently reaches
// Sophie/Ansuz's memory only via consolidation summarizing it alongside
// whatever conversation happened in the same session.
interface PerceptionEventMessage {
  type: 'hand_appeared' | 'hand_gone' | 'gesture_changed' | 'wave_detected';
  gesture?: string;
  handedness?: string;
  sessionId?: string;
}

function describePerceptionEvent(event: PerceptionEventMessage): string {
  switch (event.type) {
    case 'hand_appeared':
      return "Ryleigh's hand became visible to the camera.";
    case 'hand_gone':
      return "Ryleigh's hand left the camera's view.";
    case 'gesture_changed':
      return `Ryleigh's${event.handedness ? ` ${event.handedness.toLowerCase()}` : ''} hand is making a ${event.gesture ?? 'unknown'} gesture.`;
    case 'wave_detected':
      return `Ryleigh waved${event.handedness ? ` with her ${event.handedness.toLowerCase()} hand` : ''}.`;
    default:
      return `Unrecognized perception event: ${JSON.stringify(event)}`;
  }
}

const perceptionServer = new WebSocketServer({ server, path: '/api/perception' });
perceptionServer.on('connection', (socket) => {
  socket.on('message', (raw) => {
    let event: PerceptionEventMessage;
    try {
      event = JSON.parse(raw.toString()) as PerceptionEventMessage;
    } catch (error) {
      console.error('[perception] malformed event:', error instanceof Error ? error.message : error);
      return;
    }
    logInteraction({
      role: 'perception',
      content: describePerceptionEvent(event),
      sessionId: event.sessionId,
      metadata: { gesture: event.gesture, handedness: event.handedness },
    }).catch((error) => {
      console.error('[perception] failed to log event:', error instanceof Error ? error.message : error);
    });
  });
});

// Consolidation job (see src/memory/consolidation.ts): while this server is
// up, periodically fold finished sessions from short_term_memory into
// long_term_memory summaries. Runs idle-session-only (not `force`) so it
// never cuts off a conversation that's still happening. A failed run logs
// and retries next interval rather than crashing the server.
const CONSOLIDATION_INTERVAL_MS = 15 * 60 * 1000;
setInterval(() => {
  consolidateMemory()
    .then((result) => {
      if (result.sessionsConsolidated > 0) {
        console.log(
          `[consolidation] folded ${result.sessionsConsolidated} session(s), ${result.entriesConsolidated} entries into long-term memory.`
        );
      }
      if (result.sessionsFailed > 0) {
        console.error(`[consolidation] ${result.sessionsFailed} session(s) failed this run, will retry next interval.`);
      }
    })
    .catch((error) => {
      console.error('[consolidation] run failed:', error instanceof Error ? error.message : error);
    });
}, CONSOLIDATION_INTERVAL_MS);

// BMDC's adapt loop, off unless BMDC_CYCLE_MINUTES is set. Default-off on
// purpose: a cycle spends model credits and sends real messages to real
// people, so running it has to be something you turned on, not something that
// started happening because you booted the server.
const cycleMinutes = Number(process.env.BMDC_CYCLE_MINUTES ?? 0);
if (Number.isFinite(cycleMinutes) && cycleMinutes > 0) {
  console.log(`[bmdc] adapt loop enabled — one cycle every ${cycleMinutes} minute(s).`);
  setInterval(() => {
    runCycle()
      .then((result) => {
        console.log(
          `[bmdc] cycle ${result.cycleId}: ${result.campaignsLaunched} campaign(s), ` +
            `${result.messagesSent} message(s) sent. ${result.assessment}`
        );
        if (result.errors.length > 0) console.error('[bmdc] cycle errors:', result.errors.join('; '));
      })
      .catch((error) => {
        console.error('[bmdc] cycle failed:', error instanceof Error ? error.message : error);
      });
  }, cycleMinutes * 60 * 1000);
}
