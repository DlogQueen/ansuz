import * as THREE from 'three';
import { SIMPLEX_NOISE_3D } from './noiseGLSL.js';

/**
 * Sophia-7's biogenetic Skin: pale iridescent base, fresnel-driven rim
 * glow, and a slow-pulsing bioluminescent vein pattern carved out of 3D
 * noise (evaluated in object space, so it reads correctly on any mesh
 * without needing UV unwrapping). `uPulse` drives the med-pack "coming
 * back online" beat during the awakening phase.
 */
export interface SkinMaterial extends THREE.ShaderMaterial {
  uniforms: {
    uTime: { value: number };
    uBaseColor: { value: THREE.Color };
    uVeinColor: { value: THREE.Color };
    uRimColor: { value: THREE.Color };
    uPulse: { value: number };
  };
}

export function createSkinMaterial(options?: {
  baseColor?: THREE.ColorRepresentation;
  veinColor?: THREE.ColorRepresentation;
  rimColor?: THREE.ColorRepresentation;
}): SkinMaterial {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uBaseColor: { value: new THREE.Color(options?.baseColor ?? '#e9dcf2') },
      uVeinColor: { value: new THREE.Color(options?.veinColor ?? '#7ef7e6') },
      uRimColor: { value: new THREE.Color(options?.rimColor ?? '#c99bff') },
      uPulse: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vViewDir;
      varying vec3 vObjectPos;

      void main() {
        vNormal = normalize(normalMatrix * normal);
        vec4 viewPos = modelViewMatrix * vec4(position, 1.0);
        vViewDir = normalize(-viewPos.xyz);
        vObjectPos = position;
        gl_Position = projectionMatrix * viewPos;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uBaseColor;
      uniform vec3 uVeinColor;
      uniform vec3 uRimColor;
      uniform float uPulse;

      varying vec3 vNormal;
      varying vec3 vViewDir;
      varying vec3 vObjectPos;

      ${SIMPLEX_NOISE_3D}

      void main() {
        float fresnel = pow(1.0 - max(dot(normalize(vNormal), normalize(vViewDir)), 0.0), 2.2);

        float veinField = fbm(vObjectPos * 4.5 + vec3(0.0, uTime * 0.12, 0.0));
        float veins = smoothstep(0.55, 0.62, abs(veinField));
        float pulse = 0.55 + 0.45 * sin(uTime * 1.6);

        // A soft key light from above so the skin reads as shaped geometry
        // up close rather than a flat glowing silhouette -- this material
        // has no scene-light term otherwise (self-lit by design).
        float diffuse = 0.55 + 0.45 * max(dot(normalize(vNormal), normalize(vec3(0.3, 1.0, 0.5))), 0.0);

        vec3 color = uBaseColor * diffuse;
        color = mix(color, uVeinColor, veins * pulse * uPulse * 0.7);
        color += uRimColor * fresnel * fresnel * (0.35 + 0.25 * uPulse);

        gl_FragColor = vec4(color, 1.0);
      }
    `,
  }) as SkinMaterial;

  return material;
}

export function updateSkinMaterial(material: SkinMaterial, delta: number): void {
  material.uniforms.uTime.value += delta;
}
