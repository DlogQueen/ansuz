import { injectWraithStyles } from './styles.js';
import type { MissionStats } from '../core/state.js';

export interface DebriefOverlay {
  dispose(): void;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function mountDebriefOverlay(
  root: HTMLElement,
  stats: MissionStats,
  onUplink: () => void
): DebriefOverlay {
  injectWraithStyles();

  const overlay = document.createElement('div');
  overlay.className = 'wr-overlay';

  const panel = document.createElement('div');
  panel.className = 'wr-panel';

  const eyebrow = document.createElement('div');
  eyebrow.className = 'wr-eyebrow';
  eyebrow.textContent = 'MISSION 1 COMPLETE';
  panel.appendChild(eyebrow);

  const title = document.createElement('div');
  title.className = 'wr-title';
  title.textContent = 'RELAY BEACON YXIS-9 SCANNED';
  title.style.fontSize = '1.4rem';
  panel.appendChild(title);

  const statsList = document.createElement('dl');
  statsList.className = 'wr-stats';
  const rows: [string, string][] = [
    ['Time on ground', formatTime(stats.m1TimeElapsed)],
    ['Yxir alerts triggered', String(stats.m1AlertsTriggered)],
    ['Scan integrity', '100%'],
  ];
  for (const [label, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    statsList.appendChild(dt);
    statsList.appendChild(dd);
  }
  panel.appendChild(statsList);

  const orders = document.createElement('div');
  orders.className = 'wr-line';
  orders.style.opacity = '1';
  orders.style.maxWidth = '360px';
  orders.style.margin = '0.5rem 0 1rem';
  orders.textContent =
    'NEW ORDERS: quantum uplink standing by. Your consciousness will transmit to a new biogenetically-crafted Skin at Galactic Base: Relatively.';
  panel.appendChild(orders);

  const button = document.createElement('button');
  button.className = 'wr-btn';
  button.textContent = 'INITIATE QUANTUM UPLINK';
  button.addEventListener('click', onUplink);
  panel.appendChild(button);

  overlay.appendChild(panel);
  root.appendChild(overlay);

  function dispose() {
    overlay.remove();
  }

  return { dispose };
}
