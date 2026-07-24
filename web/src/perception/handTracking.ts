import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from '@mediapipe/tasks-vision';

/**
 * Client-side hand perception -- follows the README's stated IBI pattern
 * (MediaPipe in-browser -> WebSocket -> structured JSON, not raw video):
 * runs MediaPipe's Hand Landmarker on a getUserMedia camera feed and reduces
 * each frame to a small discrete *event* (hand appeared/gone, gesture
 * changed, wave detected) rather than streaming raw landmarks or video --
 * keeps bandwidth/log volume sane and gives the memory system something
 * actually worth summarizing later, not a landmark firehose.
 *
 * Model/WASM load from Google's CDN at runtime (standard MediaPipe Tasks
 * Vision usage, not bundled -- these are large binary assets).
 */
export type HandGesture = 'open_palm' | 'fist' | 'pointing' | 'unknown';

export interface PerceptionEvent {
  type: 'hand_appeared' | 'hand_gone' | 'gesture_changed' | 'wave_detected';
  gesture?: HandGesture;
  handedness?: 'Left' | 'Right';
}

export interface HandTracking {
  stop(): void;
}

const WASM_BASE_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const SAMPLE_INTERVAL_MS = 150; // ~6-7fps -- gesture/wave detection doesn't need full framerate
const WAVE_WINDOW_MS = 1500;
const WAVE_MIN_DIRECTION_CHANGES = 3;
const WAVE_MIN_AMPLITUDE = 0.08; // normalized image-space x, roughly a hand-width

export async function startHandTracking(
  onEvent: (event: PerceptionEvent) => void,
  onError: (message: string) => void
): Promise<HandTracking> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE_URL);
  const landmarker = await HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numHands: 1,
  });

  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  await video.play();

  let handPresent = false;
  let lastGesture: HandGesture | null = null;
  const wristXHistory: Array<{ t: number; x: number }> = [];

  const intervalId = window.setInterval(() => {
    try {
      const result = landmarker.detectForVideo(video, performance.now());
      handleResult(result);
    } catch (error) {
      onError(`Hand tracking inference failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, SAMPLE_INTERVAL_MS);

  function handleResult(result: HandLandmarkerResult): void {
    const hasHand = result.landmarks.length > 0;

    if (hasHand !== handPresent) {
      handPresent = hasHand;
      onEvent({ type: hasHand ? 'hand_appeared' : 'hand_gone' });
      if (!hasHand) {
        lastGesture = null;
        wristXHistory.length = 0;
        return;
      }
    }
    if (!hasHand) return;

    const landmarks = result.landmarks[0];
    const handedness = (result.handedness[0]?.[0]?.categoryName as 'Left' | 'Right' | undefined) ?? undefined;

    const gesture = classifyGesture(landmarks);
    if (gesture !== lastGesture) {
      lastGesture = gesture;
      onEvent({ type: 'gesture_changed', gesture, handedness });
    }

    trackWave(landmarks[0].x, handedness);
  }

  function trackWave(wristX: number, handedness?: 'Left' | 'Right'): void {
    const now = performance.now();
    wristXHistory.push({ t: now, x: wristX });
    while (wristXHistory.length > 0 && now - wristXHistory[0].t > WAVE_WINDOW_MS) wristXHistory.shift();
    if (wristXHistory.length < 6) return;

    let directionChanges = 0;
    let prevDelta = 0;
    let minX = wristXHistory[0].x;
    let maxX = wristXHistory[0].x;
    for (let i = 1; i < wristXHistory.length; i++) {
      const delta = wristXHistory[i].x - wristXHistory[i - 1].x;
      if (prevDelta !== 0 && Math.sign(delta) !== Math.sign(prevDelta) && Math.abs(delta) > 0.005) {
        directionChanges += 1;
      }
      if (delta !== 0) prevDelta = delta;
      minX = Math.min(minX, wristXHistory[i].x);
      maxX = Math.max(maxX, wristXHistory[i].x);
    }

    if (directionChanges >= WAVE_MIN_DIRECTION_CHANGES && maxX - minX >= WAVE_MIN_AMPLITUDE) {
      onEvent({ type: 'wave_detected', handedness });
      wristXHistory.length = 0; // debounce -- don't re-fire on the same swing
    }
  }

  return {
    stop() {
      window.clearInterval(intervalId);
      stream.getTracks().forEach((track) => track.stop());
      landmarker.close();
    },
  };
}

// MediaPipe hand landmark indices: 0=wrist, 5/9/13/17=index/middle/ring/pinky
// MCP joints, 8/12/16/20=fingertips, 4=thumb tip, 2=thumb MCP.
function classifyGesture(landmarks: Array<{ x: number; y: number }>): HandGesture {
  const wrist = landmarks[0];
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y);

  const fingers: Array<[tip: number, mcp: number]> = [
    [8, 5],
    [12, 9],
    [16, 13],
    [20, 17],
  ];
  // A finger counts as "extended" when its tip is meaningfully farther from
  // the wrist than its own base knuckle -- orientation-agnostic (no assumed
  // "up" direction), unlike a plain y-coordinate comparison.
  const extended = fingers.filter(([tip, mcp]) => dist(landmarks[tip], wrist) > dist(landmarks[mcp], wrist) * 1.15);
  const thumbExtended = dist(landmarks[4], wrist) > dist(landmarks[2], wrist) * 1.15;

  if (extended.length >= 3 && thumbExtended) return 'open_palm';
  if (extended.length === 0 && !thumbExtended) return 'fist';
  if (extended.length === 1 && extended[0][0] === 8) return 'pointing';
  return 'unknown';
}
