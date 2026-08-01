/**
 * Wraith Squadron's full mission flow. See README's "Full Mission Flow"
 * table -- each phase owns exactly one of a 3D scene, a full-screen DOM
 * overlay, or both simultaneously (m1/m2 render the world under the HUD).
 */
export type Phase =
  | 'booting'
  | 'm1'
  | 'debrief'
  | 'teleporting'
  | 'awakening'
  | 'm2'
  | 'm2Complete';

export interface MissionStats {
  m1ScanProgress: number;
  m1TimeElapsed: number;
  m1AlertsTriggered: number;
  m2ArrayProgress: number;
  m2TimeElapsed: number;
  m2HazardHits: number;
}

type PhaseListener = (phase: Phase, prev: Phase) => void;

export function createGameState() {
  let phase: Phase = 'booting';
  const listeners = new Set<PhaseListener>();
  const stats: MissionStats = {
    m1ScanProgress: 0,
    m1TimeElapsed: 0,
    m1AlertsTriggered: 0,
    m2ArrayProgress: 0,
    m2TimeElapsed: 0,
    m2HazardHits: 0,
  };

  function set(next: Phase) {
    const prev = phase;
    if (prev === next) return;
    phase = next;
    for (const listener of listeners) listener(next, prev);
  }

  function onChange(listener: PhaseListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    get phase() {
      return phase;
    },
    stats,
    set,
    onChange,
  };
}

export type GameState = ReturnType<typeof createGameState>;
