import * as THREE from 'three';
import { isRecordingSupported, createRecorder } from './recorder.js';
import { sendMessage, transcribe, speak } from './chatClient.js';

export interface VoiceUI {
  /** Call once per frame -- polls the XR controller trigger for push-to-talk. */
  update(): void;
}

// xr-standard gamepad mapping: button 0 is the trigger on both Touch
// controllers and most other XR controllers.
const TRIGGER_BUTTON_INDEX = 0;

/**
 * Push-to-talk voice UI: record -> transcribe (Deepgram via OpenRouter) ->
 * chat (conversation loop, OpenRouter) -> speak (Piper, local/free). Chosen
 * over OpenAI Realtime for now specifically to avoid opening a new paid
 * account -- everything here runs on what's already funded, or costs nothing
 * at all (Piper). realtimeVoice.ts still exists, unused, for whenever that
 * decision changes. On-screen button for desktop testing, XR controller
 * trigger for in-headset use; status text/button stay visible inside an
 * immersive session via the dom-overlay feature requested in xr/xrSession.ts.
 */
export function createVoiceUI(xr: THREE.WebXRManager): VoiceUI {
  const statusEl = document.createElement('div');
  statusEl.style.cssText = `
    position: fixed; bottom: 108px; left: 50%; transform: translateX(-50%);
    max-width: 80vw; color: #cfd8ff; font: 14px system-ui, sans-serif;
    text-align: center; pointer-events: none; text-shadow: 0 1px 4px black;
  `;
  document.body.appendChild(statusEl);
  const setStatus = (text: string) => {
    statusEl.textContent = text;
  };

  const supported = isRecordingSupported();
  if (!supported) {
    setStatus('Voice input not supported in this browser.');
  }

  let busy = false;

  const recorder = createRecorder((message) => setStatus(message));

  const press = () => {
    if (busy || !supported) return;
    setStatus('listening...');
    recorder.start();
  };

  const release = () => {
    if (!supported) return;
    busy = true;
    recorder
      .stop()
      .then(async (result) => {
        if (!result) {
          setStatus('No audio captured.');
          return;
        }
        setStatus('transcribing...');
        const transcript = await transcribe(result.base64, result.format);
        if (!transcript.trim()) {
          setStatus('Heard nothing.');
          return;
        }
        setStatus(`you: ${transcript}`);
        const reply = await sendMessage(transcript);
        setStatus(`ansuz: ${reply}`);
        await speak(reply);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setStatus(`Error: ${message}`);
        console.error('[voice] request failed:', error);
      })
      .finally(() => {
        busy = false;
      });
  };

  // Bottom-right, clear of VRButton's default bottom-center position.
  const button = document.createElement('button');
  button.textContent = supported ? 'Hold to talk' : 'Voice unavailable';
  button.disabled = !supported;
  button.style.cssText = `
    position: fixed; bottom: 24px; right: 24px;
    padding: 12px 24px; border-radius: 999px; border: 1px solid #cfd8ff88;
    background: #12172a; color: #cfd8ff; font: 14px system-ui, sans-serif;
    cursor: pointer;
  `;
  document.body.appendChild(button);

  button.addEventListener('mousedown', press);
  button.addEventListener('mouseup', release);
  button.addEventListener('mouseleave', release);
  button.addEventListener('touchstart', (event) => {
    event.preventDefault();
    press();
  });
  button.addEventListener('touchend', (event) => {
    event.preventDefault();
    release();
  });

  let triggerWasPressed = false;

  return {
    update() {
      const session = xr.getSession();
      if (!session) return;

      // Edge-detect on whether ANY controller's trigger is down, not
      // per-source -- with two input sources sharing one `triggerWasPressed`
      // flag, iterating both every frame while only one trigger was held
      // made the untouched controller's "not pressed" read flip the flag
      // back every frame, turning a single hold into a press()/release()
      // pair at frame rate. Found and fixed in xaiVoiceUI.ts's copy of this
      // same code on 2026-07-23; mirrored here since this file has the
      // identical bug.
      let anyPressed = false;
      for (const source of session.inputSources) {
        if (source.gamepad?.buttons[TRIGGER_BUTTON_INDEX]?.pressed) {
          anyPressed = true;
          break;
        }
      }
      if (anyPressed && !triggerWasPressed) press();
      if (!anyPressed && triggerWasPressed) release();
      triggerWasPressed = anyPressed;
    },
  };
}
