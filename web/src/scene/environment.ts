import * as THREE from 'three';

/**
 * The space itself: a cosmic void rather than any earthly landscape. Sophie
 * and Ryleigh stand on a dark reflective plane suspended in open space, under
 * a nebula that breathes, with a banded gas giant dominating the horizon and
 * fractured slabs drifting at every altitude.
 *
 * Everything here is procedural -- noise shaders, instanced geometry, canvas
 * textures. No modelled assets, which keeps it editable in code and cheap
 * enough for a Quest-class GPU.
 *
 * The two state inputs are load-bearing, not decorative:
 *   memoryLoad  -> how much *stuff* exists (drifting shards, dust density,
 *                  nebula opacity). A full mind is a crowded sky.
 *   coherence   -> how *ordered* it all is. Low coherence tumbles the shards
 *                  on chaotic axes and cools the palette to cold violet; high
 *                  coherence aligns them to a common orientation and warms
 *                  everything toward gold. The world literally composes
 *                  itself as her retrieval sharpens.
 *
 * Sky elements use `fog: false` -- the ground-level FogExp2 is near-surface
 * haze and would otherwise wash out anything at sky distance.
 */
export interface Environment {
  group: THREE.Group;
  /** 0 = sparse (little short-term memory), 1 = dense (heavy load). */
  setMemoryLoad(load: number): void;
  /** 0 = scattered/cold/tumbling, 1 = coherent/warm/aligned. */
  setRetrievalCoherence(coherence: number): void;
  /** Advances orbits, drift, nebula flow, and mote rise. */
  update(delta: number): void;
}

const VOID_COLOR = new THREE.Color('#04030a');

const SCATTERED_COLOR = new THREE.Color('#5b3f9e');
const COHERENT_COLOR = new THREE.Color('#e8c98a');

const NEBULA_RADIUS = 600;

// Sized and placed for "majestic distant object", not "about to hit us" --
// far enough that it reads as a world across space rather than a wall.
const GAS_GIANT_RADIUS = 130;
// Left of the sightline and well up, at a distance that subtends ~22deg --
// unmistakably a world across space, without walling off the frame.
const GAS_GIANT_POSITION = new THREE.Vector3(-235, 130, -620);

const SHARD_COUNT = 260;
const MIN_VISIBLE_SHARDS = 30;
const SHARD_FIELD_RADIUS = 130;

const SLAB_COUNT = 34;

const MOTE_COUNT = 1400;
const MOTE_FIELD_RADIUS = 90;
const MOTE_RISE_SPEED = 0.45;
const MOTE_CEILING = 40;

const STAR_COUNT = 2600;
const STAR_SHELL_RADIUS = 520;

// ---------------------------------------------------------------------------
// Shared GLSL: value noise + fbm. Cheap enough for a mobile GPU and good
// enough for nebula banding -- simplex would cost more than it's worth here.
// ---------------------------------------------------------------------------
const NOISE_GLSL = `
  vec3 hash3(vec3 p) {
    p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
             dot(p, vec3(269.5, 183.3, 246.1)),
             dot(p, vec3(113.5, 271.9, 124.6)));
    return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
  }

  float noise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(dot(hash3(i + vec3(0,0,0)), f - vec3(0,0,0)),
                       dot(hash3(i + vec3(1,0,0)), f - vec3(1,0,0)), u.x),
                   mix(dot(hash3(i + vec3(0,1,0)), f - vec3(0,1,0)),
                       dot(hash3(i + vec3(1,1,0)), f - vec3(1,1,0)), u.x), u.y),
               mix(mix(dot(hash3(i + vec3(0,0,1)), f - vec3(0,0,1)),
                       dot(hash3(i + vec3(1,0,1)), f - vec3(1,0,1)), u.x),
                   mix(dot(hash3(i + vec3(0,1,1)), f - vec3(0,1,1)),
                       dot(hash3(i + vec3(1,1,1)), f - vec3(1,1,1)), u.x), u.y), u.z);
  }

  float fbm(vec3 p) {
    float total = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 5; i++) {
      total += noise(p) * amplitude;
      p *= 2.02;
      amplitude *= 0.5;
    }
    return total;
  }
`;

export function createEnvironment(scene: THREE.Scene): Environment {
  const group = new THREE.Group();

  // Very light fog: enough to give the ground plane depth, not enough to
  // swallow the drifting geometry that makes the void feel inhabited.
  scene.fog = new THREE.FogExp2(VOID_COLOR.getHex(), 0.0035);
  scene.background = VOID_COLOR.clone();

  const hemiLight = new THREE.HemisphereLight(SCATTERED_COLOR.clone(), '#06040e', 1.1);
  group.add(hemiLight);

  // Key light standing in for the gas giant, so lit surfaces agree with where
  // the brightest thing in the sky actually is.
  const keyLight = new THREE.DirectionalLight('#b9a3ff', 1.5);
  keyLight.position.copy(GAS_GIANT_POSITION);
  group.add(keyLight);

  const nebula = createNebula();
  group.add(nebula.mesh);

  group.add(createStarfield());

  const gasGiant = createGasGiant();
  group.add(gasGiant.group);

  const moons = createMoons();
  group.add(moons.group);

  const ground = createVoidGround();
  group.add(ground.mesh);

  const slabs = createSlabs();
  group.add(slabs.mesh);

  const shards = createShards();
  group.add(shards.mesh);

  const motes = createMotes();
  group.add(motes.points);

  scene.add(group);

  let elapsed = 0;
  let memoryLoad = 0.35;
  let coherence = 0.5;

  return {
    group,

    setMemoryLoad(load: number) {
      memoryLoad = THREE.MathUtils.clamp(load, 0, 1);
      shards.setVisibleCount(
        Math.round(THREE.MathUtils.lerp(MIN_VISIBLE_SHARDS, SHARD_COUNT, memoryLoad))
      );
      motes.setDensity(memoryLoad);
      nebula.setDensity(memoryLoad);
    },

    setRetrievalCoherence(value: number) {
      coherence = THREE.MathUtils.clamp(value, 0, 1);
      const color = SCATTERED_COLOR.clone().lerp(COHERENT_COLOR, coherence);

      hemiLight.color.copy(color);
      hemiLight.intensity = THREE.MathUtils.lerp(0.85, 1.35, coherence);
      keyLight.color.copy(color);
      keyLight.intensity = THREE.MathUtils.lerp(1.0, 2.0, coherence);

      nebula.setCoherence(coherence);
      ground.setCoherence(coherence);
      shards.setCoherence(coherence);
      motes.setCoherence(coherence);
    },

    update(delta: number) {
      elapsed += delta;
      nebula.setTime(elapsed);
      ground.setTime(elapsed);
      gasGiant.update(delta, elapsed);
      moons.update(delta);
      shards.update(delta, elapsed, coherence);
      motes.update(delta);
    },
  };
}

// ---------------------------------------------------------------------------
// Nebula: an inward-facing sphere enclosing everything. fbm clouds drifting
// through a violet/cyan/rose palette, warming toward gold as coherence rises.
// ---------------------------------------------------------------------------
interface Nebula {
  mesh: THREE.Mesh;
  setTime(value: number): void;
  setCoherence(value: number): void;
  setDensity(value: number): void;
}

const NEBULA_VERTEX_SHADER = `
  varying vec3 vDirection;
  void main() {
    vDirection = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const NEBULA_FRAGMENT_SHADER = `
  varying vec3 vDirection;
  uniform float uTime;
  uniform float uCoherence;
  uniform float uDensity;

  ${NOISE_GLSL}

  void main() {
    vec3 dir = normalize(vDirection);

    // Two counter-drifting noise layers so the cloud never reads as a static
    // texture pinned to the sky. Frequency matters a lot here: too low and a
    // single gap in the noise opens a hole across most of the sky, which
    // reads as a big dark dome rather than as wisps.
    vec3 p = dir * 4.6;
    float slow = fbm(p + vec3(uTime * 0.012, uTime * 0.006, 0.0));
    float fast = fbm(p * 2.1 - vec3(uTime * 0.02, 0.0, uTime * 0.014));
    // Wide, soft threshold: plenty of the sky carries visible cloud, the low
    // end still reaches zero so gaps stay genuinely transparent and the
    // starfield reads through them, and the gradient is gentle enough that
    // cloud edges feather instead of cutting hard silhouettes.
    float cloud = smoothstep(-0.42, 0.46, slow * 0.7 + fast * 0.3);

    vec3 deepViolet = vec3(0.16, 0.07, 0.34);
    vec3 cyan       = vec3(0.16, 0.62, 0.78);
    vec3 rose       = vec3(0.78, 0.26, 0.55);
    vec3 gold       = vec3(0.95, 0.78, 0.44);

    // Band the palette by altitude so the horizon and zenith differ.
    float altitude = dir.y * 0.5 + 0.5;
    vec3 color = mix(rose, cyan, smoothstep(0.15, 0.75, altitude));
    color = mix(deepViolet, color, cloud);

    // Coherence pulls the whole field toward warm gold.
    color = mix(color, gold, uCoherence * 0.42 * cloud);

    // Lift brightness so the wisps actually glow against the void. Brightness
    // is the right dial here, NOT an alpha floor -- flooring alpha turns the
    // empty stretches into an opaque dark mass that swallows the starfield.
    color *= 1.55;

    // Fade out near the horizon so the nebula doesn't fight the ground plane.
    float horizonFade = smoothstep(-0.25, 0.12, dir.y);
    float alpha = cloud * horizonFade * mix(0.6, 1.0, uDensity);

    gl_FragColor = vec4(color, alpha);
  }
`;

function createNebula(): Nebula {
  const material = new THREE.ShaderMaterial({
    vertexShader: NEBULA_VERTEX_SHADER,
    fragmentShader: NEBULA_FRAGMENT_SHADER,
    uniforms: {
      uTime: { value: 0 },
      uCoherence: { value: 0.5 },
      uDensity: { value: 0.5 },
    },
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    fog: false,
  });

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(NEBULA_RADIUS, 48, 32), material);

  return {
    mesh,
    setTime: (value) => void (material.uniforms.uTime.value = value),
    setCoherence: (value) => void (material.uniforms.uCoherence.value = value),
    setDensity: (value) => void (material.uniforms.uDensity.value = value),
  };
}

// ---------------------------------------------------------------------------
// Gas giant: the majestic anchor of the skyline. Banded shader body, an
// oblique ring, and a soft additive halo.
// ---------------------------------------------------------------------------
const GIANT_VERTEX_SHADER = `
  varying vec3 vNormalW;
  varying vec3 vPositionL;
  void main() {
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vPositionL = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const GIANT_FRAGMENT_SHADER = `
  varying vec3 vNormalW;
  varying vec3 vPositionL;
  uniform float uTime;

  ${NOISE_GLSL}

  void main() {
    // Latitude banding, warped by noise so the bands churn like real
    // atmosphere instead of reading as painted stripes.
    float lat = vPositionL.y / ${GAS_GIANT_RADIUS.toFixed(1)};
    float warp = fbm(vec3(vPositionL.xz * 0.012, uTime * 0.015)) * 0.35;
    float bands = sin((lat + warp) * 11.0);

    vec3 dark  = vec3(0.28, 0.15, 0.34);
    vec3 mid   = vec3(0.55, 0.33, 0.52);
    vec3 light = vec3(0.85, 0.66, 0.62);

    vec3 color = mix(dark, mid, smoothstep(-1.0, 0.2, bands));
    color = mix(color, light, smoothstep(0.35, 1.0, bands));

    // Cheap terminator so the sphere reads as lit from one side.
    float lambert = clamp(dot(vNormalW, normalize(vec3(0.6, 0.35, 0.7))), 0.0, 1.0);
    color *= mix(0.28, 1.0, lambert);

    // Rim light along the limb.
    float rim = pow(1.0 - abs(dot(vNormalW, vec3(0.0, 0.0, 1.0))), 3.0);
    color += vec3(0.45, 0.32, 0.6) * rim * 0.5;

    gl_FragColor = vec4(color, 1.0);
  }
`;

function createGasGiant(): { group: THREE.Group; update(delta: number, elapsed: number): void } {
  const group = new THREE.Group();
  group.position.copy(GAS_GIANT_POSITION);

  const material = new THREE.ShaderMaterial({
    vertexShader: GIANT_VERTEX_SHADER,
    fragmentShader: GIANT_FRAGMENT_SHADER,
    uniforms: { uTime: { value: 0 } },
    fog: false,
  });

  const body = new THREE.Mesh(new THREE.SphereGeometry(GAS_GIANT_RADIUS, 64, 48), material);
  group.add(body);

  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(GAS_GIANT_RADIUS * 1.14, 32, 24),
    new THREE.MeshBasicMaterial({
      color: '#8f6fd6',
      transparent: true,
      opacity: 0.14,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    })
  );
  group.add(halo);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(GAS_GIANT_RADIUS * 1.4, GAS_GIANT_RADIUS * 2.15, 128),
    new THREE.MeshBasicMaterial({
      map: createRingTexture(),
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      depthWrite: false,
      fog: false,
    })
  );
  ring.rotation.x = Math.PI / 2 - 0.42;
  ring.rotation.y = 0.22;
  group.add(ring);

  return {
    group,
    update(delta, elapsed) {
      material.uniforms.uTime.value = elapsed;
      body.rotation.y += delta * 0.01;
    },
  };
}

/** Concentric banded ring, drawn to a canvas -- alpha gaps read as Cassini divisions. */
function createRingTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = 8;
  const ctx = canvas.getContext('2d')!;

  const gradient = ctx.createLinearGradient(0, 0, size, 0);
  const stops: Array<[number, string]> = [
    [0.0, 'rgba(180,150,210,0)'],
    [0.08, 'rgba(198,170,220,0.55)'],
    [0.24, 'rgba(226,205,238,0.75)'],
    [0.32, 'rgba(120,100,150,0.15)'],
    [0.42, 'rgba(232,212,240,0.8)'],
    [0.63, 'rgba(200,175,225,0.62)'],
    [0.70, 'rgba(110,95,140,0.1)'],
    [0.80, 'rgba(215,192,232,0.66)'],
    [1.0, 'rgba(170,145,200,0)'],
  ];
  for (const [offset, color] of stops) gradient.addColorStop(offset, color);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, 8);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

// ---------------------------------------------------------------------------
// Two small moons on separate inclined orbits.
// ---------------------------------------------------------------------------
function createMoons(): { group: THREE.Group; update(delta: number): void } {
  const group = new THREE.Group();

  const specs = [
    { radius: 9, orbit: 300, height: 165, speed: 0.011, tilt: 0.32, color: '#d9d3e8' },
    { radius: 5.5, orbit: 385, height: 205, speed: -0.007, tilt: -0.5, color: '#c8b6d8' },
  ];

  const moons = specs.map((spec) => {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(spec.radius, 24, 20),
      new THREE.MeshBasicMaterial({ color: spec.color, fog: false })
    );
    group.add(mesh);
    return { mesh, spec, angle: Math.random() * Math.PI * 2 };
  });

  return {
    group,
    update(delta) {
      for (const moon of moons) {
        moon.angle += moon.spec.speed * delta;
        moon.mesh.position.set(
          Math.cos(moon.angle) * moon.spec.orbit,
          moon.spec.height + Math.sin(moon.angle) * moon.spec.orbit * moon.spec.tilt * 0.35,
          Math.sin(moon.angle) * moon.spec.orbit
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Ground: a dark near-mirror plane. Not earth -- a surface suspended in the
// void, with a faint hex-ish energy lattice that brightens with coherence.
// ---------------------------------------------------------------------------
interface VoidGround {
  mesh: THREE.Mesh;
  setTime(value: number): void;
  setCoherence(value: number): void;
}

const GROUND_VERTEX_SHADER = `
  varying vec2 vWorldXZ;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldXZ = world.xz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const GROUND_FRAGMENT_SHADER = `
  varying vec2 vWorldXZ;
  uniform float uTime;
  uniform float uCoherence;

  ${NOISE_GLSL}

  void main() {
    float dist = length(vWorldXZ);

    // Lattice: two rotated line families, so it reads as woven rather than
    // as a plain square grid.
    vec2 a = vWorldXZ;
    vec2 b = mat2(0.5, -0.866, 0.866, 0.5) * vWorldXZ;
    float lineA = abs(fract(a.x * 0.09) - 0.5);
    float lineB = abs(fract(b.x * 0.09) - 0.5);
    float lattice = (1.0 - smoothstep(0.0, 0.06, lineA)) + (1.0 - smoothstep(0.0, 0.06, lineB));
    lattice = clamp(lattice, 0.0, 1.0);

    // A slow pulse travelling outward from origin -- the ground breathing.
    float pulse = sin(dist * 0.06 - uTime * 0.55) * 0.5 + 0.5;
    pulse = pow(pulse, 3.0);

    float shimmer = fbm(vec3(vWorldXZ * 0.02, uTime * 0.05)) * 0.5 + 0.5;

    vec3 cold = vec3(0.24, 0.16, 0.48);
    vec3 warm = vec3(0.92, 0.74, 0.42);
    vec3 accent = mix(cold, warm, uCoherence);

    vec3 base = vec3(0.016, 0.012, 0.036);
    vec3 color = base + accent * lattice * (0.10 + 0.22 * pulse) * mix(0.5, 1.0, uCoherence);
    color += accent * shimmer * 0.035;

    // Fade the lattice out with distance so the plane dissolves into void
    // instead of terminating at a hard visible edge.
    float fade = 1.0 - smoothstep(60.0, 240.0, dist);
    color = mix(base, color, fade);

    gl_FragColor = vec4(color, 1.0);
  }
`;

function createVoidGround(): VoidGround {
  const material = new THREE.ShaderMaterial({
    vertexShader: GROUND_VERTEX_SHADER,
    fragmentShader: GROUND_FRAGMENT_SHADER,
    uniforms: {
      uTime: { value: 0 },
      uCoherence: { value: 0.5 },
    },
    // Deliberately NOT fog:true -- a raw ShaderMaterial would then need
    // THREE.UniformsLib.fog merged in and the fog GLSL chunks included, or
    // three's refreshFogUniforms() throws on the missing uniforms. The
    // distance fade at the end of the fragment shader does this job anyway.
    fog: false,
  });

  const mesh = new THREE.Mesh(new THREE.CircleGeometry(300, 96), material);
  mesh.rotation.x = -Math.PI / 2;

  return {
    mesh,
    setTime: (value) => void (material.uniforms.uTime.value = value),
    setCoherence: (value) => void (material.uniforms.uCoherence.value = value),
  };
}

// ---------------------------------------------------------------------------
// Slabs: large fractured platforms hanging at wide radii and varied heights,
// including below the ground plane, to sell the sense of open vertical space.
// Static (they're architecture, not weather), so a single InstancedMesh.
// ---------------------------------------------------------------------------
function createSlabs(): { mesh: THREE.InstancedMesh } {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  // Emissive floor keeps these from silhouetting as flat black cutouts when
  // they pass in front of the gas giant -- they should read as stone catching
  // distant light, not as holes punched in the sky.
  const material = new THREE.MeshStandardMaterial({
    color: '#2c2447',
    emissive: new THREE.Color('#171233'),
    emissiveIntensity: 1,
    roughness: 0.8,
    metalness: 0.2,
    flatShading: true,
  });

  const mesh = new THREE.InstancedMesh(geometry, material, SLAB_COUNT);
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const euler = new THREE.Euler();

  for (let i = 0; i < SLAB_COUNT; i++) {
    const angle = Math.random() * Math.PI * 2;
    // Push the near edge out so nothing looms directly over the avatars, and
    // keep the vertical spread tighter so slabs don't stack up across the
    // skyline.
    const radius = 90 + Math.random() * 170;
    const height = (Math.random() - 0.5) * 55;

    euler.set(
      (Math.random() - 0.5) * 0.5,
      Math.random() * Math.PI * 2,
      (Math.random() - 0.5) * 0.5
    );
    quaternion.setFromEuler(euler);

    matrix.compose(
      new THREE.Vector3(Math.cos(angle) * radius, height, Math.sin(angle) * radius),
      quaternion,
      new THREE.Vector3(
        8 + Math.random() * 34,
        1.5 + Math.random() * 6,
        8 + Math.random() * 34
      )
    );
    mesh.setMatrixAt(i, matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;

  return { mesh };
}

// ---------------------------------------------------------------------------
// Shards: drifting crystal fragments. Count tracks memory load; orientation
// tracks coherence -- tumbling on individual random axes when scattered,
// settling toward a shared alignment as retrieval sharpens.
// ---------------------------------------------------------------------------
interface Shards {
  mesh: THREE.InstancedMesh;
  setVisibleCount(count: number): void;
  setCoherence(value: number): void;
  update(delta: number, elapsed: number, coherence: number): void;
}

function createShards(): Shards {
  // Octahedron reads as a crystal without needing a modelled asset.
  const geometry = new THREE.OctahedronGeometry(1, 0);
  const material = new THREE.MeshStandardMaterial({
    color: '#9d86ff',
    emissive: new THREE.Color('#3d2a7a'),
    emissiveIntensity: 1.0,
    roughness: 0.25,
    metalness: 0.5,
    transparent: true,
    opacity: 0.85,
    flatShading: true,
  });

  const mesh = new THREE.InstancedMesh(geometry, material, SHARD_COUNT);
  mesh.count = MIN_VISIBLE_SHARDS;
  mesh.frustumCulled = false;

  interface ShardState {
    base: THREE.Vector3;
    scale: THREE.Vector3;
    spinAxis: THREE.Vector3;
    spinSpeed: number;
    phase: number;
    bobAmplitude: number;
  }

  const states: ShardState[] = [];
  for (let i = 0; i < SHARD_COUNT; i++) {
    const angle = Math.random() * Math.PI * 2;
    const radius = 12 + Math.sqrt(Math.random()) * SHARD_FIELD_RADIUS;
    const size = 0.5 + Math.random() * 2.4;
    states.push({
      base: new THREE.Vector3(
        Math.cos(angle) * radius,
        2 + Math.random() * 45,
        Math.sin(angle) * radius
      ),
      scale: new THREE.Vector3(size * 0.5, size * (1.4 + Math.random()), size * 0.5),
      spinAxis: new THREE.Vector3(
        Math.random() - 0.5,
        Math.random() - 0.5,
        Math.random() - 0.5
      ).normalize(),
      spinSpeed: 0.08 + Math.random() * 0.3,
      phase: Math.random() * Math.PI * 2,
      bobAmplitude: 0.6 + Math.random() * 2.2,
    });
  }

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const chaotic = new THREE.Quaternion();
  const aligned = new THREE.Quaternion();
  const blended = new THREE.Quaternion();
  const alignedEuler = new THREE.Euler(0, 0, 0);
  const upAxis = new THREE.Vector3(0, 1, 0);

  return {
    mesh,

    setVisibleCount(count) {
      mesh.count = THREE.MathUtils.clamp(count, 0, SHARD_COUNT);
    },

    setCoherence(value) {
      // Warmer and brighter as things cohere.
      material.emissiveIntensity = THREE.MathUtils.lerp(0.6, 1.9, value);
      material.color.setHex(0x9d86ff).lerp(new THREE.Color('#ffd79a'), value * 0.7);
      material.emissive.setHex(0x3d2a7a).lerp(new THREE.Color('#7a5a24'), value * 0.7);
    },

    update(delta, elapsed, coherence) {
      const visible = mesh.count;
      for (let i = 0; i < visible; i++) {
        const state = states[i];

        position.copy(state.base);
        position.y += Math.sin(elapsed * 0.25 + state.phase) * state.bobAmplitude;

        // Chaotic: each shard tumbling about its own axis.
        chaotic.setFromAxisAngle(state.spinAxis, elapsed * state.spinSpeed + state.phase);
        // Ordered: all shards standing upright on a shared slow rotation.
        alignedEuler.set(0, elapsed * 0.05 + state.phase * 0.1, 0);
        aligned.setFromEuler(alignedEuler);

        blended.copy(chaotic).slerp(aligned, coherence);

        matrix.compose(position, blended, state.scale);
        mesh.setMatrixAt(i, matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      // Keep the unused tail from being interpreted as stale geometry.
      void upAxis;
    },
  };
}

// ---------------------------------------------------------------------------
// Motes: fine dust rising through the space. Density tracks memory load.
// ---------------------------------------------------------------------------
interface Motes {
  points: THREE.Points;
  setDensity(value: number): void;
  setCoherence(value: number): void;
  update(delta: number): void;
}

function createMotes(): Motes {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(MOTE_COUNT * 3);
  const speeds = new Float32Array(MOTE_COUNT);

  for (let i = 0; i < MOTE_COUNT; i++) {
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.sqrt(Math.random()) * MOTE_FIELD_RADIUS;
    positions[i * 3] = Math.cos(angle) * radius;
    positions[i * 3 + 1] = Math.random() * MOTE_CEILING;
    positions[i * 3 + 2] = Math.sin(angle) * radius;
    speeds[i] = 0.4 + Math.random() * 1.2;
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setDrawRange(0, Math.round(MOTE_COUNT * 0.4));

  const material = new THREE.PointsMaterial({
    color: '#cbb8ff',
    size: 0.28,
    transparent: true,
    opacity: 0.55,
    sizeAttenuation: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;

  return {
    points,

    setDensity(value) {
      const count = Math.round(THREE.MathUtils.lerp(MOTE_COUNT * 0.15, MOTE_COUNT, value));
      geometry.setDrawRange(0, count);
    },

    setCoherence(value) {
      material.color.setHex(0xcbb8ff).lerp(new THREE.Color('#ffe0ad'), value * 0.8);
      material.opacity = THREE.MathUtils.lerp(0.4, 0.75, value);
    },

    update(delta) {
      const array = geometry.attributes.position.array as Float32Array;
      const visible = geometry.drawRange.count;
      for (let i = 0; i < visible; i++) {
        const y = i * 3 + 1;
        array[y] += speeds[i] * MOTE_RISE_SPEED * delta;
        if (array[y] > MOTE_CEILING) array[y] = 0;
      }
      geometry.attributes.position.needsUpdate = true;
    },
  };
}

// ---------------------------------------------------------------------------
// Starfield behind the nebula.
// ---------------------------------------------------------------------------
function createStarfield(): THREE.Points {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i++) {
    // Full sphere here, not just the upper hemisphere -- this world has no
    // opaque horizon, so stars below eye level are correct.
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3] = STAR_SHELL_RADIUS * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = STAR_SHELL_RADIUS * Math.cos(phi);
    positions[i * 3 + 2] = STAR_SHELL_RADIUS * Math.sin(phi) * Math.sin(theta);
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      color: '#eae6ff',
      size: 1.2,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.85,
      fog: false,
    })
  );
}
