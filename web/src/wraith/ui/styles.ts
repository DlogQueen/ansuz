let injected = false;

/**
 * One shared stylesheet for every DOM overlay -- keeps the bioluminescent
 * sci-fi look (glass panels, glow text, letterspaced caps) consistent across
 * phases without repeating inline styles in every overlay module.
 */
export function injectWraithStyles(): void {
  if (injected) return;
  injected = true;

  const style = document.createElement('style');
  style.textContent = /* css */ `
    .wr-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      color: #eaf6ff;
      text-align: center;
      background: radial-gradient(ellipse at center, rgba(20, 8, 40, 0.15) 0%, rgba(2, 1, 8, 0.85) 100%);
      animation: wr-fade-in 0.6s ease-out;
    }
    @keyframes wr-fade-in { from { opacity: 0; } to { opacity: 1; } }

    .wr-eyebrow {
      letter-spacing: 0.35em;
      font-size: 0.75rem;
      text-transform: uppercase;
      color: #7ef7e6;
      opacity: 0.85;
      margin-bottom: 0.5rem;
    }
    .wr-title {
      font-size: 2.4rem;
      font-weight: 300;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      margin: 0 0 1.2rem;
      text-shadow: 0 0 18px #c99bff, 0 0 40px rgba(201, 155, 255, 0.4);
    }
    .wr-line {
      font-size: 1rem;
      letter-spacing: 0.08em;
      opacity: 0;
      margin: 0.2rem 0;
      color: #b9e8ff;
      animation: wr-line-in 0.5s ease-out forwards;
    }
    @keyframes wr-line-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }

    .wr-panel {
      background: rgba(15, 8, 30, 0.72);
      border: 1px solid rgba(201, 155, 255, 0.35);
      border-radius: 10px;
      padding: 2rem 2.6rem;
      backdrop-filter: blur(6px);
      box-shadow: 0 0 40px rgba(126, 247, 230, 0.08), inset 0 0 60px rgba(126, 247, 230, 0.04);
      min-width: 320px;
    }

    .wr-stats {
      display: grid;
      grid-template-columns: auto auto;
      gap: 0.3rem 1.5rem;
      text-align: left;
      margin: 1.2rem 0;
      font-size: 0.95rem;
    }
    .wr-stats dt { color: #7ef7e6; letter-spacing: 0.06em; text-transform: uppercase; font-size: 0.75rem; }
    .wr-stats dd { margin: 0; font-variant-numeric: tabular-nums; }

    .wr-btn {
      pointer-events: auto;
      cursor: pointer;
      background: linear-gradient(135deg, rgba(126, 247, 230, 0.15), rgba(201, 155, 255, 0.15));
      border: 1px solid #7ef7e6;
      color: #eaf6ff;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      font-size: 0.9rem;
      padding: 0.9rem 1.8rem;
      border-radius: 6px;
      transition: box-shadow 0.2s, transform 0.2s;
      margin-top: 0.5rem;
    }
    .wr-btn:hover {
      box-shadow: 0 0 25px rgba(126, 247, 230, 0.55);
      transform: translateY(-1px);
    }

    .wr-hud {
      position: absolute;
      inset: 0;
      pointer-events: none;
    }
    .wr-crosshair {
      position: absolute;
      top: 50%;
      left: 50%;
      width: 8px;
      height: 8px;
      margin: -4px 0 0 -4px;
      border-radius: 50%;
      border: 1px solid rgba(234, 246, 255, 0.7);
    }
    .wr-prompt {
      position: absolute;
      top: 62%;
      left: 50%;
      transform: translateX(-50%);
      letter-spacing: 0.12em;
      text-transform: uppercase;
      font-size: 0.85rem;
      color: #eaf6ff;
      text-shadow: 0 0 10px #7ef7e6;
      white-space: nowrap;
    }
    .wr-scanbar {
      position: absolute;
      top: 68%;
      left: 50%;
      transform: translateX(-50%);
      width: 220px;
      height: 6px;
      border: 1px solid rgba(126, 247, 230, 0.6);
      border-radius: 3px;
      overflow: hidden;
    }
    .wr-scanbar-fill {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, #7ef7e6, #c99bff);
    }
    .wr-corner {
      position: absolute;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      font-size: 0.75rem;
      color: rgba(234, 246, 255, 0.75);
      text-shadow: 0 0 8px rgba(126, 247, 230, 0.4);
    }
    .wr-topleft { top: 1.2rem; left: 1.4rem; text-align: left; }
    .wr-topright { top: 1.2rem; right: 1.4rem; text-align: right; }
    .wr-alert {
      position: absolute;
      inset: 0;
      background: radial-gradient(ellipse at center, transparent 55%, rgba(255, 30, 90, 0.35) 100%);
      opacity: 0;
      transition: opacity 0.15s;
    }

    .wr-canvas-fx {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 5;
      transition: filter 1.5s ease, opacity 1.5s ease;
    }
  `;
  document.head.appendChild(style);
}
