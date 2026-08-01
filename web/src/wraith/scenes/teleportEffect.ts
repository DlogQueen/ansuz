import * as THREE from 'three';
import { createGlowMaterial } from '../shaders/glowMaterial.js';

const DURATION = 4.8;
const RING_COUNT = 8;
const PARTICLE_COUNT = 120;

export interface TeleportEffect {
  group: THREE.Group;
  duration: number;
  update(delta: number): { progress: number; complete: boolean };
  dispose(): void;
}

/**
 * Quantum Transition: 8 spinning entanglement rings collapsing inward
 * around the player while 120 particles converge to the center, ~4.8s --
 * the visual bridge between mission 1's beacon scan and Sophia waking up
 * in her new Skin at Galactic Base: Relatively.
 */
export function createTeleportEffect(scene: THREE.Scene, center: THREE.Vector3): TeleportEffect {
  const group = new THREE.Group();
  group.position.copy(center);
  scene.add(group);

  scene.background = new THREE.Color('#020105');
  scene.fog = null;

  const rings: THREE.Mesh[] = [];
  for (let i = 0; i < RING_COUNT; i++) {
    const radius = 0.6 + i * 0.35;
    const hue = 0.55 + (i / RING_COUNT) * 0.25;
    const color = new THREE.Color().setHSL(hue, 0.9, 0.6);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(radius, 0.015, 8, 64),
      createGlowMaterial(color, 2.5)
    );
    ring.rotation.x = Math.random() * Math.PI;
    ring.rotation.y = Math.random() * Math.PI;
    group.add(ring);
    rings.push(ring);
  }

  const particleGeometry = new THREE.BufferGeometry();
  const startPositions = new Float32Array(PARTICLE_COUNT * 3);
  const positions = new Float32Array(PARTICLE_COUNT * 3);
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const dir = new THREE.Vector3().randomDirection().multiplyScalar(4 + Math.random() * 4);
    startPositions[i * 3] = dir.x;
    startPositions[i * 3 + 1] = dir.y;
    startPositions[i * 3 + 2] = dir.z;
    positions[i * 3] = dir.x;
    positions[i * 3 + 1] = dir.y;
    positions[i * 3 + 2] = dir.z;
  }
  particleGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const particleMaterial = new THREE.PointsMaterial({
    color: '#c99bff',
    size: 0.06,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const particles = new THREE.Points(particleGeometry, particleMaterial);
  group.add(particles);

  const light = new THREE.PointLight('#7ef7e6', 2, 12);
  group.add(light);

  let elapsed = 0;

  function update(delta: number) {
    elapsed += delta;
    const progress = Math.min(elapsed / DURATION, 1);
    const eased = progress * progress * (3 - 2 * progress);

    for (let i = 0; i < RING_COUNT; i++) {
      rings[i].rotation.x += delta * (0.4 + i * 0.05);
      rings[i].rotation.y += delta * (0.3 + i * 0.03);
      rings[i].scale.setScalar(THREE.MathUtils.lerp(1.4, 0.15, eased));
    }

    const posAttr = particleGeometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const sx = startPositions[i * 3];
      const sy = startPositions[i * 3 + 1];
      const sz = startPositions[i * 3 + 2];
      posAttr.setXYZ(i, sx * (1 - eased), sy * (1 - eased), sz * (1 - eased));
    }
    posAttr.needsUpdate = true;
    particleMaterial.opacity = 0.9 * (1 - eased * 0.3);
    light.intensity = 2 + eased * 6;

    return { progress, complete: progress >= 1 };
  }

  function dispose() {
    scene.remove(group);
    for (const ring of rings) {
      ring.geometry.dispose();
      (ring.material as THREE.Material).dispose();
    }
    particleGeometry.dispose();
    particleMaterial.dispose();
  }

  return { group, duration: DURATION, update, dispose };
}
