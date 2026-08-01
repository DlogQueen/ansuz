/**
 * WebAudio-based ambient/sfx layer -- no audio files, everything is
 * synthesized (oscillators + filtered noise) so there's nothing to fetch
 * or license. Lazily creates the AudioContext on first user gesture
 * (`resume`) since browsers block autoplay until then.
 */
export interface WraithAudio {
  resume(): void;
  setAmbient(kind: 'alien' | 'station' | 'none'): void;
  playChime(): void;
  playHazard(): void;
  startTinnitus(): void;
  stopTinnitus(): void;
  dispose(): void;
}

export function createWraithAudio(): WraithAudio {
  let ctx: AudioContext | null = null;
  let ambientNodes: AudioNode[] = [];
  let tinnitusOsc: OscillatorNode | null = null;
  let tinnitusGain: GainNode | null = null;

  function ensureContext(): AudioContext {
    if (!ctx) ctx = new AudioContext();
    return ctx;
  }

  function resume() {
    const audioCtx = ensureContext();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
  }

  function stopAmbient() {
    for (const node of ambientNodes) {
      if (node instanceof OscillatorNode || node instanceof AudioBufferSourceNode) {
        try {
          node.stop();
        } catch {
          // already stopped
        }
      }
      node.disconnect();
    }
    ambientNodes = [];
  }

  function makeNoiseBuffer(audioCtx: AudioContext): AudioBuffer {
    const buffer = audioCtx.createBuffer(1, audioCtx.sampleRate * 2, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  function setAmbient(kind: 'alien' | 'station' | 'none') {
    stopAmbient();
    if (kind === 'none') return;
    const audioCtx = ensureContext();

    const master = audioCtx.createGain();
    master.gain.value = kind === 'alien' ? 0.05 : 0.045;
    master.connect(audioCtx.destination);
    ambientNodes.push(master);

    const drone = audioCtx.createOscillator();
    drone.type = 'sine';
    drone.frequency.value = kind === 'alien' ? 54 : 40;
    const droneGain = audioCtx.createGain();
    droneGain.gain.value = 1;
    drone.connect(droneGain).connect(master);
    drone.start();
    ambientNodes.push(drone, droneGain);

    const noise = audioCtx.createBufferSource();
    noise.buffer = makeNoiseBuffer(audioCtx);
    noise.loop = true;
    const noiseFilter = audioCtx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = kind === 'alien' ? 320 : 180;
    noiseFilter.Q.value = 0.6;
    const noiseGain = audioCtx.createGain();
    noiseGain.gain.value = 0.4;
    noise.connect(noiseFilter).connect(noiseGain).connect(master);
    noise.start();
    ambientNodes.push(noise, noiseFilter, noiseGain);
  }

  function playChime() {
    const audioCtx = ensureContext();
    const osc = audioCtx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1320, audioCtx.currentTime + 0.15);
    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.4);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.4);
  }

  function playHazard() {
    const audioCtx = ensureContext();
    const osc = audioCtx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(220, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(70, audioCtx.currentTime + 0.3);
    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.3);
  }

  function startTinnitus() {
    const audioCtx = ensureContext();
    stopTinnitus();
    tinnitusOsc = audioCtx.createOscillator();
    tinnitusOsc.type = 'sine';
    tinnitusOsc.frequency.value = 9200;
    tinnitusGain = audioCtx.createGain();
    tinnitusGain.gain.value = 0;
    tinnitusGain.gain.linearRampToValueAtTime(0.045, audioCtx.currentTime + 0.6);
    tinnitusOsc.connect(tinnitusGain).connect(audioCtx.destination);
    tinnitusOsc.start();
  }

  function stopTinnitus() {
    if (!tinnitusOsc || !tinnitusGain || !ctx) return;
    const audioCtx = ctx;
    tinnitusGain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.8);
    const osc = tinnitusOsc;
    setTimeout(() => {
      osc.stop();
      osc.disconnect();
    }, 900);
    tinnitusOsc = null;
    tinnitusGain = null;
  }

  function dispose() {
    stopAmbient();
    stopTinnitus();
    ctx?.close();
    ctx = null;
  }

  return { resume, setAmbient, playChime, playHazard, startTinnitus, stopTinnitus, dispose };
}
