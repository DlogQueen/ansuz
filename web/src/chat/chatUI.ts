import { sendMessage, fetchModels } from './api.js';
import { preloadKokoro, speak } from '../tts/kokoroTts.js';

export interface ChatUI {
  /** Currently selected OpenRouter model slug, e.g. for display elsewhere. */
  getModel(): string;
}

// Persists the last model picked, and the speak-replies toggle, across
// reloads within this browser -- otherwise every page load would silently
// fall back to the server's OPENROUTER_MODEL default / re-enable voice.
const MODEL_STORAGE_KEY = 'ansuz-openrouter-model';
const SPEAK_STORAGE_KEY = 'ansuz-speak-replies';

/**
 * Text chat UI: model dropdown (populated live from OpenRouter's catalog via
 * GET /api/models) + a scrollback log + an input/send row. Replaces the old
 * xAI/Groq voice pipeline (removed -- OpenRouter has no speech transport, so
 * this is text-only; there's no in-headset text entry method yet, so this UI
 * is desktop/browser-testing only for now, same as OrbitControls in main.ts).
 */
export function createChatUI(): ChatUI {
  const container = document.createElement('div');
  container.style.cssText = `
    position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
    width: min(560px, 90vw); display: flex; flex-direction: column; gap: 6px;
    font: 14px system-ui, sans-serif; color: #cfd8ff;
  `;
  document.body.appendChild(container);

  const modelRow = document.createElement('div');
  modelRow.style.cssText = 'display: flex; align-items: center; gap: 8px;';
  const modelLabel = document.createElement('label');
  modelLabel.textContent = 'model:';
  modelLabel.style.cssText = 'opacity: 0.8; white-space: nowrap;';
  const modelSelect = document.createElement('select');
  modelSelect.style.cssText = `
    flex: 1; background: #12172a; color: #cfd8ff; border: 1px solid #cfd8ff55;
    border-radius: 6px; padding: 4px 8px; font: inherit;
  `;
  modelSelect.disabled = true;
  const loadingOption = document.createElement('option');
  loadingOption.textContent = 'loading models...';
  modelSelect.appendChild(loadingOption);
  modelRow.appendChild(modelLabel);
  modelRow.appendChild(modelSelect);

  const speakLabel = document.createElement('label');
  speakLabel.style.cssText = 'display: flex; align-items: center; gap: 4px; white-space: nowrap; cursor: pointer;';
  const speakCheckbox = document.createElement('input');
  speakCheckbox.type = 'checkbox';
  speakCheckbox.checked = localStorage.getItem(SPEAK_STORAGE_KEY) !== 'off';
  speakLabel.appendChild(speakCheckbox);
  speakLabel.appendChild(document.createTextNode('🔊 speak replies'));
  modelRow.appendChild(speakLabel);

  const log = document.createElement('div');
  log.style.cssText = `
    max-height: 30vh; overflow-y: auto; background: #12172acc;
    border-radius: 8px; padding: 8px 10px; display: none; flex-direction: column; gap: 4px;
  `;

  const inputRow = document.createElement('div');
  inputRow.style.cssText = 'display: flex; gap: 8px;';
  const textInput = document.createElement('input');
  textInput.type = 'text';
  textInput.placeholder = 'Say something to Sophie...';
  textInput.style.cssText = `
    flex: 1; background: #12172a; color: #cfd8ff; border: 1px solid #cfd8ff55;
    border-radius: 999px; padding: 10px 14px; font: inherit;
  `;
  const sendButton = document.createElement('button');
  sendButton.textContent = 'Send';
  sendButton.style.cssText = `
    padding: 10px 20px; border-radius: 999px; border: 1px solid #cfd8ff88;
    background: #12172a; color: #cfd8ff; font: inherit; cursor: pointer;
  `;
  inputRow.appendChild(textInput);
  inputRow.appendChild(sendButton);

  container.appendChild(modelRow);
  container.appendChild(log);
  container.appendChild(inputRow);

  function appendLine(text: string): void {
    log.style.display = 'flex';
    const line = document.createElement('div');
    line.textContent = text;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  fetchModels()
    .then((models) => {
      modelSelect.innerHTML = '';
      const stored = localStorage.getItem(MODEL_STORAGE_KEY);
      for (const model of models) {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = model.name;
        modelSelect.appendChild(option);
      }
      if (stored && models.some((model) => model.id === stored)) {
        modelSelect.value = stored;
      }
      modelSelect.disabled = false;
    })
    .catch((error) => {
      modelSelect.innerHTML = '';
      const errorOption = document.createElement('option');
      errorOption.textContent = 'model list unavailable';
      modelSelect.appendChild(errorOption);
      console.error('[chatUI] failed to load model list:', error);
      appendLine(`Couldn't load the model list: ${error instanceof Error ? error.message : String(error)}`);
    });

  modelSelect.addEventListener('change', () => {
    localStorage.setItem(MODEL_STORAGE_KEY, modelSelect.value);
  });

  // Warms up the on-device TTS model (kokoro-js, ~90MB first load) ahead of
  // the first reply that needs it, so that reply isn't the one paying the
  // download/init cost -- only if the user hasn't opted out.
  if (speakCheckbox.checked) preloadKokoro(appendLine);

  speakCheckbox.addEventListener('change', () => {
    localStorage.setItem(SPEAK_STORAGE_KEY, speakCheckbox.checked ? 'on' : 'off');
    if (speakCheckbox.checked) preloadKokoro(appendLine);
  });

  let busy = false;

  async function send(): Promise<void> {
    const message = textInput.value.trim();
    if (!message || busy || !modelSelect.value) return;

    busy = true;
    textInput.disabled = true;
    sendButton.disabled = true;
    textInput.value = '';
    appendLine(`you: ${message}`);

    try {
      const reply = await sendMessage(message, modelSelect.value);
      appendLine(`sophie: ${reply}`);
      if (speakCheckbox.checked) {
        speak(reply, appendLine).catch((error) => {
          console.error('[chatUI] speak failed:', error);
          appendLine(`Voice error: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    } catch (error) {
      appendLine(`Error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      busy = false;
      textInput.disabled = false;
      sendButton.disabled = false;
      textInput.focus();
    }
  }

  sendButton.addEventListener('click', () => void send());
  textInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void send();
  });

  return {
    getModel: () => modelSelect.value,
  };
}
