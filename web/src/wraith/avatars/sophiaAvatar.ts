import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * Sophia-7's Skin: a rigged Ready Player Me-style avatar (CC-BY-4.0, see
 * web/public/models/CREDITS.md) with a bundled idle clip. Used wherever the
 * story shows her body directly -- the booting hologram and the
 * teleporting/awakening sequence where her consciousness takes physical
 * form -- rather than during m1/m2 gameplay itself, which stays first-person.
 */
export interface SophiaAvatar {
  group: THREE.Group;
  update(deltaSeconds: number): void;
  setOpacity(opacity: number): void;
  dispose(): void;
}

const MODEL_URL = '/models/sophia/scene.gltf';

export async function createSophiaAvatar(): Promise<SophiaAvatar> {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(MODEL_URL);

  const group = new THREE.Group();
  group.add(gltf.scene);

  const materials: THREE.Material[] = [];
  gltf.scene.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.frustumCulled = false;
      const mats = Array.isArray(object.material) ? object.material : [object.material];
      for (const mat of mats) {
        mat.transparent = true;
        materials.push(mat);
      }
    }
  });

  const mixer = new THREE.AnimationMixer(gltf.scene);
  if (gltf.animations.length > 0) {
    mixer.clipAction(gltf.animations[0]).play();
  }

  function setOpacity(opacity: number) {
    for (const mat of materials) {
      (mat as THREE.MeshStandardMaterial).opacity = opacity;
    }
  }

  function dispose() {
    gltf.scene.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
      }
    });
    for (const mat of materials) mat.dispose();
  }

  return {
    group,
    update(deltaSeconds: number) {
      mixer.update(deltaSeconds);
    },
    setOpacity,
    dispose,
  };
}
