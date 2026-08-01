import * as THREE from 'three';
import { createGlowMaterial, type GlowMaterial } from '../shaders/glowMaterial.js';
import { createPlasmaMaterial, updatePlasmaMaterial, type PlasmaMaterial } from '../shaders/plasmaMaterial.js';
import { createStationFloorMaterial, updateStationFloorMaterial } from '../shaders/stationFloorMaterial.js';
import type { Collider } from '../core/player.js';

const STATION_RADIUS = 36;
const PLAYER_RADIUS = 0.4;
const ARRAY_POSITION = new THREE.Vector3(0, 0, -30);
const ARRAY_RADIUS = 3.2;
const ARRAY_DURATION = 5;
const HAZARD_COOLDOWN = 1.4;

export interface Mission2Result {
  nearArray: boolean;
  arrayProgress: number;
  arrayComplete: boolean;
  hazardHit: boolean;
}

interface HazardBand {
  pivot: THREE.Group;
  mesh: THREE.Mesh;
  material: PlasmaMaterial;
  baseX: number;
  amplitude: number;
  speed: number;
  phase: number;
  halfWidth: number;
  halfHeight: number;
  cooldown: number;
}

export interface Mission2Scene {
  group: THREE.Group;
  colliders: Collider[];
  spawnPosition: THREE.Vector3;
  update(delta: number, playerPosition: THREE.Vector3, interactHeld: boolean): Mission2Result;
  dispose(): void;
}

function buildStarfield(): THREE.Points {
  const count = 3000;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const galaxyColor = new THREE.Color('#ffd9a0');
  const voidColor = new THREE.Color('#7f9dff');

  for (let i = 0; i < count; i++) {
    const dir = new THREE.Vector3().randomDirection();
    const radius = 200 + Math.random() * 300;
    dir.multiplyScalar(radius);
    positions[i * 3] = dir.x;
    positions[i * 3 + 1] = Math.abs(dir.y) * 0.5 + 20;
    positions[i * 3 + 2] = dir.z;

    const towardGalaxy = THREE.MathUtils.clamp(dir.z / radius, 0, 1);
    const color = voidColor.clone().lerp(galaxyColor, towardGalaxy * Math.random());
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({
    size: 1.4,
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
    sizeAttenuation: true,
  });
  return new THREE.Points(geometry, material);
}

function buildPillars(): { group: THREE.Group; colliders: Collider[] } {
  const group = new THREE.Group();
  const colliders: Collider[] = [];
  const material = new THREE.MeshStandardMaterial({
    color: '#141a2c',
    emissive: '#28f5ff',
    emissiveIntensity: 0.25,
    roughness: 0.4,
    metalness: 0.7,
  });

  const count = 14;
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const radius = STATION_RADIUS - 3;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    const height = 3 + Math.random() * 2;
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.6, height, 8), material);
    pillar.position.set(x, height / 2, z);
    group.add(pillar);
    colliders.push({ position: new THREE.Vector3(x, 0, z), radius: 0.65 });
  }

  return { group, colliders };
}

function buildHazardBand(z: number, amplitude: number, speed: number, phase: number): HazardBand {
  const material = createPlasmaMaterial({ colorA: '#7a2bff', colorB: '#28f5ff' });
  const width = 9;
  const height = 5.5;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height, 24, 12), material);
  mesh.position.y = height / 2;

  const pivot = new THREE.Group();
  pivot.position.set(0, 0, z);
  pivot.add(mesh);

  return {
    pivot,
    mesh,
    material,
    baseX: 0,
    amplitude,
    speed,
    phase,
    halfWidth: width / 2,
    halfHeight: height / 2,
    cooldown: 0,
  };
}

function buildTransporterArray(): THREE.Group {
  const group = new THREE.Group();
  const glow = createGlowMaterial('#28f5ff', 2.6);

  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(2.4, 2.6, 0.4, 24),
    new THREE.MeshStandardMaterial({ color: '#0e1524', emissive: '#123047', roughness: 0.3, metalness: 0.6 })
  );
  base.position.y = 0.2;
  group.add(base);

  const rings: THREE.Mesh[] = [];
  for (let i = 0; i < 3; i++) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.4 + i * 0.5, 0.06, 8, 40), glow);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.6 + i * 0.5;
    group.add(ring);
    rings.push(ring);
  }

  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5, 1), glow);
  core.position.y = 2.2;
  group.add(core);

  const light = new THREE.PointLight('#28f5ff', 3, 16);
  light.position.y = 2.2;
  group.add(light);

  group.userData.rings = rings;
  group.userData.core = core;
  group.userData.light = light;
  return group;
}

export function createMission2Scene(scene: THREE.Scene): Mission2Scene {
  const group = new THREE.Group();
  scene.add(group);

  scene.background = new THREE.Color('#02040c');
  scene.fog = new THREE.FogExp2('#050814', 0.012);

  const hemi = new THREE.HemisphereLight('#6f9fff', '#0d1830', 1.5);
  const key = new THREE.DirectionalLight('#c8dcff', 1.2);
  key.position.set(10, 30, 10);
  const ambient = new THREE.AmbientLight('#3a5c8f', 0.4);
  group.add(hemi, key, ambient);

  group.add(buildStarfield());

  const floorMaterial = createStationFloorMaterial();
  const floor = new THREE.Mesh(new THREE.CircleGeometry(STATION_RADIUS, 64), floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  group.add(floor);

  const { group: pillarGroup, colliders: pillarColliders } = buildPillars();
  group.add(pillarGroup);

  const hazardBands: HazardBand[] = [
    buildHazardBand(20, 5, 0.5, 0),
    buildHazardBand(10, 6, 0.4, 1.4),
    buildHazardBand(0, 5.5, 0.6, 2.8),
    buildHazardBand(-10, 6, 0.45, 0.7),
    buildHazardBand(-20, 5, 0.55, 3.6),
  ];
  for (const band of hazardBands) group.add(band.pivot);

  const array = buildTransporterArray();
  array.position.copy(ARRAY_POSITION);
  group.add(array);

  const colliders: Collider[] = pillarColliders;
  const spawnPosition = new THREE.Vector3(0, 0, 32);

  let arrayProgress = 0;
  let arrayComplete = false;
  let elapsed = 0;

  const localPoint = new THREE.Vector3();
  const pushDir = new THREE.Vector3();

  function update(delta: number, playerPosition: THREE.Vector3, interactHeld: boolean): Mission2Result {
    elapsed += delta;
    updateStationFloorMaterial(floorMaterial, delta);

    const distFromCenter = Math.hypot(playerPosition.x, playerPosition.z);
    const maxDist = STATION_RADIUS - PLAYER_RADIUS - 1;
    if (distFromCenter > maxDist) {
      const scale = maxDist / distFromCenter;
      playerPosition.x *= scale;
      playerPosition.z *= scale;
    }

    let hazardHit = false;
    for (const band of hazardBands) {
      updatePlasmaMaterial(band.material, delta);
      band.cooldown = Math.max(0, band.cooldown - delta);

      const offset = Math.sin(elapsed * band.speed + band.phase) * band.amplitude;
      band.pivot.position.x = band.baseX + offset;
      band.pivot.updateMatrixWorld(true);

      localPoint.copy(playerPosition);
      band.mesh.worldToLocal(localPoint);
      const within =
        Math.abs(localPoint.z) < 0.9 &&
        Math.abs(localPoint.x) < band.halfWidth &&
        localPoint.y > -0.2 &&
        localPoint.y < band.halfHeight * 2 + 0.2;

      band.material.uniforms.uDanger.value = THREE.MathUtils.lerp(
        band.material.uniforms.uDanger.value,
        within ? 1 : 0,
        Math.min(1, delta * 6)
      );

      if (within && band.cooldown <= 0) {
        band.cooldown = HAZARD_COOLDOWN;
        hazardHit = true;
        pushDir.set(localPoint.x, 0, 0).normalize();
        if (!isFinite(pushDir.x) || pushDir.lengthSq() === 0) pushDir.set(0, 0, 1);
        pushDir.applyQuaternion(band.mesh.getWorldQuaternion(new THREE.Quaternion()));
        playerPosition.addScaledVector(pushDir, 1.6);
      }
    }

    const arrayFlat = new THREE.Vector3(ARRAY_POSITION.x, playerPosition.y, ARRAY_POSITION.z);
    const nearArray = playerPosition.distanceTo(arrayFlat) < ARRAY_RADIUS;

    if (nearArray && interactHeld && !arrayComplete) {
      arrayProgress = Math.min(1, arrayProgress + delta / ARRAY_DURATION);
      if (arrayProgress >= 1) arrayComplete = true;
    }

    const rings = array.userData.rings as THREE.Mesh[];
    const core = array.userData.core as THREE.Mesh;
    const light = array.userData.light as THREE.PointLight;
    rings.forEach((ring, i) => {
      ring.rotation.z += delta * (0.3 + i * 0.15) * (1 + arrayProgress * 2);
    });
    core.rotation.y += delta * 0.8;
    light.intensity = 3 + Math.sin(elapsed * 3) * 0.5 + arrayProgress * 4;

    return { nearArray, arrayProgress, arrayComplete, hazardHit };
  }

  function dispose() {
    scene.remove(group);
    scene.fog = null;
    group.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Points) {
        obj.geometry.dispose();
        const material = obj.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material.dispose();
      }
    });
  }

  return { group, colliders, spawnPosition, update, dispose };
}
