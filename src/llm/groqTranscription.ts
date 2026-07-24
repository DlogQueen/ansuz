const GROQ_TRANSCRIPTIONS_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
// Free tier: 20 req/min, up to 28,800 audio seconds/day -- plenty for
// personal conversational use. whisper-large-v3-turbo over whisper-large-v3:
// faster, negligible accuracy loss for this use case.
const WHISPER_MODEL = 'whisper-large-v3-turbo';

export async function transcribeAudioGroq(base64Audio: string, format: string): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error('GROQ_API_KEY must be set to transcribe audio via Groq.');
  }

  const audioBuffer = Buffer.from(base64Audio, 'base64');
  const form = new FormData();
  form.set('model', WHISPER_MODEL);
  form.set('file', new Blob([audioBuffer], { type: `audio/${format}` }), `audio.${format}`);

  const response = await fetch(GROQ_TRANSCRIPTIONS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!response.ok) {
    throw new Error(`Groq transcription request failed (${response.status}): ${await response.text()}`);
  }

  const data = (await response.json()) as { text: string };
  return data.text;
}
