import { startHandTracking, type HandTracking, type PerceptionEvent } from './handTracking.js';

export interface PerceptionUI {}

/**
 * Toggle button for hand-tracking perception (see handTracking.ts + the
 * WebSocket handler in scripts/server.ts). Off by default and opt-in via
 * button click, same as voice -- camera access needs a user gesture anyway,
 * and it shouldn't silently start capturing video.
 */
export function createPerceptionUI(): PerceptionUI {
  const statusEl = document.createElement('div');
  statusEl.style.cssText = `
    position: fixed; bottom: 156px; left: 50%; transform: translateX(-50%);
    max-width: 80vw; color: #a8ffcf; font: 13px system-ui, sans-serif;
    text-align: center; pointer-events: none; text-shadow: 0 1px 4px black;
  `;
  document.body.appendChild(statusEl);
  const setStatus = (text: string) => {
    statusEl.textContent = text;
  };

  const sessionId = crypto.randomUUID();
  let tracking: HandTracking | null = null;
  let ws: WebSocket | null = null;

  function sendEvent(event: PerceptionEvent): void {
    ws?.send(JSON.stringify({ ...event, sessionId }));
  }

  async function enable(): Promise<void> {
    if (tracking) return;
    setStatus('starting hand tracking...');
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${protocol}://${location.host}/api/perception`);
    tracking = await startHandTracking(sendEvent, (message) => setStatus(`Error: ${message}`));
    setStatus('perception on');
    button.textContent = 'Perception: on';
  }

  function disable(): void {
    tracking?.stop();
    tracking = null;
    ws?.close();
    ws = null;
    setStatus('perception off');
    button.textContent = 'Enable perception';
  }

  const button = document.createElement('button');
  button.textContent = 'Enable perception';
  button.style.cssText = `
    position: fixed; bottom: 24px; left: 24px;
    padding: 12px 24px; border-radius: 999px; border: 1px solid #a8ffcf88;
    background: #0d1f16; color: #a8ffcf; font: 14px system-ui, sans-serif;
    cursor: pointer;
  `;
  document.body.appendChild(button);

  button.addEventListener('click', () => {
    if (tracking) {
      disable();
    } else {
      enable().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setStatus(`Error: ${message}`);
        console.error('[perceptionUI] enable failed:', error);
      });
    }
  });

  return {};
}
