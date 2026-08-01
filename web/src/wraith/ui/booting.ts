import { injectWraithStyles } from './styles.js';

const BOOT_LINES = [
  'ESTABLISHING NEURAL LINK...',
  'CALIBRATING WRAITH SQUADRON UPLINK...',
  'SOPHIA-7 IDENTITY CONFIRMED...',
  'NEURAL SYNC COMPLETE.',
];

const LINE_INTERVAL_MS = 950;
const TOTAL_DURATION_MS = 4500;

export interface BootOverlay {
  dispose(): void;
}

/**
 * Neural Sync Boot: network-node canvas animation behind sequential
 * status text. Auto-advances via `onComplete` after ~4.5s -- no user
 * input required, matches the spec's boot phase.
 */
export function mountBootOverlay(root: HTMLElement, onComplete: () => void): BootOverlay {
  injectWraithStyles();

  const overlay = document.createElement('div');
  overlay.className = 'wr-overlay';

  const canvas = document.createElement('canvas');
  canvas.style.position = 'absolute';
  canvas.style.inset = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  overlay.appendChild(canvas);

  const panel = document.createElement('div');
  panel.style.position = 'relative';
  panel.style.zIndex = '1';

  const eyebrow = document.createElement('div');
  eyebrow.className = 'wr-eyebrow';
  eyebrow.textContent = 'WRAITH SQUADRON';
  panel.appendChild(eyebrow);

  const title = document.createElement('div');
  title.className = 'wr-title';
  title.textContent = 'NEURAL SYNC BOOT';
  panel.appendChild(title);

  const lines = document.createElement('div');
  panel.appendChild(lines);
  overlay.appendChild(panel);
  root.appendChild(overlay);

  const ctx = canvas.getContext('2d');
  let width = 0;
  let height = 0;
  function resize() {
    width = canvas.width = overlay.clientWidth * devicePixelRatio;
    height = canvas.height = overlay.clientHeight * devicePixelRatio;
  }
  resize();
  window.addEventListener('resize', resize);

  interface Node {
    x: number;
    y: number;
    vx: number;
    vy: number;
  }
  const nodes: Node[] = Array.from({ length: 42 }, () => ({
    x: Math.random() * width,
    y: Math.random() * height,
    vx: (Math.random() - 0.5) * 20,
    vy: (Math.random() - 0.5) * 20,
  }));

  let raf = 0;
  let last = performance.now();
  function frame(now: number) {
    const delta = Math.min((now - last) / 1000, 0.05);
    last = now;
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);

    for (const node of nodes) {
      node.x += node.vx * delta;
      node.y += node.vy * delta;
      if (node.x < 0 || node.x > width) node.vx *= -1;
      if (node.y < 0 || node.y > height) node.vy *= -1;
    }

    ctx.lineWidth = 1;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dist = Math.hypot(dx, dy);
        const maxDist = width * 0.12;
        if (dist < maxDist) {
          ctx.strokeStyle = `rgba(126, 247, 230, ${0.5 * (1 - dist / maxDist)})`;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }
    for (const node of nodes) {
      ctx.fillStyle = 'rgba(201, 155, 255, 0.85)';
      ctx.beginPath();
      ctx.arc(node.x, node.y, 2 * devicePixelRatio, 0, Math.PI * 2);
      ctx.fill();
    }

    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  const timeouts: number[] = [];
  BOOT_LINES.forEach((text, i) => {
    timeouts.push(
      window.setTimeout(() => {
        const line = document.createElement('div');
        line.className = 'wr-line';
        line.textContent = text;
        lines.appendChild(line);
      }, i * LINE_INTERVAL_MS)
    );
  });

  const completeTimeout = window.setTimeout(onComplete, TOTAL_DURATION_MS);

  function dispose() {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', resize);
    timeouts.forEach(clearTimeout);
    clearTimeout(completeTimeout);
    overlay.remove();
  }

  return { dispose };
}
