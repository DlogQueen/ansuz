import { injectWraithStyles } from './styles.js';

export interface Hud {
  setPrompt(text: string | null): void;
  setProgress(progress: number | null): void;
  setCorners(topLeft: string, topRight: string): void;
  flashAlert(): void;
  dispose(): void;
}

export function mountHud(root: HTMLElement): Hud {
  injectWraithStyles();

  const hud = document.createElement('div');
  hud.className = 'wr-hud';

  const crosshair = document.createElement('div');
  crosshair.className = 'wr-crosshair';
  hud.appendChild(crosshair);

  const prompt = document.createElement('div');
  prompt.className = 'wr-prompt';
  hud.appendChild(prompt);

  const scanbar = document.createElement('div');
  scanbar.className = 'wr-scanbar';
  scanbar.style.display = 'none';
  const scanFill = document.createElement('div');
  scanFill.className = 'wr-scanbar-fill';
  scanbar.appendChild(scanFill);
  hud.appendChild(scanbar);

  const topLeft = document.createElement('div');
  topLeft.className = 'wr-corner wr-topleft';
  hud.appendChild(topLeft);

  const topRight = document.createElement('div');
  topRight.className = 'wr-corner wr-topright';
  hud.appendChild(topRight);

  const alert = document.createElement('div');
  alert.className = 'wr-alert';
  hud.appendChild(alert);

  root.appendChild(hud);

  let alertTimeout = 0;

  function setPrompt(text: string | null) {
    prompt.textContent = text ?? '';
  }

  function setProgress(progress: number | null) {
    if (progress === null) {
      scanbar.style.display = 'none';
      return;
    }
    scanbar.style.display = 'block';
    scanFill.style.width = `${Math.round(progress * 100)}%`;
  }

  function setCorners(tl: string, tr: string) {
    topLeft.textContent = tl;
    topRight.textContent = tr;
  }

  function flashAlert() {
    alert.style.opacity = '1';
    clearTimeout(alertTimeout);
    alertTimeout = window.setTimeout(() => {
      alert.style.opacity = '0';
    }, 220);
  }

  function dispose() {
    clearTimeout(alertTimeout);
    hud.remove();
  }

  return { setPrompt, setProgress, setCorners, flashAlert, dispose };
}
