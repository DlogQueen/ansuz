import { injectWraithStyles } from './styles.js';

export interface AwakeningHooks {
  playMedPack: (onComplete?: () => void) => void;
  startTinnitus: () => void;
  stopTinnitus: () => void;
  onComplete: () => void;
}

export interface AwakeningController {
  dispose(): void;
}

/**
 * Skin Awakening: blurred/aberrated vision on the actual WebGL canvas
 * (not a DOM fake), tinnitus audio, the med-pack arm animation, then a
 * clear. Timeline is fixed (not input-driven) -- matches the spec's
 * "clears" ending state before mission 2 gameplay takes over.
 */
export function runAwakeningSequence(
  root: HTMLElement,
  canvas: HTMLCanvasElement,
  hooks: AwakeningHooks
): AwakeningController {
  injectWraithStyles();

  const overlay = document.createElement('div');
  overlay.className = 'wr-overlay';
  overlay.style.background = 'transparent';

  const eyebrow = document.createElement('div');
  eyebrow.className = 'wr-eyebrow';
  eyebrow.textContent = 'GALACTIC BASE: RELATIVELY';
  overlay.appendChild(eyebrow);

  const title = document.createElement('div');
  title.className = 'wr-title';
  title.style.fontSize = '1.6rem';
  title.textContent = 'SKIN AWAKENING';
  overlay.appendChild(title);

  const status = document.createElement('div');
  status.className = 'wr-line';
  status.style.opacity = '1';
  overlay.appendChild(status);

  root.appendChild(overlay);

  const originalTransition = canvas.style.transition;
  canvas.style.transition = 'filter 1.4s ease';
  canvas.style.filter = 'blur(14px) contrast(1.25) saturate(1.6)';

  status.textContent = 'VISION DESTABILIZED...';

  const timeouts: number[] = [];
  function after(ms: number, fn: () => void) {
    timeouts.push(window.setTimeout(fn, ms));
  }

  after(1100, () => {
    status.textContent = 'AUDITORY FEEDBACK DETECTED...';
    hooks.startTinnitus();
    canvas.style.filter = 'blur(9px) contrast(1.15) saturate(1.3)';
  });

  after(2400, () => {
    status.textContent = 'ADMINISTERING STABILIZER...';
    hooks.playMedPack(() => {
      status.textContent = 'STABILIZING...';
      hooks.stopTinnitus();
      canvas.style.filter = 'blur(0px) contrast(1) saturate(1)';
    });
  });

  after(6300, () => {
    canvas.style.filter = originalTransition ? '' : '';
    hooks.onComplete();
  });

  function dispose() {
    timeouts.forEach(clearTimeout);
    canvas.style.filter = '';
    canvas.style.transition = originalTransition;
    overlay.remove();
  }

  return { dispose };
}
