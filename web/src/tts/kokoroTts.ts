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
const VOICE = 'af_heart';

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
export async function speak(text: string, onStatus?: (text: string) => void): Promise<void> {
  const tts = await loadTts(onStatus);
  const audio = await tts.generate(text, { voice: VOICE });
  const url = URL.createObjectURL(audio.toBlob());

  currentAudio?.pause();
  const element = new Audio(url);
  currentAudio = element;
  element.addEventListener('ended', () => URL.revokeObjectURL(url));
  await element.play();
}
