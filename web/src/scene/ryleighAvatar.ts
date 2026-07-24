import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * Ryleigh's avatar (Avaturn export, `web/public/models/ryleigh.glb`): a real
 * embodied form sharing Ansuz's environment, per the build plan's Phase 2 --
 * unlike Ansuz's presence, this is rendered as-is (realistic/human), not
 * reskinned.
 */
export interface RyleighAvatar {
  group: THREE.Group;
  update(deltaSeconds: number): void;
}

const MODEL_URL = '/models/ryleigh.glb';

/**
 * Layer Ryleigh's own mesh lives on. Kept off the XR camera's default layer
 * mask so she doesn't see a third-person copy of herself floating in her own
 * headset view; the desktop preview camera enables it for dev visibility.
 * Must not be 1 or 2 -- three.js's WebXRManager unconditionally ORs those
 * into the XR camera's mask every frame (reserved for controller/hand
 * models), so disabling them on `camera` has no effect once presenting.
 */
export const RYLEIGH_AVATAR_LAYER = 3;

export async function createRyleighAvatar(scene: THREE.Scene): Promise<RyleighAvatar> {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(MODEL_URL);

  gltf.scene.traverse((object) => object.layers.set(RYLEIGH_AVATAR_LAYER));

  const group = new THREE.Group();
  group.add(gltf.scene);
  scene.add(group);

  const mixer = new THREE.AnimationMixer(gltf.scene);
  if (gltf.animations.length > 0) {
    mixer.clipAction(gltf.animations[0]).play();
  }

  return {
    group,
    update(deltaSeconds: number) {
      mixer.update(deltaSeconds);
    },
  };
}
