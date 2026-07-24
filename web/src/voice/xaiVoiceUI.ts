import * as THREE from 'three';
import { createXaiRealtimeVoice } from './xaiRealtimeVoice.js';
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
 * Push-to-talk against xAI's realtime Voice Agent API (xaiRealtimeVoice.ts),
 * with an automatic fallback to the Groq batch pipeline (record -> transcribe
 * -> chat -> speak, see recorder.ts/chatClient.ts) if xAI errors out (e.g.
 * the rate limit hit while testing this) -- both talk to the same character
 * now (see conversation/systemPrompt.ts: Sophie's actual persona, not a
 * placeholder "Ansuz"), so falling back doesn't mean switching who you're
 * talking to, just how her voice gets there. Once fallen back, stays on Groq
 * for the rest of the page session -- no auto-retry of xAI, since a rate
 * limit clearing is not something to guess at.
 */
export function createXaiVoiceUI(xr: THREE.WebXRManager): VoiceUI {
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

  let usingFallback = false;
  let fallbackBusy = false;
  const fallbackSupported = isRecordingSupported();
  const fallbackRecorder = createRecorder(setStatus);

  const voice = createXaiRealtimeVoice(setStatus, (message) => {
    if (usingFallback) return;
    usingFallback = true;
    voice.disconnect();
    setStatus(fallbackSupported ? `xAI unavailable (${message}) -- switched to backup voice` : `xAI unavailable (${message}), and no backup voice support`);
    button.textContent = 'Hold to talk (Sophie, backup)';
  });

  // Same structural floor as xaiRealtimeVoice.ts's MIN_HOLD_MS -- a hold
  // shorter than this can't be real speech, so it's dropped before it ever
  // reaches Groq. Belt-and-suspenders against the class of bug that turned
  // one trigger hold into 1256 requests (see xr trigger fix in update()).
  const MIN_HOLD_MS = 150;
  let fallbackRecording = false;
  let fallbackPressedAt = 0;

  function pressFallback(): void {
    if (fallbackBusy || fallbackRecording || !fallbackSupported) return;
    fallbackRecording = true;
    fallbackPressedAt = performance.now();
    setStatus('listening... (backup)');
    fallbackRecorder.start();
  }

  function releaseFallback(): void {
    if (!fallbackRecording || fallbackBusy || !fallbackSupported) return;
    fallbackRecording = false;
    const heldMs = performance.now() - fallbackPressedAt;
    if (heldMs < MIN_HOLD_MS) {
      fallbackRecorder.stop().catch(() => {});
      setStatus('Hold to talk (Sophie, backup)');
      return;
    }
    fallbackBusy = true;
    fallbackRecorder
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
        setStatus(`sophie: ${reply}`);
        await speak(reply);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setStatus(`Error: ${message}`);
        console.error('[xaiVoiceUI] fallback request failed:', error);
      })
      .finally(() => {
        fallbackBusy = false;
      });
  }

  const press = () => {
    if (usingFallback) {
      pressFallback();
      return;
    }
    voice.press().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[xaiVoiceUI] press failed:', error);
      if (!usingFallback) setStatus(`Error: ${message}`);
    });
  };

  const release = () => {
    if (usingFallback) {
      releaseFallback();
      return;
    }
    voice.release();
  };

  const button = document.createElement('button');
  button.textContent = 'Hold to talk (Sophie)';
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
      // per-source -- caught live: with two input sources sharing one
      // `triggerWasPressed` flag, iterating both every frame while only one
      // trigger was held made the untouched controller's "not pressed" read
      // immediately flip the flag back, so a single real hold produced a
      // press()/release() pair every frame (~90/sec) for the whole hold --
      // that's what actually sent 1256 requests in ~14 seconds, not sensor
      // noise. Same bug existed in voiceUI.ts; fixed there too.
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
