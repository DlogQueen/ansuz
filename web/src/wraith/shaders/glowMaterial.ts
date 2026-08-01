import * as THREE from 'three';

/**
 * Simple fresnel rim-glow, additive, for beacons/creatures/teleport rings --
 * anything that should read as "lit from within" without the vein/noise
 * detail of skinMaterial.ts (that one's reserved for Sophia's own Skin).
 */
export interface GlowMaterial extends THREE.ShaderMaterial {
  uniforms: {
    uColor: { value: THREE.Color };
    uIntensity: { value: number };
  };
}

export function createGlowMaterial(color: THREE.ColorRepresentation, intensity = 1.4): GlowMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uIntensity: { value: intensity },
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vViewDir;

      void main() {
        vNormal = normalize(normalMatrix * normal);
        vec4 viewPos = modelViewMatrix * vec4(position, 1.0);
        vViewDir = normalize(-viewPos.xyz);
        gl_Position = projectionMatrix * viewPos;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uIntensity;

      varying vec3 vNormal;
      varying vec3 vViewDir;

      void main() {
        float fresnel = pow(1.0 - max(dot(normalize(vNormal), normalize(vViewDir)), 0.0), 1.8);
        float core = 0.25;
        gl_FragColor = vec4(uColor * (core + fresnel * uIntensity), core + fresnel);
      }
    `,
  }) as GlowMaterial;
}
