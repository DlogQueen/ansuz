/**
 * Talks to scripts/server.ts via Vite's /api proxy (see vite.config.ts) --
 * same-origin from the browser, so this works identically over localhost and
 * over the Quest's LAN URL with no CORS setup.
 */
const sessionId = crypto.randomUUID();

// Tracks whatever's currently playing so a new reply always cuts off the
// previous one instead of overlapping it -- caught live: a burst of rapid
// requests (see xaiVoiceUI.ts's press/release fix) queued several replies
// back to back, and with nothing stopping the previous Audio element, they
// all played at once ("how many are talking").
let currentAudio: HTMLAudioElement | null = null;

export async function sendMessage(message: string): Promise<string> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sessionId }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({ error: response.statusText }))) as {
      error?: string;
    };
    throw new Error(body.error ?? `Chat request failed (${response.status})`);
  }

  const data = (await response.json()) as { reply: string };
  return data.reply;
}

export async function transcribe(base64Audio: string, format: string): Promise<string> {
  const response = await fetch('/api/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio: base64Audio, format }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({ error: response.statusText }))) as {
      error?: string;
    };
    throw new Error(body.error ?? `Transcription request failed (${response.status})`);
  }

  const data = (await response.json()) as { text: string };
  return data.text;
}

/** Fetches Groq/Orpheus-synthesized speech (src/llm/groqTts.ts) and plays it. */
export async function speak(text: string): Promise<void> {
  const response = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({ error: response.statusText }))) as {
      error?: string;
    };
    throw new Error(body.error ?? `TTS request failed (${response.status})`);
  }

  const data = (await response.json()) as { audio: string };
  const binary = atob(data.audio);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);

  currentAudio?.pause();
  const audio = new Audio(url);
  currentAudio = audio;
  audio.addEventListener('ended', () => URL.revokeObjectURL(url));
  await audio.play();
}
