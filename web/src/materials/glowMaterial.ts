import * as THREE from 'three';

/**
 * Translucent body + fresnel rim glow -- "a being of light given physical
 * form" per the avatar design spec, not hard-surface robotic. Rim color and
 * intensity are driven by retrieval coherence (see setCoherence), same
 * cold/scattered-blue vs warm/coherent-gold language as environment.ts and
 * presence.ts, so Ansuz's body reads as part of the same memory-state signal
 * rather than a disconnected visual.
 */
export const SCATTERED_COLOR = new THREE.Color('#3a4a6b');
export const COHERENT_COLOR = new THREE.Color('#e8c98a');
const BASE_COLOR = new THREE.Color('#0d1420');

// Uses three.js's built-in skinning chunks so this material works on Ansuz's
// rigged/animated meshes, not just static geometry -- ShaderMaterial (unlike
// RawShaderMaterial) still runs shader source through the same #include
// resolution as built-in materials, and skinning is auto-enabled per-object
// from `object.isSkinnedMesh` (no material-level flag in this three.js
// version), so this is a no-op on any non-skinned mesh sharing the material.
const vertexShader = /* glsl */ `
  #include <common>
  #include <skinning_pars_vertex>

  varying vec3 vNormal;
  varying vec3 vViewPosition;

  void main() {
    #include <beginnormal_vertex>
    #include <skinbase_vertex>
    #include <skinnormal_vertex>

    #include <begin_vertex>
    #include <skinning_vertex>

    vNormal = normalize(normalMatrix * objectNormal);
    vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
    vViewPosition = -mvPosition.xyz;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 baseColor;
  uniform vec3 rimColor;
  uniform float glowIntensity;
  uniform float baseOpacity;
  uniform float fresnelPower;

  varying vec3 vNormal;
  varying vec3 vViewPosition;

  void main() {
    vec3 viewDir = normalize(vViewPosition);
    float fresnel = pow(1.0 - max(dot(normalize(vNormal), viewDir), 0.0), fresnelPower);
    vec3 color = baseColor + rimColor * fresnel * glowIntensity;
    float alpha = clamp(baseOpacity + fresnel * glowIntensity, 0.0, 1.0);
    gl_FragColor = vec4(color, alpha);
  }
`;

export interface GlowMaterial {
  material: THREE.ShaderMaterial;
  setCoherence(coherence: number): void;
}

export function createGlowMaterial(): GlowMaterial {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      baseColor: { value: BASE_COLOR.clone() },
      rimColor: { value: SCATTERED_COLOR.clone() },
      glowIntensity: { value: 1.2 },
      baseOpacity: { value: 0.35 },
      fresnelPower: { value: 2.2 },
    },
    vertexShader,
    fragmentShader,
    transparent: true,
    side: THREE.DoubleSide,
  });

  return {
    material,
    setCoherence(coherence: number) {
      const clamped = THREE.MathUtils.clamp(coherence, 0, 1);
      (material.uniforms.rimColor.value as THREE.Color).copy(
        SCATTERED_COLOR.clone().lerp(COHERENT_COLOR, clamped)
      );
      material.uniforms.glowIntensity.value = THREE.MathUtils.lerp(0.7, 1.8, clamped);
    },
  };
}
