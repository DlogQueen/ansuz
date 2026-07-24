/**
 * Push-to-talk mic capture via getUserMedia + MediaRecorder -- standard
 * WebRTC APIs, not the Web Speech API's SpeechRecognition (confirmed
 * unsupported in Meta Quest Browser, and in Wolvic too). Audio is sent to
 * the backend for transcription -- see src/llm/groqTranscription.ts.
 */
export interface RecordingResult {
  base64: string;
  /** Container format extracted from the recorder's mimeType, e.g. "webm". */
  format: string;
}

export interface Recorder {
  start(): void;
  /** Resolves with the clip once the recorder finishes flushing, or null if nothing was captured. */
  stop(): Promise<RecordingResult | null>;
}

export function isRecordingSupported(): boolean {
  return Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined';
}

export function createRecorder(onError: (message: string) => void): Recorder {
  let stream: MediaStream | null = null;
  let mediaRecorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let stopWaiters: Array<(result: RecordingResult | null) => void> = [];

  async function ensureStream(): Promise<MediaStream> {
    if (stream) return stream;
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return stream;
  }

  return {
    start() {
      ensureStream()
        .then((activeStream) => {
          chunks = [];
          const recorder = new MediaRecorder(activeStream);
          mediaRecorder = recorder;

          recorder.ondataavailable = (event) => {
            if (event.data.size > 0) chunks.push(event.data);
          };
          recorder.onstop = async () => {
            const blob = new Blob(chunks, { type: recorder.mimeType });
            const base64 = await blobToBase64(blob);
            const format = blob.type.split('/')[1]?.split(';')[0] || 'webm';
            const result: RecordingResult = { base64, format };
            stopWaiters.forEach((resolve) => resolve(result));
            stopWaiters = [];
          };
          recorder.start();
        })
        .catch((error) => {
          onError(`Microphone access failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    },
    stop() {
      return new Promise((resolve) => {
        if (!mediaRecorder || mediaRecorder.state === 'inactive') {
          resolve(null);
          return;
        }
        stopWaiters.push(resolve);
        mediaRecorder.stop();
      });
    },
  };
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string; // "data:audio/webm;base64,XXXX"
      resolve(result.split(',')[1] ?? '');
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
