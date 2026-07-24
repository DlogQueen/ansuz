/**
 * Raw PCM16 mic capture and streaming playback for xAI's Voice Agent
 * WebSocket -- it speaks linear16 samples over JSON events, not a container
 * format, so MediaRecorder (webm/opus, used by recorder.ts for the batch
 * Groq pipeline) doesn't fit here. ScriptProcessorNode is deprecated but
 * still universally supported (including Quest Browser's Chromium) and is
 * far simpler than an AudioWorklet module for this size of task.
 */
export interface PcmCapture {
  /** Actual sample rate the capture context ended up at -- tell the server this, don't assume the requested rate was honored. */
  sampleRate: number;
  stop(): void;
}

export function startPcmCapture(stream: MediaStream, onChunk: (base64Pcm16: string) => void): PcmCapture {
  const audioCtx = new AudioContext({ sampleRate: 24000 });
  const source = audioCtx.createMediaStreamSource(stream);
  const processor = audioCtx.createScriptProcessor(4096, 1, 1);

  // onaudioprocess only fires while the node is part of a connected graph
  // reaching the destination -- route through a silent gain so we don't
  // also echo the mic straight back out of the speakers.
  const silentGain = audioCtx.createGain();
  silentGain.gain.value = 0;
  source.connect(processor);
  processor.connect(silentGain);
  silentGain.connect(audioCtx.destination);

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const pcm16 = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const sample = Math.max(-1, Math.min(1, input[i]));
      pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    onChunk(int16ToBase64(pcm16));
  };

  return {
    sampleRate: audioCtx.sampleRate,
    stop() {
      processor.onaudioprocess = null;
      processor.disconnect();
      source.disconnect();
      silentGain.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      void audioCtx.close();
    },
  };
}

/** Streaming playback queue for response.output_audio.delta chunks (base64 PCM16, 24kHz mono per xAI's default output format). */
export interface PcmPlayer {
  push(base64Pcm16: string): void;
  /** Drop any queued-but-not-yet-played audio, e.g. when the user interrupts. */
  reset(): void;
}

export function createPcmPlayer(): PcmPlayer {
  const audioCtx = new AudioContext({ sampleRate: 24000 });
  let nextStartTime = 0;

  return {
    push(base64Pcm16: string) {
      const bytes = base64ToBytes(base64Pcm16);
      const pcm16 = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
      const float32 = new Float32Array(pcm16.length);
      for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 0x8000;

      const buffer = audioCtx.createBuffer(1, float32.length, audioCtx.sampleRate);
      buffer.copyToChannel(float32, 0);

      const source = audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(audioCtx.destination);

      const startAt = Math.max(audioCtx.currentTime, nextStartTime);
      source.start(startAt);
      nextStartTime = startAt + buffer.duration;
    },
    reset() {
      nextStartTime = audioCtx.currentTime;
    },
  };
}

function int16ToBase64(pcm16: Int16Array): string {
  const bytes = new Uint8Array(pcm16.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
