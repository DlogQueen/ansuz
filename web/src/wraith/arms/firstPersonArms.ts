import * as THREE from 'three';
import { createSkinMaterial, updateSkinMaterial } from '../shaders/skinMaterial.js';
import { createGlowMaterial } from '../shaders/glowMaterial.js';

/**
 * Sophia-7's own arms, always visible in first person -- the biggest single
 * visual tell that this is her Skin rather than a disembodied camera.
 * Attached directly to the camera so they track head look with zero lag.
 */
export interface FirstPersonArms {
  group: THREE.Group;
  update(delta: number, moveSpeed: number): void;
  playMedPack(onComplete?: () => void): void;
  dispose(): void;
}

export function createFirstPersonArms(camera: THREE.Camera): FirstPersonArms {
  const group = new THREE.Group();
  camera.add(group);

  const skin = createSkinMaterial({
    baseColor: '#f0dcee',
    veinColor: '#8af7ea',
    rimColor: '#d59bff',
  });

  function buildArm(side: -1 | 1): THREE.Group {
    const arm = new THREE.Group();

    const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.18, 4, 8), skin);
    upper.position.set(0, -0.03, 0);
    upper.rotation.z = side * 0.28;
    arm.add(upper);

    const forearm = new THREE.Mesh(new THREE.CapsuleGeometry(0.04, 0.16, 4, 8), skin);
    forearm.position.set(side * 0.04, -0.1, -0.05);
    forearm.rotation.set(0.4, 0, side * 0.1);
    arm.add(forearm);

    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), skin);
    hand.scale.set(0.7, 1, 1.15);
    hand.position.set(side * 0.06, -0.16, -0.11);
    arm.add(hand);

    // A 70deg vertical FOV only has ~35deg of headroom below center at this
    // distance -- (0.22 + 0.16) / 0.53 was past that, which is why the
    // whole arm silently rendered below the visible frustum. Keeping the
    // downward offset comfortably inside tan(35deg) * distance is what
    // actually keeps it on screen, not eyeballing "looks about right".
    arm.position.set(side * 0.15, -0.22, -0.42);
    return arm;
  }

  const leftArm = buildArm(-1);
  const rightArm = buildArm(1);
  const rightArmRest = rightArm.position.clone();
  group.add(leftArm, rightArm);

  const medPack = new THREE.Mesh(
    new THREE.CylinderGeometry(0.02, 0.02, 0.09, 10),
    createGlowMaterial('#7ef7e6', 1.8)
  );
  medPack.visible = false;
  medPack.position.set(0, -0.02, -0.05);
  rightArm.add(medPack);

  let t = 0;
  let medPackT = -1;
  let onMedPackComplete: (() => void) | undefined;
  const MED_PACK_DURATION = 2.6;

  function update(delta: number, moveSpeed: number) {
    t += delta;
    updateSkinMaterial(skin, delta);

    const bobAmount = THREE.MathUtils.clamp(moveSpeed, 0, 1);
    group.position.set(
      Math.sin(t * 0.6) * 0.004,
      Math.sin(t * 8) * 0.008 * bobAmount,
      0
    );

    if (medPackT >= 0) {
      medPackT += delta;
      const progress = Math.min(medPackT / MED_PACK_DURATION, 1);
      const rise = Math.sin(progress * Math.PI);
      rightArm.position.set(
        rightArmRest.x,
        rightArmRest.y + rise * 0.22,
        rightArmRest.z - rise * 0.05
      );
      rightArm.rotation.x = -rise * 0.9;
      medPack.visible = progress > 0.15 && progress < 0.85;

      if (progress >= 1) {
        medPackT = -1;
        rightArm.position.copy(rightArmRest);
        rightArm.rotation.set(0, 0, 0);
        medPack.visible = false;
        const callback = onMedPackComplete;
        onMedPackComplete = undefined;
        callback?.();
      }
    }
  }

  function playMedPack(onComplete?: () => void) {
    medPackT = 0;
    onMedPackComplete = onComplete;
  }

  function dispose() {
    camera.remove(group);
    skin.dispose();
    medPack.geometry.dispose();
    (medPack.material as THREE.Material).dispose();
  }

  return { group, update, playMedPack, dispose };
}
