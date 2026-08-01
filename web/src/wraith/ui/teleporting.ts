import { injectWraithStyles } from './styles.js';

export interface TeleportingOverlay {
  dispose(): void;
}

export function mountTeleportingOverlay(root: HTMLElement): TeleportingOverlay {
  injectWraithStyles();

  const overlay = document.createElement('div');
  overlay.className = 'wr-overlay';
  overlay.style.background = 'transparent';
  overlay.style.justifyContent = 'flex-end';
  overlay.style.paddingBottom = '10vh';

  const eyebrow = document.createElement('div');
  eyebrow.className = 'wr-eyebrow';
  eyebrow.textContent = 'QUANTUM UPLINK ENGAGED';
  overlay.appendChild(eyebrow);

  const title = document.createElement('div');
  title.className = 'wr-title';
  title.style.fontSize = '1.6rem';
  title.textContent = 'TRANSMITTING CONSCIOUSNESS';
  overlay.appendChild(title);

  root.appendChild(overlay);

  function dispose() {
    overlay.remove();
  }

  return { dispose };
}
