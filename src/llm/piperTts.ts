import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Local, free, no-account TTS via Piper (rhasspy/piper, MIT license) --
 * chosen over ElevenLabs/OpenAI specifically because it costs nothing ever,
 * not just "free tier": vendor/piper/piper/piper is a standalone binary
 * (Linux x86_64, downloaded from the project's GitHub releases), vendor/piper
 * /voices/en_US-lessac-medium.onnx is the voice model (from
 * hf.co/rhasspy/piper-voices). See .gitignore -- these are large downloaded
 * artifacts, not checked into the repo.
 *
 * Keeps ONE Piper process alive (--json-input mode) rather than spawning
 * fresh per request -- confirmed via direct testing that model load (1.6-5.7s
 * observed) only happens once this way, not per call. Requests are
 * serialized through a promise chain since Piper processes one JSON line at
 * a time; each writes {text, output_file} to its stdin and polls for that
 * file to appear. Inference itself still isn't instant on this hardware
 * (~3.7-4.2x real-time observed even warm) -- this fixes the repeated
 * model-load overhead, not raw synthesis speed.
 */
const PIPER_BIN = new URL('../../vendor/piper/piper/piper', import.meta.url).pathname;
const VOICE_MODEL = new URL(
  '../../vendor/piper/voices/en_US-lessac-medium.onnx',
  import.meta.url
).pathname;

let piperProcess: ChildProcessWithoutNullStreams | null = null;
let requestQueue: Promise<unknown> = Promise.resolve();

function getPiperProcess(): ChildProcessWithoutNullStreams {
  if (piperProcess) return piperProcess;

  const proc = spawn(PIPER_BIN, ['--model', VOICE_MODEL, '--json-input']);
  proc.on('exit', (code) => {
    console.error(`Piper process exited (code ${code}) -- will respawn on next request.`);
    if (piperProcess === proc) piperProcess = null;
  });
  proc.stderr.on('data', () => {}); // drained so the pipe never backs up; logs aren't needed here

  piperProcess = proc;
  return proc;
}

async function waitForFile(path: string, timeoutMs: number): Promise<Buffer> {
  const start = Date.now();
  for (;;) {
    try {
      const data = await readFile(path);
      if (data.length > 44) return data; // bigger than a bare WAV header -- has actual audio
    } catch {
      // not written yet
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for Piper output after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function synthesizeOne(text: string): Promise<Buffer> {
  const proc = getPiperProcess();
  const outputPath = join(tmpdir(), `piper-${randomUUID()}.wav`);

  proc.stdin.write(`${JSON.stringify({ text, output_file: outputPath })}\n`);

  try {
    return await waitForFile(outputPath, 30_000);
  } finally {
    await unlink(outputPath).catch(() => {});
  }
}

export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const result = requestQueue.then(() => synthesizeOne(text));
  // Keep the queue alive even if this request fails, so one bad request
  // doesn't wedge every request after it.
  requestQueue = result.catch(() => {});
  return result;
}
