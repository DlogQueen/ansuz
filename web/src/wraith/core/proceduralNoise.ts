/**
 * Cheap CPU-side value noise for one-time terrain/scatter generation
 * (geometry displacement, placement density) -- not per-frame, so a
 * lightweight hashed-sine value noise is plenty; the GLSL simplex noise in
 * shaders/noiseGLSL.ts handles anything animated per-frame on the GPU.
 */
function hash2D(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

export function valueNoise2D(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;

  const a = hash2D(xi, yi);
  const b = hash2D(xi + 1, yi);
  const c = hash2D(xi, yi + 1);
  const d = hash2D(xi + 1, yi + 1);

  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);

  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

export function fbm2D(x: number, y: number, octaves = 4): number {
  let sum = 0;
  let amplitude = 0.5;
  let frequency = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amplitude * valueNoise2D(x * frequency, y * frequency);
    frequency *= 2;
    amplitude *= 0.5;
  }
  return sum;
}
