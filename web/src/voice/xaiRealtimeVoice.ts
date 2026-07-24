import { startPcmCapture, createPcmPlayer, type PcmCapture, type PcmPlayer } from './pcmAudio.js';

/**
 * xAI's Voice Agent API (realtime, WebSocket) -- talks to "Sophie", a persona
 * built in xAI's Voice Agent Builder console (XAI_VOICE_AGENT_ID). Her
 * instructions/voice/tools live server-side on xAI's account and load
 * automatically right after connecting (confirmed live: an unprompted
 * `session.updated` event arrives with her config before any client message
 * is even processed) -- we never send our own `instructions` here.
 *
 * Unlike OpenAI's WebRTC realtime API (realtimeVoice.ts), this is a plain
 * WebSocket carrying JSON events with base64 PCM16 audio, so mic capture and
 * playback are hand-rolled (see pcmAudio.ts) instead of using
 * RTCPeerConnection media tracks. The connection stays open across multiple
 * push-to-talk turns rather than reconnecting each time.
 */
export interface XaiRealtimeVoice {
  connect(): Promise<void>;
  disconnect(): void;
  isConnected(): boolean;
  /** Start streaming mic audio for one turn. */
  press(): Promise<void>;
  /** Stop streaming, commit the turn, and ask Sophie to respond. */
  release(): void;
}

interface XaiServerEvent {
  type: string;
  transcript?: string;
  delta?: string;
  [key: string]: unknown;
}

// Confirmed live (see xAI test transcripts from this build session) as
// routine bookkeeping we don't need to act on -- listed explicitly so the
// catch-all warning below stays a real signal instead of noise on every turn.
const KNOWN_BENIGN_EVENT_TYPES = new Set([
  'session.updated',
  'response.created',
  'response.output_item.added',
  'conversation.item.added',
  'response.content_part.added',
  'response.content_part.done',
  'response.output_audio.done',
  'response.output_item.done',
  'response.done',
  'ping',
  'input_audio_buffer.speech_started',
  'input_audio_buffer.speech_stopped',
  'input_audio_buffer.committed',
]);

export function createXaiRealtimeVoice(
  onStatus: (text: string) => void,
  onFatalError?: (message: string) => void
): XaiRealtimeVoice {
  let ws: WebSocket | null = null;
  let ready: Promise<void> | null = null;
  let capture: PcmCapture | null = null;
  let player: PcmPlayer | null = null;
  let pendingUserTranscript: string | null = null;
  const sessionId = crypto.randomUUID();

  // Persists across a page reload within the same tab (not across tabs/days
  // -- xAI itself drops session history after 30min idle anyway, so nothing
  // is lost by scoping this to sessionStorage). Without this, every
  // reconnect starts Sophie at a totally blank conversation with no memory
  // of what was just said -- caught live: "she's in a loop, repeating
  // herself" after a session that reconnected multiple times. Session
  // resumption (conversation_id + resumption.enabled) is documented on
  // xAI's Voice Agent API but wasn't wired up before this fix.
  const CONVERSATION_ID_KEY = 'xai-sophie-conversation-id';

  function logTurn(role: 'user' | 'assistant', content: string): void {
    fetch('/api/log-turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, content, sessionId }),
    }).catch((error) => console.error('[xaiRealtimeVoice] failed to log turn:', error));
  }

  function send(event: Record<string, unknown>): void {
    ws?.send(JSON.stringify(event));
  }

  function handleServerEvent(event: XaiServerEvent): void {
    switch (event.type) {
      case 'conversation.created': {
        const conversationId = (event.conversation as { id?: string } | undefined)?.id;
        if (conversationId) sessionStorage.setItem(CONVERSATION_ID_KEY, conversationId);
        return;
      }
      case 'response.output_audio.delta':
        if (event.delta) player?.push(event.delta);
        return;
      case 'response.output_audio_transcript.done':
        if (event.transcript) {
          onStatus(`sophie: ${event.transcript}`);
          // The user's turn logically finished right before Sophie's reply
          // did, so flush whatever their latest transcript was now.
          if (pendingUserTranscript) {
            logTurn('user', pendingUserTranscript);
            pendingUserTranscript = null;
          }
          logTurn('assistant', event.transcript);
        }
        return;
      // Confirmed live (2026-07-23): this is `.updated`, not the OpenAI-style
      // `.completed` guessed originally -- and it's incremental, firing
      // repeatedly with a growing transcript for the same item_id as speech
      // continues, not a single final event. So: update the live status
      // every time (cheap, good as a live caption), but only log once,
      // batched against the reply above -- logging on every `.updated` would
      // write several rows to short_term_memory per utterance.
      case 'conversation.item.input_audio_transcription.updated':
        if (event.transcript) {
          onStatus(`you: ${event.transcript}`);
          pendingUserTranscript = event.transcript as string;
        }
        return;
      case 'error': {
        console.error('[xaiRealtimeVoice] server error event:', event);
        const message = (event.error as { message?: string } | undefined)?.message ?? JSON.stringify(event).slice(0, 200);
        onStatus(`Error: ${message}`);
        onFatalError?.(message);
        return;
      }
      // Sophie's agent config (Voice Agent Builder) can have tools enabled --
      // if she calls one, the model turn just waits for a `function_call_output`
      // that this client never sent, forever, with no error anywhere (caught
      // live: "she went silent" asking if she could move, no exception in
      // any log -- consistent with exactly this, not a crash). We don't know
      // what tools, if any, her Builder config has, so we can't actually
      // fulfill a real call -- but we can stop the hang: tell her the tool
      // isn't available client-side and let her recover and respond in words
      // instead of waiting indefinitely.
      case 'response.function_call_arguments.done': {
        const callId = event.call_id as string | undefined;
        const name = event.name as string | undefined;
        console.warn('[xaiRealtimeVoice] function call requested but not implemented client-side:', event);
        if (callId) {
          send({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: callId,
              output: JSON.stringify({ error: `Tool "${name ?? 'unknown'}" is not available in this client.` }),
            },
          });
          send({ type: 'response.create' });
        }
        return;
      }
      default:
        // Catch-all so a genuinely unhandled event type shows up in logs
        // instead of silently doing nothing -- the gap that let the function-
        // call hang above go unnoticed in the first place. Known-harmless
        // bookkeeping events are excluded above so this stays a real signal.
        if (!KNOWN_BENIGN_EVENT_TYPES.has(event.type)) {
          console.warn('[xaiRealtimeVoice] unhandled server event type:', event.type, event);
        }
    }
  }

  async function connect(): Promise<void> {
    if (ready) return ready;

    // A failed attempt must clear `ready` (and `ws`) so the *next* press()
    // retries instead of forever re-throwing this same cached rejection --
    // caught live: after one rate-limit error, every subsequent trigger pull
    // silently hit the same dead promise with no visible retry.
    ready = attemptConnect().catch((error) => {
      ready = null;
      ws = null;
      onFatalError?.(error instanceof Error ? error.message : String(error));
      throw error;
    });

    return ready;
  }

  async function attemptConnect(): Promise<void> {
    onStatus('connecting to sophie...');
      const response = await fetch('/api/voice-session', { method: 'POST' });
      if (!response.ok) {
        throw new Error(`Voice session request failed (${response.status}): ${await response.text()}`);
      }
      const { token, agentId } = (await response.json()) as { token: string; agentId: string };

      player = createPcmPlayer();

      const storedConversationId = sessionStorage.getItem(CONVERSATION_ID_KEY);
      const wsUrl = storedConversationId
        ? `wss://api.x.ai/v1/realtime?agent_id=${agentId}&conversation_id=${storedConversationId}`
        : `wss://api.x.ai/v1/realtime?agent_id=${agentId}`;

      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(wsUrl, [`xai-client-secret.${token}`]);
        ws = socket;

        // First session.updated is Sophie's own config auto-loading -- wait
        // for it before declaring ready, so a press() right after connect()
        // doesn't race an in-progress agent-config load (seen live: doing so
        // gets the first response.create silently cancelled).
        let configLoaded = false;
        socket.addEventListener('message', (messageEvent) => {
          const parsed = JSON.parse(messageEvent.data) as XaiServerEvent;
          if (!configLoaded && parsed.type === 'session.updated') {
            configLoaded = true;
            // Explicit manual turn control -- push-to-talk, not server VAD.
            // resumption.enabled makes *this* conversation resumable on the
            // next reconnect (see conversation.created above, which captures
            // the id to actually use for that).
            send({
              type: 'session.update',
              session: { turn_detection: { type: null }, resumption: { enabled: true } },
            });
            onStatus(storedConversationId ? 'connected -- resuming where we left off' : 'connected -- hold to talk');
            resolve();
            return;
          }
          handleServerEvent(parsed);
        });

        socket.addEventListener('error', () => reject(new Error('xAI realtime WebSocket error')));
        socket.addEventListener('close', (closeEvent) => {
          onStatus('disconnected');
          if (!configLoaded) {
            reject(new Error(`xAI realtime WebSocket closed before ready (${closeEvent.code})`));
            return;
          }
          // Unexpected disconnect *after* a working session (session timeout,
          // server-side drop, etc) -- without this, `ready` stays a resolved
          // promise pointing at a dead socket, so the next press() thinks
          // it's still connected and silently sends into a closed WebSocket.
          // Same class of bug as the connect-failure case above, just at a
          // different point in the lifecycle.
          if (ws === socket) {
            ready = null;
            ws = null;
          }
        });
      });
  }

  function disconnect(): void {
    capture?.stop();
    capture = null;
    ws?.close();
    ws = null;
    ready = null;
    player = null;
    onStatus('disconnected');
  }

  let captureStartedAt = 0;

  async function press(): Promise<void> {
    await connect();
    if (capture) return;
    onStatus('listening...');
    player?.reset();
    const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    captureStartedAt = performance.now();
    capture = startPcmCapture(micStream, (base64Pcm16) => {
      send({ type: 'input_audio_buffer.append', audio: base64Pcm16 });
    });
    send({
      type: 'session.update',
      session: { audio: { input: { format: { type: 'audio/pcm', rate: capture.sampleRate } } } },
    });
  }

  // Structural guard, independent of whatever calls press()/release() --
  // a real bug in the caller once turned a single trigger hold into ~90
  // press/release pairs *per second*. No caller-side fix should be the only
  // thing standing between a bug like that and hammering a paid API, so this
  // floor exists here too: a hold shorter than this can't be a real
  // utterance, so it's dropped before ever reaching the network.
  const MIN_HOLD_MS = 150;

  function release(): void {
    if (!capture) return;
    const heldMs = performance.now() - captureStartedAt;
    capture.stop();
    capture = null;
    if (heldMs < MIN_HOLD_MS) {
      onStatus('connected -- hold to talk');
      return;
    }
    send({ type: 'input_audio_buffer.commit' });
    send({ type: 'response.create' });
    onStatus('thinking...');
  }

  return {
    connect,
    disconnect,
    isConnected: () => ws !== null,
    press,
    release,
  };
}
