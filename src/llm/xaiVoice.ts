const CLIENT_SECRETS_URL = 'https://api.x.ai/v1/realtime/client_secrets';

export interface VoiceSession {
  token: string;
  agentId: string;
  expiresAt: number;
}

/**
 * Mints a short-lived ephemeral token so the browser can open the realtime
 * WebSocket directly against xAI without ever seeing XAI_API_KEY. Unlike
 * OpenAI's WebRTC realtime API, this is a plain WebSocket --
 * wss://api.x.ai/v1/realtime?agent_id=... -- and the referenced
 * agent (Sophie, built in xAI's Voice Agent Builder console) already carries
 * its own instructions/voice/tools server-side; there's no session field to
 * push our own instructions into at connect time, confirmed against the live
 * API (agent config arrives unprompted as a `session.updated` event right
 * after connecting).
 */
export async function mintVoiceSession(): Promise<VoiceSession> {
  const apiKey = process.env.XAI_API_KEY;
  const agentId = process.env.XAI_VOICE_AGENT_ID;
  if (!apiKey) {
    throw new Error('XAI_API_KEY must be set to start a voice session.');
  }
  if (!agentId) {
    throw new Error('XAI_VOICE_AGENT_ID must be set to start a voice session.');
  }

  const response = await fetch(CLIENT_SECRETS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    // expires_after is the only mintable field -- session config (instructions,
    // voice, ...) can't be set here, only after the client connects.
    body: JSON.stringify({ expires_after: { seconds: 300 } }),
  });

  if (!response.ok) {
    throw new Error(`xAI ephemeral token request failed (${response.status}): ${await response.text()}`);
  }

  const data = (await response.json()) as { value: string; expires_at: number };
  return { token: data.value, agentId, expiresAt: data.expires_at };
}
