import * as THREE from 'three';

/**
 * Ambient coherence light. Originally a visible point cloud standing in for
 * Sophie herself -- superseded by her humanoid body (ansuzAvatar.ts) per the
 * build plan's Phase 2, which calls for a real embodied form rather than an
 * abstract locus. What's left here is the PointLight that cloud carried:
 * still a real, load-bearing light source for the scene (Ryleigh's avatar's
 * PBR material relies on it, alongside environment.ts's hemisphere light --
 * NOT Sophie's avatar, whose ShaderMaterial is fully custom/unlit and ignores
 * scene lights entirely; her brightness comes only from the glowIntensity
 * uniform in glowMaterial.ts).
 *
 * Raised above head height rather than left at the old point-cloud's
 * position (0, 1.6, -3) -- that height sat inside Sophie's chest once her
 * avatar occupied the same spot, visible as a bright point glaring through
 * her (unlit, so unaffected by it) translucent body.
 */
export interface Presence {
  group: THREE.Group;
  /** 0 = scattered/loose/cool, 1 = coherent/tight/warm. */
  setCoherence(coherence: number): void;
}

const COLD_COLOR = new THREE.Color('#6d86ff');
const WARM_COLOR = new THREE.Color('#ffdf9a');

export function createPresence(scene: THREE.Scene): Presence {
  const group = new THREE.Group();
  group.position.set(0, 4, -3);

  const light = new THREE.PointLight(COLD_COLOR.clone(), 4, 8);
  group.add(light);

  scene.add(group);

  return {
    group,
    setCoherence(value: number) {
      const coherence = THREE.MathUtils.clamp(value, 0, 1);
      const color = COLD_COLOR.clone().lerp(WARM_COLOR, coherence);
      light.color.copy(color);
      light.intensity = THREE.MathUtils.lerp(2, 5, coherence);
    },
  };
}
