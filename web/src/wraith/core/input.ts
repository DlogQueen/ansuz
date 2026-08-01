import * as THREE from 'three';

export interface InputState {
  moveX: number;
  moveZ: number;
  interactHeld: boolean;
}

const LOOK_SENSITIVITY = 0.0022;
const PITCH_LIMIT = Math.PI / 2 - 0.05;

/**
 * Pointer-lock mouse look + WASD + hold-F, for the desktop fallback path.
 * VR sessions bypass this entirely -- the XR camera owns rotation and
 * `readXRInput` below supplies movement/interact instead.
 */
export function createDesktopControls(domElement: HTMLElement, camera: THREE.Camera) {
  const keys = new Set<string>();
  let yaw = 0;
  let pitch = 0;
  let locked = false;

  function onKeyDown(event: KeyboardEvent) {
    keys.add(event.code);
  }
  function onKeyUp(event: KeyboardEvent) {
    keys.delete(event.code);
  }
  function onMouseMove(event: MouseEvent) {
    if (!locked) return;
    yaw -= event.movementX * LOOK_SENSITIVITY;
    pitch -= event.movementY * LOOK_SENSITIVITY;
    pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
  }
  function onClick() {
    if (document.pointerLockElement !== domElement) domElement.requestPointerLock();
  }
  function onLockChange() {
    locked = document.pointerLockElement === domElement;
  }

  domElement.addEventListener('click', onClick);
  document.addEventListener('pointerlockchange', onLockChange);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('mousemove', onMouseMove);

  function update(): InputState {
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
    const moveZ = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
    const moveX = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    const interactHeld = keys.has('KeyF');
    return { moveX, moveZ, interactHeld };
  }

  function dispose() {
    domElement.removeEventListener('click', onClick);
    document.removeEventListener('pointerlockchange', onLockChange);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('mousemove', onMouseMove);
  }

  return {
    update,
    dispose,
    get locked() {
      return locked;
    },
  };
}

const AXIS_DEADZONE = 0.15;

/**
 * Left thumbstick = locomotion, right trigger (button 0) = interact/hold.
 * Standard xr-standard gamepad mapping, same as web/src/xr/locomotion.ts.
 */
export function readXRInput(xr: THREE.WebXRManager): InputState | null {
  const session = xr.getSession();
  if (!session) return null;

  let moveX = 0;
  let moveZ = 0;
  let interactHeld = false;

  for (const source of session.inputSources) {
    if (!source.gamepad) continue;
    if (source.handedness === 'left') {
      const [, , x = 0, y = 0] = source.gamepad.axes;
      if (Math.abs(x) > AXIS_DEADZONE) moveX = x;
      if (Math.abs(y) > AXIS_DEADZONE) moveZ = -y;
    }
    if (source.handedness === 'right') {
      if (source.gamepad.buttons[0]?.pressed) interactHeld = true;
    }
  }

  return { moveX, moveZ, interactHeld };
}
