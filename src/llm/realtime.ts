const REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
const REALTIME_MODEL = 'gpt-realtime-2.1';

/**
 * Relays a browser's WebRTC SDP offer to OpenAI's Realtime API and returns
 * the SDP answer. This is the only server involvement in a realtime voice
 * call -- once connected, audio flows directly between the browser and
 * OpenAI (peer-to-peer), NOT through this backend. That's why per-turn
 * memory retrieval (like the text loop does in conversation/loop.ts) isn't
 * possible here: the server only sees this one handshake, never the
 * individual turns after. `instructions` is baked in once, at call start,
 * instead -- see conversation/systemPrompt.ts.
 */
export async function relayRealtimeOffer(sdpOffer: string, instructions: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY must be set to start a realtime voice session.');
  }

  const form = new FormData();
  form.set('sdp', sdpOffer);
  form.set(
    'session',
    JSON.stringify({
      type: 'realtime',
      model: REALTIME_MODEL,
      instructions,
      audio: { output: { voice: 'marin' } },
    })
  );

  const response = await fetch(REALTIME_CALLS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!response.ok) {
    throw new Error(`OpenAI Realtime handshake failed (${response.status}): ${await response.text()}`);
  }

  return response.text();
}
