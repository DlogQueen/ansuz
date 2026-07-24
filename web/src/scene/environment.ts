import * as THREE from 'three';

/**
 * The space itself: an open expanse rather than an enclosed room. A sparse
 * field of points extends to the horizon (density stands in for memory
 * load), fog keeps the edges soft instead of hard walls, and a single
 * hemisphere light carries the retrieval-state color (coherent vs scattered).
 *
 * Sky: stars, a single slowly-orbiting moon, and aurora curtains (teal /
 * magenta / pink, not just the usual green) that fade in and out on a slow
 * cycle rather than staying on constantly -- "alive-quiet, not empty-quiet"
 * per the design conversation this got built from. Sky elements use unlit
 * materials with `fog: false` -- the ground-level FogExp2 represents
 * near-surface haze and would otherwise wash out anything sky-distance away.
 */
export interface Environment {
  group: THREE.Group;
  /** 0 = sparse (little short-term memory), 1 = dense (heavy load). */
  setMemoryLoad(load: number): void;
  /** 0 = scattered/cold, 1 = coherent/warm. Drives ambient light color. */
  setRetrievalCoherence(coherence: number): void;
  /** Advances the moon's orbit and the aurora's shimmer/fade cycle. */
  update(delta: number): void;
}

const FIELD_RADIUS = 200;
const MAX_FIELD_POINTS = 6000;
const MIN_FIELD_POINTS = 400;

const SCATTERED_COLOR = new THREE.Color('#3a4a6b');
const COHERENT_COLOR = new THREE.Color('#e8c98a');

const STAR_COUNT = 2200;
const STAR_SHELL_RADIUS = 440;

const MOON_ORBIT_RADIUS = 320;
const MOON_ORBIT_HEIGHT = 140;
const MOON_ORBIT_SPEED = 0.008; // radians/sec -- a slow, barely-there drift, not a visible sweep

const AURORA_CYCLE_SECONDS = 90;
const AURORA_ACTIVE_START = 0.1;
const AURORA_ACTIVE_END = 0.55;
const AURORA_FADE_WIDTH = 0.08;

export function createEnvironment(scene: THREE.Scene): Environment {
  const group = new THREE.Group();

  scene.fog = new THREE.FogExp2('#05070c', 0.0065);
  scene.background = new THREE.Color('#05070c');

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(FIELD_RADIUS * 1.5, 64),
    new THREE.MeshStandardMaterial({ color: '#090b12', roughness: 1, metalness: 0 })
  );
  ground.rotation.x = -Math.PI / 2;
  group.add(ground);

  const hemiLight = new THREE.HemisphereLight(SCATTERED_COLOR, '#05070c', 1.2);
  group.add(hemiLight);

  const fieldGeometry = new THREE.BufferGeometry();
  const positions = new Float32Array(MAX_FIELD_POINTS * 3);
  for (let i = 0; i < MAX_FIELD_POINTS; i++) {
    const radius = FIELD_RADIUS * Math.sqrt(Math.random());
    const angle = Math.random() * Math.PI * 2;
    positions[i * 3] = Math.cos(angle) * radius;
    positions[i * 3 + 1] = Math.random() * 12;
    positions[i * 3 + 2] = Math.sin(angle) * radius;
  }
  fieldGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  fieldGeometry.setDrawRange(0, MIN_FIELD_POINTS);

  const fieldMaterial = new THREE.PointsMaterial({
    color: '#cfd8ff',
    size: 0.4,
    transparent: true,
    opacity: 0.55,
    sizeAttenuation: true,
  });

  const field = new THREE.Points(fieldGeometry, fieldMaterial);
  group.add(field);

  group.add(createStarfield());
  const moon = createMoon();
  group.add(moon.group);
  const aurora = createAurora();
  group.add(aurora.group);

  scene.add(group);

  let moonAngle = Math.random() * Math.PI * 2;
  let auroraTime = Math.random() * AURORA_CYCLE_SECONDS;

  return {
    group,
    setMemoryLoad(load: number) {
      const clamped = THREE.MathUtils.clamp(load, 0, 1);
      const count = Math.round(
        THREE.MathUtils.lerp(MIN_FIELD_POINTS, MAX_FIELD_POINTS, clamped)
      );
      fieldGeometry.setDrawRange(0, count);
    },
    setRetrievalCoherence(coherence: number) {
      const clamped = THREE.MathUtils.clamp(coherence, 0, 1);
      const color = SCATTERED_COLOR.clone().lerp(COHERENT_COLOR, clamped);
      hemiLight.color.copy(color);
      fieldMaterial.opacity = THREE.MathUtils.lerp(0.35, 0.65, clamped);
    },
    update(delta: number) {
      moonAngle += MOON_ORBIT_SPEED * delta;
      moon.group.position.set(
        Math.cos(moonAngle) * MOON_ORBIT_RADIUS,
        MOON_ORBIT_HEIGHT,
        Math.sin(moonAngle) * MOON_ORBIT_RADIUS
      );

      auroraTime += delta;
      const phase = (auroraTime % AURORA_CYCLE_SECONDS) / AURORA_CYCLE_SECONDS;
      aurora.setIntensity(auroraEnvelope(phase));
      aurora.setTime(auroraTime);
    },
  };
}

function auroraEnvelope(phase: number): number {
  if (phase < AURORA_ACTIVE_START - AURORA_FADE_WIDTH || phase > AURORA_ACTIVE_END + AURORA_FADE_WIDTH) return 0;
  if (phase < AURORA_ACTIVE_START) {
    return THREE.MathUtils.smoothstep(phase, AURORA_ACTIVE_START - AURORA_FADE_WIDTH, AURORA_ACTIVE_START);
  }
  if (phase > AURORA_ACTIVE_END) {
    return 1 - THREE.MathUtils.smoothstep(phase, AURORA_ACTIVE_END, AURORA_ACTIVE_END + AURORA_FADE_WIDTH);
  }
  return 1;
}

function createStarfield(): THREE.Points {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i++) {
    // Upper hemisphere only, so nothing ends up looking like it's poking
    // through the ground disc from a low viewing angle.
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(Math.random()); // 0 (straight up) .. PI/2 (horizon)
    positions[i * 3] = STAR_SHELL_RADIUS * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = STAR_SHELL_RADIUS * Math.cos(phi);
    positions[i * 3 + 2] = STAR_SHELL_RADIUS * Math.sin(phi) * Math.sin(theta);
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const material = new THREE.PointsMaterial({
    color: '#eef2ff',
    size: 1.1,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.8,
    fog: false,
  });

  return new THREE.Points(geometry, material);
}

function createMoon(): { group: THREE.Group } {
  const group = new THREE.Group();

  const moon = new THREE.Mesh(
    new THREE.SphereGeometry(18, 32, 32),
    new THREE.MeshBasicMaterial({ map: createMoonTexture(), fog: false })
  );
  group.add(moon);

  // Soft additive halo -- an inverted-normal shell slightly larger than the
  // moon itself, same cheap-aura trick used for Ansuz's avatar glow.
  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(24, 24, 24),
    new THREE.MeshBasicMaterial({
      color: '#cfe0ff',
      transparent: true,
      opacity: 0.15,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      fog: false,
    })
  );
  group.add(halo);

  return { group };
}

function createMoonTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const gradient = ctx.createRadialGradient(
    size * 0.4, size * 0.4, size * 0.05,
    size * 0.5, size * 0.5, size * 0.55
  );
  gradient.addColorStop(0, '#f5f3ee');
  gradient.addColorStop(0.6, '#d8d4c8');
  gradient.addColorStop(1, '#9d998c');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  ctx.fillStyle = 'rgba(120, 115, 105, 0.35)';
  const craterSeed = [
    [0.3, 0.6, 18], [0.65, 0.3, 14], [0.7, 0.7, 22], [0.4, 0.35, 10], [0.55, 0.55, 12],
  ];
  for (const [u, v, r] of craterSeed) {
    ctx.beginPath();
    ctx.arc(u * size, v * size, r, 0, Math.PI * 2);
    ctx.fill();
  }

  return new THREE.CanvasTexture(canvas);
}

interface Aurora {
  group: THREE.Group;
  setIntensity(value: number): void;
  setTime(value: number): void;
}

const AURORA_VERTEX_SHADER = `
  varying vec2 vUv;
  uniform float uTime;
  void main() {
    vUv = uv;
    vec3 pos = position;
    pos.x += sin(pos.y * 0.15 + uTime * 0.3) * 4.0 * uv.y;
    pos.z += cos(pos.y * 0.1 + uTime * 0.22) * 3.0 * uv.y;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const AURORA_FRAGMENT_SHADER = `
  varying vec2 vUv;
  uniform float uTime;
  uniform float uIntensity;

  vec3 palette(float t) {
    vec3 teal = vec3(0.16, 0.85, 0.75);
    vec3 magenta = vec3(0.82, 0.18, 0.88);
    vec3 pink = vec3(1.0, 0.45, 0.72);
    float t3 = fract(t) * 3.0;
    if (t3 < 1.0) return mix(teal, magenta, t3);
    if (t3 < 2.0) return mix(magenta, pink, t3 - 1.0);
    return mix(pink, teal, t3 - 2.0);
  }

  void main() {
    vec3 color = palette(vUv.y * 0.6 + uTime * 0.05);
    float vertical = smoothstep(0.0, 0.15, vUv.y) * smoothstep(1.0, 0.7, vUv.y);
    float shimmer = 0.6 + 0.4 * sin(vUv.x * 20.0 + uTime * 1.5);
    float alpha = vertical * shimmer * uIntensity;
    gl_FragColor = vec4(color, alpha);
  }
`;

function createAurora(): Aurora {
  const group = new THREE.Group();
  const materials: THREE.ShaderMaterial[] = [];

  const curtainCount = 3;
  for (let i = 0; i < curtainCount; i++) {
    const material = new THREE.ShaderMaterial({
      vertexShader: AURORA_VERTEX_SHADER,
      fragmentShader: AURORA_FRAGMENT_SHADER,
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    materials.push(material);

    const curtain = new THREE.Mesh(new THREE.PlaneGeometry(120, 90, 32, 24), material);
    const angle = (i / curtainCount) * Math.PI * 2 + Math.random() * 0.5;
    curtain.position.set(Math.cos(angle) * 200, 90, Math.sin(angle) * 200);
    curtain.rotation.y = -angle + Math.PI / 2;
    group.add(curtain);
  }

  return {
    group,
    setIntensity(value: number) {
      for (const material of materials) material.uniforms.uIntensity.value = value;
    },
    setTime(value: number) {
      for (const material of materials) material.uniforms.uTime.value = value;
    },
  };
}
