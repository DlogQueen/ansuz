import type { KokoroTTS as KokoroTTSType } from 'kokoro-js';

/**
 * On-device, low-latency TTS via Kokoro-82M (ONNX, run 100% client-side with
 * transformers.js/onnxruntime-web) -- replaces the old Groq/Orpheus cloud TTS
 * pipeline (removed). No server round-trip once the model's loaded, no API
 * key, no per-request cost.
 *
 * "wasm" over "webgpu": broader compatibility is the priority here (this app
 * targets Quest Browser, whose WebGPU support isn't reliable) -- same
 * reasoning as picking MediaRecorder over the Web Speech API elsewhere in
 * this project. "q8" dtype: quantized weights (~90MB vs fp32's ~320MB) with
 * negligible quality loss for conversational speech.
 */
const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
// "af_heart" is Kokoro's flagship/highest-graded American-female voice --
// closest fit to Sophie's persona (systemPrompt.ts: a woman in her 30s).
// Overridable per call via the voice picker in chat/chatUI.ts.
export const DEFAULT_VOICE = 'af_heart';

/**
 * Kokoro's built-in voices, grouped for the picker. Prefix encodes
 * accent+gender: a=American, b=British; f=female, m=male. Grades are
 * Kokoro's own quality ratings -- af_heart and af_bella are the strongest.
 */
export const VOICE_GROUPS: ReadonlyArray<{ label: string; voices: ReadonlyArray<{ id: string; name: string }> }> = [
  {
    label: 'American — female',
    voices: [
      { id: 'af_heart', name: 'Heart (best quality)' },
      { id: 'af_bella', name: 'Bella (high quality)' },
      { id: 'af_nicole', name: 'Nicole (soft/ASMR)' },
      { id: 'af_aoede', name: 'Aoede' },
      { id: 'af_kore', name: 'Kore' },
      { id: 'af_sarah', name: 'Sarah' },
      { id: 'af_nova', name: 'Nova' },
      { id: 'af_sky', name: 'Sky' },
      { id: 'af_alloy', name: 'Alloy' },
      { id: 'af_jessica', name: 'Jessica' },
      { id: 'af_river', name: 'River' },
    ],
  },
  {
    label: 'British — female',
    voices: [
      { id: 'bf_emma', name: 'Emma' },
      { id: 'bf_isabella', name: 'Isabella' },
      { id: 'bf_alice', name: 'Alice' },
      { id: 'bf_lily', name: 'Lily' },
    ],
  },
  {
    label: 'American — male',
    voices: [
      { id: 'am_michael', name: 'Michael' },
      { id: 'am_fenrir', name: 'Fenrir' },
      { id: 'am_puck', name: 'Puck' },
      { id: 'am_adam', name: 'Adam' },
      { id: 'am_echo', name: 'Echo' },
      { id: 'am_eric', name: 'Eric' },
      { id: 'am_liam', name: 'Liam' },
      { id: 'am_onyx', name: 'Onyx' },
      { id: 'am_santa', name: 'Santa' },
    ],
  },
  {
    label: 'British — male',
    voices: [
      { id: 'bm_george', name: 'George' },
      { id: 'bm_daniel', name: 'Daniel' },
      { id: 'bm_fable', name: 'Fable' },
      { id: 'bm_lewis', name: 'Lewis' },
    ],
  },
];

let ttsPromise: Promise<KokoroTTSType> | null = null;

// Dynamic import, not a static one: kokoro-js pulls in onnxruntime-web's full
// WASM runtime (~1MB+ of JS alone) -- eagerly bundling that into main.ts's
// entry chunk would make everyone pay for it on page load, even with the
// speak-replies toggle off. This way it's only fetched once TTS is actually
// engaged.
async function loadTts(onStatus?: (text: string) => void): Promise<KokoroTTSType> {
  if (!ttsPromise) {
    onStatus?.('loading voice model (first time only, ~90MB)...');
    ttsPromise = import('kokoro-js')
      .then(({ KokoroTTS }) => KokoroTTS.from_pretrained(MODEL_ID, { dtype: 'q8', device: 'wasm' }))
      .catch((error) => {
        ttsPromise = null; // let a later call retry instead of re-throwing this same rejection forever
        throw error;
      });
  }
  return ttsPromise;
}

/** Kicks off the model download/load without generating anything, so the first real speak() isn't the one paying for it. */
export function preloadKokoro(onStatus?: (text: string) => void): void {
  loadTts(onStatus).catch(() => {}); // load errors surface for real on the next speak() call
}

let currentAudio: HTMLAudioElement | null = null;

/** Generates and plays speech for `text`, cutting off whatever's currently playing (mirrors the old chatClient.speak() behavior). */
export async function speak(text: string, voice?: string, onStatus?: (text: string) => void): Promise<void> {
  const tts = await loadTts(onStatus);
  // Cast: kokoro-js types `voice` as a union of its voice keys, but the value
  // here comes from the picker (a plain string). VOICE_GROUPS above is the
  // authority on which ids are valid.
  const audio = await tts.generate(text, { voice: (voice ?? DEFAULT_VOICE) as never });
  const url = URL.createObjectURL(audio.toBlob());

  currentAudio?.pause();
  const element = new Audio(url);
  currentAudio = element;
  element.addEventListener('ended', () => URL.revokeObjectURL(url));
  await element.play();
}
