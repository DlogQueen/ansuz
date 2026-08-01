import * as THREE from 'three';
import type { InputState } from './input.js';

const MOVE_SPEED = 3.2;
const PLAYER_RADIUS = 0.35;
const WORLD_BOUND = 48;

export interface Collider {
  position: THREE.Vector3;
  radius: number;
}

/**
 * First-person rig: `dolly` is the thing that moves through the world,
 * `camera` is parented to it. In VR the headset owns the camera's local
 * transform each frame (head pose), so movement always goes through the
 * dolly -- same pattern as web/src/xr/locomotion.ts.
 */
export function createPlayer(camera: THREE.PerspectiveCamera) {
  const dolly = new THREE.Group();
  camera.position.set(0, 1.65, 0);
  dolly.add(camera);

  const colliders: Collider[] = [];
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const push = new THREE.Vector3();

  function setColliders(next: Collider[]) {
    colliders.length = 0;
    colliders.push(...next);
  }

  function update(delta: number, input: InputState, moveEnabled: boolean) {
    if (!moveEnabled) return;

    forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
    forward.y = 0;
    forward.normalize();
    right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    right.y = 0;
    right.normalize();

    const step = MOVE_SPEED * delta;
    dolly.position.addScaledVector(forward, input.moveZ * step);
    dolly.position.addScaledVector(right, input.moveX * step);

    dolly.position.x = THREE.MathUtils.clamp(dolly.position.x, -WORLD_BOUND, WORLD_BOUND);
    dolly.position.z = THREE.MathUtils.clamp(dolly.position.z, -WORLD_BOUND, WORLD_BOUND);

    for (const collider of colliders) {
      push.copy(dolly.position).sub(collider.position);
      push.y = 0;
      const minDist = collider.radius + PLAYER_RADIUS;
      const dist = push.length();
      if (dist < minDist && dist > 0.0001) {
        push.normalize().multiplyScalar(minDist - dist);
        dolly.position.add(push);
      }
    }
  }

  return {
    dolly,
    camera,
    setColliders,
    update,
    get position() {
      return dolly.position;
    },
  };
}

export type Player = ReturnType<typeof createPlayer>;
