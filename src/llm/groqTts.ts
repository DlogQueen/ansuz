const GROQ_SPEECH_URL = 'https://api.groq.com/openai/v1/audio/speech';
// Free tier: 10 req/min, 3,600 tokens/day. "autumn" is one of Orpheus's
// female English voices per Groq's docs (console.groq.com/docs/text-to-speech/orpheus)
// -- matches Sophie's persona (systemPrompt.ts). Was "troy" (male) until
// 2026-07-23 -- a leftover placeholder from before her persona existed, never
// updated. Swap freely (autumn/diana/hannah are the other female options),
// no code change needed elsewhere since this is the only place it's chosen.
const ORPHEUS_MODEL = 'canopylabs/orpheus-v1-english';
const VOICE = 'autumn';

export async function synthesizeSpeechGroq(text: string): Promise<Buffer> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error('GROQ_API_KEY must be set to synthesize speech via Groq.');
  }

  const response = await fetch(GROQ_SPEECH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: ORPHEUS_MODEL,
      input: text,
      voice: VOICE,
      response_format: 'wav',
    }),
  });

  if (!response.ok) {
    throw new Error(`Groq TTS request failed (${response.status}): ${await response.text()}`);
  }

  return Buffer.from(await response.arrayBuffer());
}
