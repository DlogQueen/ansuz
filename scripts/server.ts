import 'dotenv/config';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer } from 'ws';
import { respond } from '../src/conversation/loop.js';
import { listModels } from '../src/llm/openrouter.js';
import { logInteraction } from '../src/memory/shortTermMemory.js';
import { consolidateMemory } from '../src/memory/consolidation.js';

/**
 * Small local HTTP bridge so the WebXR scene (browser, untrusted) can reach
 * server-side-only work: the conversation loop and turn logging (hold the
 * Supabase service-role key -- see src/lib/supabaseClient.ts's warning never
 * to import that into browser-facing code), the OpenRouter model catalog
 * (holds OPENROUTER_API_KEY -- see src/llm/openrouter.ts), and a WebSocket
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

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/chat') {
      const body = await readJsonBody<{ message: string; sessionId?: string; model?: string }>(req);
      if (!body.message || typeof body.message !== 'string') {
        sendJson(res, 400, { error: 'message (string) is required' });
        return;
      }
      const reply = await respond({ message: body.message, sessionId: body.sessionId, model: body.model });
      sendJson(res, 200, { reply });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/models') {
      const models = await listModels();
      sendJson(res, 200, { models });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/consolidate') {
      // On-demand trigger (see the interval below for the automatic version)
      // -- handy right after a test session instead of waiting for it.
      const result = await consolidateMemory({ force: true });
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
