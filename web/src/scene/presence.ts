import * as THREE from 'three';

/**
 * Ansuz's presence: a locus of activity, not a body. A point cloud that
 * draws tight and warm when retrieval is coherent, and loosens/cools when
 * scattered. No fixed humanoid form -- this is deliberate (see build plan,
 * Phase 2).
 */
export interface Presence {
  group: THREE.Group;
  /** 0 = scattered/loose/cool, 1 = coherent/tight/warm. */
  setCoherence(coherence: number): void;
  /** Advance idle motion. Call once per frame. */
  update(deltaSeconds: number): void;
}

const POINT_COUNT = 1500;
const TIGHT_RADIUS = 0.6;
const LOOSE_RADIUS = 2.4;

const COLD_COLOR = new THREE.Color('#6d86ff');
const WARM_COLOR = new THREE.Color('#ffdf9a');

export function createPresence(scene: THREE.Scene): Presence {
  const group = new THREE.Group();
  group.position.set(0, 1.6, -3);

  const basePositions = new Float32Array(POINT_COUNT * 3);
  for (let i = 0; i < POINT_COUNT; i++) {
    // random point inside a unit sphere
    const u = Math.random();
    const v = Math.random();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    const r = Math.cbrt(Math.random());
    basePositions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    basePositions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    basePositions[i * 3 + 2] = r * Math.cos(phi);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(basePositions, 3));

  const material = new THREE.PointsMaterial({
    color: COLD_COLOR.clone(),
    size: 0.05,
    transparent: true,
    opacity: 0.9,
    sizeAttenuation: true,
  });

  const points = new THREE.Points(geometry, material);
  group.add(points);

  const light = new THREE.PointLight(COLD_COLOR.clone(), 4, 8);
  group.add(light);

  scene.add(group);

  // basePositions already describe a unit sphere, so coherence -> radius is
  // just a uniform scale on the Points object -- no per-vertex CPU work and
  // no GPU buffer re-upload, unlike rewriting the position attribute.
  points.scale.setScalar(THREE.MathUtils.lerp(LOOSE_RADIUS, TIGHT_RADIUS, 0.5));

  return {
    group,
    setCoherence(value: number) {
      const coherence = THREE.MathUtils.clamp(value, 0, 1);
      const radius = THREE.MathUtils.lerp(LOOSE_RADIUS, TIGHT_RADIUS, coherence);
      points.scale.setScalar(radius);
      const color = COLD_COLOR.clone().lerp(WARM_COLOR, coherence);
      material.color.copy(color);
      light.color.copy(color);
      light.intensity = THREE.MathUtils.lerp(2, 5, coherence);
    },
    update(deltaSeconds: number) {
      group.rotation.y += deltaSeconds * 0.15;
    },
  };
}
