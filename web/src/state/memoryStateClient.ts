/**
 * Feeds the scene from Sophie's real memory instead of the placeholder sine
 * oscillator main.ts used to run on (see src/memory/memoryState.ts for the
 * server side).
 *
 * Two things matter here beyond just fetching:
 *
 * - **Smoothing.** The raw signal is a step function -- it only changes when
 *   a turn happens or consolidation runs. Snapping the whole environment
 *   between states would read as a glitch, so the reported values ease
 *   toward their targets over a few seconds.
 * - **Falling back.** If the bridge server isn't running (the scene is
 *   perfectly usable standalone -- `npm run dev` without `npm run server`),
 *   this degrades to the old slow oscillation rather than freezing the world
 *   at a constant. A still scene looks broken; a breathing one looks alive.
 */
export interface MemoryStateClient {
  /** Advance smoothing. Call once per frame. */
  update(delta: number): void;
  getMemoryLoad(): number;
  getCoherence(): number;
  /** True while running on the demo oscillator because the server is unreachable. */
  isFallback(): boolean;
}

interface MemoryStatePayload {
  memoryLoad: number;
  coherence: number;
  shortTermRows: number;
  longTermRows: number;
  hasRetrieved: boolean;
}

const POLL_INTERVAL_MS = 5000;
// Seconds to close roughly 63% of the gap to a new target -- slow enough to
// feel like the world settling, fast enough to connect a reply to its effect.
const SMOOTHING_TIME = 2.5;

export function createMemoryStateClient(): MemoryStateClient {
  let targetLoad = 0.35;
  let targetCoherence = 0.5;
  let currentLoad = 0.35;
  let currentCoherence = 0.5;
  let fallback = true;
  let demoT = 0;

  async function poll(): Promise<void> {
    try {
      const response = await fetch('/api/memory-state');
      if (!response.ok) throw new Error(`memory-state ${response.status}`);
      const state = (await response.json()) as MemoryStatePayload;
      targetLoad = state.memoryLoad;
      // Before any retrieval has happened this server lifetime, the reported
      // coherence is a placeholder rather than a measurement -- hold the
      // midpoint instead of implying a reading we don't have.
      targetCoherence = state.hasRetrieved ? state.coherence : 0.5;
      fallback = false;
    } catch {
      // Server down or not running -- keep the demo oscillation going.
      fallback = true;
    }
  }

  void poll();
  setInterval(() => void poll(), POLL_INTERVAL_MS);

  return {
    update(delta: number) {
      if (fallback) {
        demoT += delta;
        targetLoad = (Math.sin(demoT * 0.1) + 1) / 2;
        targetCoherence = (Math.sin(demoT * 0.07 + 1.5) + 1) / 2;
      }

      // Exponential ease, framerate-independent.
      const alpha = 1 - Math.exp(-delta / SMOOTHING_TIME);
      currentLoad += (targetLoad - currentLoad) * alpha;
      currentCoherence += (targetCoherence - currentCoherence) * alpha;
    },
    getMemoryLoad: () => currentLoad,
    getCoherence: () => currentCoherence,
    isFallback: () => fallback,
  };
}
