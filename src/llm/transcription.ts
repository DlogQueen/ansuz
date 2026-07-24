const OPENROUTER_TRANSCRIPTIONS_URL = 'https://openrouter.ai/api/v1/audio/transcriptions';
// $0.0043/minute as of writing -- picked for cost, not quality; swap freely.
const TRANSCRIPTION_MODEL = 'deepgram/nova-3';

export async function transcribeAudio(base64Audio: string, format: string): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY must be set to transcribe audio.');
  }

  const response = await fetch(OPENROUTER_TRANSCRIPTIONS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: TRANSCRIPTION_MODEL,
      input_audio: { data: base64Audio, format },
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenRouter transcription request failed (${response.status}): ${await response.text()}`);
  }

  const data = (await response.json()) as { text: string };
  return data.text;
}
