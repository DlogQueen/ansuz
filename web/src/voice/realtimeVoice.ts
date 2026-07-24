/**
 * OpenAI Realtime API via WebRTC. Replaces the MediaRecorder -> transcribe ->
 * chat -> speak chain: this is one continuous audio-in/audio-out connection
 * instead of discrete request/response round trips, so it should feel far
 * less laggy than the batch pipeline it replaces.
 *
 * The backend only relays the initial SDP handshake (/api/realtime-session,
 * see scripts/server.ts) -- after that, audio flows directly between this
 * browser and OpenAI's servers. Because the backend isn't in the audio path
 * per-turn, transcripts are reported back here, after the fact, to
 * /api/log-turn purely for persistence (see src/llm/realtime.ts for why
 * per-turn memory *retrieval* isn't possible in this architecture).
 */
export interface RealtimeVoice {
  connect(): Promise<void>;
  disconnect(): void;
  isConnected(): boolean;
}

interface RealtimeServerEvent {
  type: string;
  transcript?: string;
  [key: string]: unknown;
}

export function createRealtimeVoice(onStatus: (text: string) => void): RealtimeVoice {
  let pc: RTCPeerConnection | null = null;
  let dc: RTCDataChannel | null = null;
  let micStream: MediaStream | null = null;
  const sessionId = crypto.randomUUID();

  function logTurn(role: 'user' | 'assistant', content: string): void {
    fetch('/api/log-turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, content, sessionId }),
    }).catch((error) => console.error('[realtimeVoice] failed to log turn:', error));
  }

  function handleServerEvent(event: RealtimeServerEvent): void {
    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      if (event.transcript) {
        onStatus(`you: ${event.transcript}`);
        logTurn('user', event.transcript);
      }
      return;
    }

    if (event.type === 'response.output_audio_transcript.done') {
      if (event.transcript) {
        onStatus(`ansuz: ${event.transcript}`);
        logTurn('assistant', event.transcript);
      } else {
        // Unconfirmed exact field shape as of writing -- fail loudly rather
        // than silently drop the log, so this is easy to spot and fix.
        console.warn('[realtimeVoice] output transcript event had no `transcript` field:', event);
      }
      return;
    }

    if (event.type === 'error') {
      console.error('[realtimeVoice] server error event:', event);
      onStatus(`Error: ${JSON.stringify(event).slice(0, 200)}`);
    }
  }

  async function connect(): Promise<void> {
    if (pc) return;

    onStatus('connecting...');
    pc = new RTCPeerConnection();

    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    pc.ontrack = (event) => {
      audioEl.srcObject = event.streams[0];
    };

    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    pc.addTrack(micStream.getTracks()[0], micStream);

    dc = pc.createDataChannel('oai-events');
    dc.addEventListener('message', (event) => {
      try {
        handleServerEvent(JSON.parse(event.data));
      } catch (error) {
        console.error('[realtimeVoice] failed to parse server event:', error);
      }
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const response = await fetch('/api/realtime-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: offer.sdp,
    });

    if (!response.ok) {
      const errorText = await response.text();
      disconnect();
      throw new Error(`Realtime session request failed (${response.status}): ${errorText}`);
    }

    const answerSdp = await response.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

    onStatus('connected -- speak anytime');
  }

  function disconnect(): void {
    dc?.close();
    pc?.close();
    micStream?.getTracks().forEach((track) => track.stop());
    pc = null;
    dc = null;
    micStream = null;
    onStatus('disconnected');
  }

  return {
    connect,
    disconnect,
    isConnected: () => pc !== null,
  };
}
