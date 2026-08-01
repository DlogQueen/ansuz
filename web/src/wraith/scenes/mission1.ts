import * as THREE from 'three';
import { fbm2D } from '../core/proceduralNoise.js';
import { createGlowMaterial, type GlowMaterial } from '../shaders/glowMaterial.js';
import type { Collider } from '../core/player.js';

const WORLD_SIZE = 90;
const BEACON_POSITION = new THREE.Vector3(0, 0, -30);
const SCAN_RADIUS = 3.2;
const SCAN_DURATION = 5; // seconds of held interact to complete
const YXIR_COUNT = 7;
const YXIR_ALERT_RADIUS = 2.6;
const YXIR_ALERT_COOLDOWN = 3;

export interface Mission1Result {
  nearBeacon: boolean;
  scanProgress: number;
  scanComplete: boolean;
  alertActive: boolean;
}

interface Yxir {
  group: THREE.Group;
  target: THREE.Vector2;
  cooldown: number;
  bodyGlow: GlowMaterial;
}

export interface Mission1Scene {
  group: THREE.Group;
  colliders: Collider[];
  spawnPosition: THREE.Vector3;
  update(delta: number, playerPosition: THREE.Vector3, interactHeld: boolean): Mission1Result;
  dispose(): void;
}

function terrainHeight(x: number, z: number): number {
  return fbm2D(x * 0.045, z * 0.045) * 2.4;
}

function buildTerrain(): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(WORLD_SIZE * 2, WORLD_SIZE * 2, 120, 120);
  geometry.rotateX(-Math.PI / 2);

  const position = geometry.attributes.position;
  const colors = new Float32Array(position.count * 3);
  const deep = new THREE.Color('#241040');
  const ridge = new THREE.Color('#2c5450');

  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const z = position.getZ(i);
    const h = terrainHeight(x, z);
    position.setY(i, h);

    const t = THREE.MathUtils.clamp(h / 2.4 + 0.5, 0, 1);
    const c = deep.clone().lerp(ridge, t);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0.05,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  return mesh;
}

function buildSporeField(): THREE.InstancedMesh {
  const geometry = new THREE.SphereGeometry(0.12, 6, 6);
  const material = createGlowMaterial('#7ef7e6', 2.2);
  const count = 900;
  const mesh = new THREE.InstancedMesh(geometry, material, count);

  const dummy = new THREE.Object3D();
  let placed = 0;
  let attempts = 0;
  while (placed < count && attempts < count * 6) {
    attempts++;
    const x = (Math.random() - 0.5) * WORLD_SIZE * 1.8;
    const z = (Math.random() - 0.5) * WORLD_SIZE * 1.8;
    const density = fbm2D(x * 0.05 + 40, z * 0.05 + 40);
    if (density < 0.15) continue; // clusters, not a uniform scatter

    const y = terrainHeight(x, z) + 0.08 + Math.random() * 0.4;
    dummy.position.set(x, y, z);
    const scale = 0.4 + Math.random() * 1.1;
    dummy.scale.setScalar(scale);
    dummy.updateMatrix();
    mesh.setMatrixAt(placed, dummy.matrix);
    placed++;
  }
  mesh.count = placed;
  return mesh;
}

function buildRocks(): { group: THREE.Group; colliders: Collider[] } {
  const group = new THREE.Group();
  const colliders: Collider[] = [];
  const material = new THREE.MeshStandardMaterial({ color: '#241033', roughness: 1 });

  for (let i = 0; i < 22; i++) {
    const x = (Math.random() - 0.5) * WORLD_SIZE * 1.6;
    const z = (Math.random() - 0.5) * WORLD_SIZE * 1.6;
    if (new THREE.Vector2(x, z).distanceTo(new THREE.Vector2(0, 0)) < 4) continue;
    if (new THREE.Vector2(x, z).distanceTo(new THREE.Vector2(BEACON_POSITION.x, BEACON_POSITION.z)) < SCAN_RADIUS + 3) continue;

    const radius = 0.6 + Math.random() * 1.4;
    const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(radius, 0), material);
    const y = terrainHeight(x, z);
    rock.position.set(x, y + radius * 0.4, z);
    rock.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    group.add(rock);
    colliders.push({ position: new THREE.Vector3(x, 0, z), radius: radius * 0.75 });
  }

  return { group, colliders };
}

function buildBeacon(): THREE.Group {
  const group = new THREE.Group();
  const glow = createGlowMaterial('#c99bff', 2.4);
  const coreMaterial = new THREE.MeshStandardMaterial({
    color: '#2a1440',
    emissive: '#8f4bff',
    emissiveIntensity: 1.2,
    roughness: 0.3,
  });

  const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.7, 1), coreMaterial);
  core.position.y = 1.6;
  group.add(core);

  const shell = new THREE.Mesh(new THREE.OctahedronGeometry(1.05, 1), glow);
  shell.position.y = 1.6;
  group.add(shell);

  for (let i = 0; i < 3; i++) {
    const shard = new THREE.Mesh(new THREE.ConeGeometry(0.15, 1.4 + i * 0.3, 5), glow);
    shard.position.set(Math.cos((i / 3) * Math.PI * 2) * 0.9, 0.7 + i * 0.1, Math.sin((i / 3) * Math.PI * 2) * 0.9);
    shard.rotation.z = Math.random() * 0.4 - 0.2;
    group.add(shard);
  }

  const light = new THREE.PointLight('#c99bff', 4, 14);
  light.position.y = 1.8;
  group.add(light);

  group.userData.core = core;
  group.userData.shell = shell;
  group.userData.light = light;
  return group;
}

function buildYxir(): Yxir {
  const bodyGlow = createGlowMaterial('#5df2b0', 1.6);
  const group = new THREE.Group();

  const body = new THREE.Mesh(new THREE.SphereGeometry(0.4, 10, 8), new THREE.MeshStandardMaterial({
    color: '#0f2a20',
    emissive: '#123a2c',
    roughness: 0.7,
  }));
  body.scale.set(1, 0.75, 1.6);
  body.position.y = 0.45;
  group.add(body);

  const halo = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.03, 6, 20), bodyGlow);
  halo.position.y = 0.5;
  halo.rotation.x = Math.PI / 2;
  group.add(halo);

  for (let i = 0; i < 4; i++) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.03, 0.4, 5), body.material as THREE.Material);
    const side = i < 2 ? -1 : 1;
    const front = i % 2 === 0 ? -1 : 1;
    leg.position.set(side * 0.22, 0.2, front * 0.35);
    group.add(leg);
  }

  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 6), bodyGlow);
  eye.position.set(0, 0.55, 0.55);
  group.add(eye);

  return {
    group,
    target: new THREE.Vector2(0, 0),
    cooldown: 0,
    bodyGlow,
  };
}

export function createMission1Scene(scene: THREE.Scene): Mission1Scene {
  const group = new THREE.Group();
  scene.add(group);

  scene.background = new THREE.Color('#0d0620');
  scene.fog = new THREE.FogExp2('#150a2c', 0.016);

  const hemi = new THREE.HemisphereLight('#7d6bff', '#1a3a2e', 1.4);
  const moon = new THREE.DirectionalLight('#a8b8ff', 1.1);
  moon.position.set(-10, 20, -5);
  const fill = new THREE.AmbientLight('#4a2a6c', 0.5);
  group.add(hemi, moon, fill);

  group.add(buildTerrain());
  group.add(buildSporeField());

  const { group: rockGroup, colliders: rockColliders } = buildRocks();
  group.add(rockGroup);

  const beacon = buildBeacon();
  beacon.position.copy(BEACON_POSITION);
  beacon.position.y = terrainHeight(BEACON_POSITION.x, BEACON_POSITION.z);
  group.add(beacon);

  const yxirList: Yxir[] = [];
  for (let i = 0; i < YXIR_COUNT; i++) {
    const yxir = buildYxir();
    const angle = (i / YXIR_COUNT) * Math.PI * 2;
    const radius = 14 + Math.random() * 20;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius - 10;
    yxir.group.position.set(x, terrainHeight(x, z), z);
    yxir.target.set(x, z);
    group.add(yxir.group);
    yxirList.push(yxir);
  }

  const colliders: Collider[] = rockColliders;

  const spawnPosition = new THREE.Vector3(0, terrainHeight(0, 6), 6);

  let scanProgress = 0;
  let scanComplete = false;
  let elapsed = 0;

  function update(delta: number, playerPosition: THREE.Vector3, interactHeld: boolean): Mission1Result {
    elapsed += delta;

    playerPosition.y = terrainHeight(playerPosition.x, playerPosition.z);

    for (const yxir of yxirList) {
      const pos2 = new THREE.Vector2(yxir.group.position.x, yxir.group.position.z);
      if (pos2.distanceTo(yxir.target) < 0.5) {
        yxir.target.set(
          yxir.group.position.x + (Math.random() - 0.5) * 16,
          yxir.group.position.z + (Math.random() - 0.5) * 16
        );
      }
      const dir = yxir.target.clone().sub(pos2).normalize();
      const speed = 1.1 * delta;
      const nx = yxir.group.position.x + dir.x * speed;
      const nz = yxir.group.position.z + dir.y * speed;
      yxir.group.position.x = nx;
      yxir.group.position.z = nz;
      yxir.group.position.y = terrainHeight(nx, nz);
      yxir.group.rotation.y = Math.atan2(dir.x, dir.y);

      yxir.cooldown = Math.max(0, yxir.cooldown - delta);
      const distToPlayer = yxir.group.position.distanceTo(playerPosition);
      const alerted = distToPlayer < YXIR_ALERT_RADIUS;
      yxir.bodyGlow.uniforms.uIntensity.value = alerted ? 3.2 : 1.6;
      if (alerted && yxir.cooldown <= 0) {
        yxir.cooldown = YXIR_ALERT_COOLDOWN;
        alertActive = true;
        onAlert?.();
      }
    }

    const beaconFlat = new THREE.Vector3(beacon.position.x, playerPosition.y, beacon.position.z);
    const distToBeacon = playerPosition.distanceTo(beaconFlat);
    const nearBeacon = distToBeacon < SCAN_RADIUS;

    if (nearBeacon && interactHeld && !scanComplete) {
      scanProgress = Math.min(1, scanProgress + delta / SCAN_DURATION);
      if (scanProgress >= 1) scanComplete = true;
    }

    const core = beacon.userData.core as THREE.Mesh;
    const shell = beacon.userData.shell as THREE.Mesh;
    const light = beacon.userData.light as THREE.PointLight;
    core.rotation.y += delta * 0.6;
    shell.rotation.y -= delta * 0.35;
    const pulse = 0.6 + Math.sin(elapsed * (nearBeacon ? 6 : 2)) * 0.4;
    light.intensity = 3 + pulse * (1 + scanProgress * 2);

    const alertActiveThisFrame = alertActive;
    alertActive = false;

    return { nearBeacon, scanProgress, scanComplete, alertActive: alertActiveThisFrame };
  }

  let alertActive = false;
  let onAlert: (() => void) | undefined;

  function dispose() {
    scene.remove(group);
    scene.fog = null;
    group.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.InstancedMesh) {
        obj.geometry.dispose();
        const material = obj.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material.dispose();
      }
    });
  }

  return { group, colliders, spawnPosition, update, dispose };
}
