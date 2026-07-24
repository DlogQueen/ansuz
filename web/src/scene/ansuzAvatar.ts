import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { createGlowMaterial, SCATTERED_COLOR, COHERENT_COLOR } from '../materials/glowMaterial.js';

/**
 * Ansuz's body (Mixamo X Bot, "Breathing Idle" -- placeholder rig/animation
 * only). Reskinned with the translucent fresnel-glow ShaderMaterial from the
 * design spec ([[ansuz-avatar-design]] in project memory) plus an internal
 * spine/head THREE.Points glow. Still missing from that spec: the exposed
 * mechanical joint/circuitry detail, which is texture/normal-map authoring
 * work, not shader work -- no assets for that exist yet.
 */
export interface AnsuzAvatar {
  group: THREE.Group;
  update(deltaSeconds: number): void;
  setCoherence(coherence: number): void;
}

const MODEL_URL = '/models/ansuz-base.fbx';
// Mixamo exports characters in centimeters; three.js/glTF convention is
// meters, so scale down by 100x on load.
const MIXAMO_TO_METERS = 0.01;

// Internal glow roughly spans hip to crown on a ~1.75m rigged figure --
// approximate rather than measured off the mesh, since it only needs to read
// as "light along the spine," not track the skeleton precisely.
const INTERNAL_POINT_COUNT = 200;
const SPINE_MIN_Y = 0.9;
const SPINE_MAX_Y = 1.75;
const SPINE_JITTER = 0.08;

function createInternalGlow() {
  const positions = new Float32Array(INTERNAL_POINT_COUNT * 3);
  for (let i = 0; i < INTERNAL_POINT_COUNT; i++) {
    positions[i * 3] = (Math.random() - 0.5) * SPINE_JITTER;
    positions[i * 3 + 1] = SPINE_MIN_Y + Math.random() * (SPINE_MAX_Y - SPINE_MIN_Y);
    positions[i * 3 + 2] = (Math.random() - 0.5) * SPINE_JITTER;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const material = new THREE.PointsMaterial({
    color: SCATTERED_COLOR.clone(),
    size: 0.03,
    transparent: true,
    opacity: 0.6,
    sizeAttenuation: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  const points = new THREE.Points(geometry, material);

  return {
    points,
    setCoherence(coherence: number) {
      const clamped = THREE.MathUtils.clamp(coherence, 0, 1);
      (material.color as THREE.Color).copy(SCATTERED_COLOR.clone().lerp(COHERENT_COLOR, clamped));
      material.opacity = THREE.MathUtils.lerp(0.4, 0.9, clamped);
    },
  };
}

export async function createAnsuzAvatar(scene: THREE.Scene): Promise<AnsuzAvatar> {
  const loader = new FBXLoader();
  const object = await loader.loadAsync(MODEL_URL);

  object.scale.setScalar(MIXAMO_TO_METERS);

  const glow = createGlowMaterial();
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.material = glow.material;
    }
  });

  const internalGlow = createInternalGlow();

  const group = new THREE.Group();
  group.add(object);
  group.add(internalGlow.points);
  scene.add(group);

  const mixer = new THREE.AnimationMixer(object);
  // Mixamo FBX exports carry a leading empty "Take 001" reference clip
  // (0 duration, 0 tracks) alongside the real animation -- play whichever
  // clip actually has motion rather than assuming index 0.
  const clip = object.animations.find((candidate) => candidate.duration > 0);
  if (clip) {
    mixer.clipAction(clip).play();
  }

  return {
    group,
    update(deltaSeconds: number) {
      mixer.update(deltaSeconds);
    },
    setCoherence(coherence: number) {
      glow.setCoherence(coherence);
      internalGlow.setCoherence(coherence);
    },
  };
}
