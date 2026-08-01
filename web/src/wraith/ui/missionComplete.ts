import { injectWraithStyles } from './styles.js';
import type { MissionStats } from '../core/state.js';

export interface MissionCompleteOverlay {
  dispose(): void;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function mountMissionCompleteOverlay(root: HTMLElement, stats: MissionStats): MissionCompleteOverlay {
  injectWraithStyles();

  const overlay = document.createElement('div');
  overlay.className = 'wr-overlay';

  const panel = document.createElement('div');
  panel.className = 'wr-panel';

  const eyebrow = document.createElement('div');
  eyebrow.className = 'wr-eyebrow';
  eyebrow.textContent = 'GALACTIC BASE: RELATIVELY';
  panel.appendChild(eyebrow);

  const title = document.createElement('div');
  title.className = 'wr-title';
  title.textContent = 'SIGNAL RELAYED';
  panel.appendChild(title);

  const statsList = document.createElement('dl');
  statsList.className = 'wr-stats';
  const rows: [string, string][] = [
    ['Time to array', formatTime(stats.m2TimeElapsed)],
    ['SMRC hazard hits', String(stats.m2HazardHits)],
    ['Quantum Transporter Array', 'ONLINE'],
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

  const closing = document.createElement('div');
  closing.className = 'wr-line';
  closing.style.opacity = '1';
  closing.style.maxWidth = '360px';
  closing.textContent = 'Wraith Squadron, this is Relatively. Uplink confirmed. Stand by.';
  panel.appendChild(closing);

  overlay.appendChild(panel);
  root.appendChild(overlay);

  function dispose() {
    overlay.remove();
  }

  return { dispose };
}
