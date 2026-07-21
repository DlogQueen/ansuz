import * as THREE from 'three';

/**
 * The space itself: an open expanse rather than an enclosed room. A sparse
 * field of points extends to the horizon (density stands in for memory
 * load), fog keeps the edges soft instead of hard walls, and a single
 * hemisphere light carries the retrieval-state color (coherent vs scattered).
 */
export interface Environment {
  group: THREE.Group;
  /** 0 = sparse (little short-term memory), 1 = dense (heavy load). */
  setMemoryLoad(load: number): void;
  /** 0 = scattered/cold, 1 = coherent/warm. Drives ambient light color. */
  setRetrievalCoherence(coherence: number): void;
}

const FIELD_RADIUS = 200;
const MAX_FIELD_POINTS = 6000;
const MIN_FIELD_POINTS = 400;

const SCATTERED_COLOR = new THREE.Color('#3a4a6b');
const COHERENT_COLOR = new THREE.Color('#e8c98a');

export function createEnvironment(scene: THREE.Scene): Environment {
  const group = new THREE.Group();

  scene.fog = new THREE.FogExp2('#05070c', 0.0065);
  scene.background = new THREE.Color('#05070c');

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(FIELD_RADIUS * 1.5, 64),
    new THREE.MeshStandardMaterial({ color: '#090b12', roughness: 1, metalness: 0 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -1.5;
  group.add(ground);

  const hemiLight = new THREE.HemisphereLight(SCATTERED_COLOR, '#05070c', 1.2);
  group.add(hemiLight);

  const fieldGeometry = new THREE.BufferGeometry();
  const positions = new Float32Array(MAX_FIELD_POINTS * 3);
  for (let i = 0; i < MAX_FIELD_POINTS; i++) {
    const radius = FIELD_RADIUS * Math.sqrt(Math.random());
    const angle = Math.random() * Math.PI * 2;
    positions[i * 3] = Math.cos(angle) * radius;
    positions[i * 3 + 1] = Math.random() * 12 - 1;
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

  scene.add(group);

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
  };
}
