import * as THREE from 'three';

/**
 * Left-thumbstick smooth locomotion, standard `xr-standard` gamepad mapping
 * (axes[2]/axes[3] = thumbstick x/y; 0/1 are trackpad on controllers that
 * have one). Moves `dolly` -- the group `camera` is parented to -- rather
 * than the camera itself, since the XR system fully owns the camera's local
 * transform each frame (head pose relative to `dolly`); moving the parent is
 * the only way to translate the player through the world.
 */
const MOVE_SPEED = 1.6; // m/s, roughly a comfortable walking pace
const DEADZONE = 0.15;

export function createLocomotion(
  xr: THREE.WebXRManager,
  dolly: THREE.Object3D,
  camera: THREE.Camera
) {
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();

  function update(deltaSeconds: number) {
    const session = xr.getSession();
    if (!session) return;

    for (const source of session.inputSources) {
      if (source.handedness !== 'left' || !source.gamepad) continue;

      const [, , x = 0, y = 0] = source.gamepad.axes;
      if (Math.abs(x) < DEADZONE && Math.abs(y) < DEADZONE) continue;

      forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
      forward.y = 0;
      forward.normalize();

      right.set(1, 0, 0).applyQuaternion(camera.quaternion);
      right.y = 0;
      right.normalize();

      const step = MOVE_SPEED * deltaSeconds;
      dolly.position.addScaledVector(forward, -y * step);
      dolly.position.addScaledVector(right, x * step);
    }
  }

  return { update };
}
