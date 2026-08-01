import * as THREE from 'three';
import { SIMPLEX_NOISE_3D } from './noiseGLSL.js';

/**
 * Solar Magnetic Rip Current bands: additive, double-sided plasma sheets.
 * Domain-warped fbm gives the turbulent "hurricane" look; alpha is carved
 * from the same field so the band reads as wispy plasma rather than a flat
 * colored plane. `uDanger` (0..1) pushes the palette from ambient
 * violet/cyan toward hazard magenta as the player gets close.
 */
export interface PlasmaMaterial extends THREE.ShaderMaterial {
  uniforms: {
    uTime: { value: number };
    uColorA: { value: THREE.Color };
    uColorB: { value: THREE.Color };
    uDanger: { value: number };
    uOpacity: { value: number };
  };
}

export function createPlasmaMaterial(options?: {
  colorA?: THREE.ColorRepresentation;
  colorB?: THREE.ColorRepresentation;
}): PlasmaMaterial {
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uColorA: { value: new THREE.Color(options?.colorA ?? '#7a2bff') },
      uColorB: { value: new THREE.Color(options?.colorB ?? '#28f5ff') },
      uDanger: { value: 0 },
      uOpacity: { value: 0.85 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vObjectPos;

      void main() {
        vUv = uv;
        vObjectPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uColorA;
      uniform vec3 uColorB;
      uniform float uDanger;
      uniform float uOpacity;

      varying vec2 vUv;
      varying vec3 vObjectPos;

      ${SIMPLEX_NOISE_3D}

      void main() {
        vec3 flow = vObjectPos * 0.35;
        flow.x += uTime * 0.5;

        vec2 warp = vec2(fbm(flow), fbm(flow + 19.1));
        float turbulence = fbm(vec3(vObjectPos.xy * 0.6 + warp * 1.4, uTime * 0.3));

        float band = smoothstep(-0.1, 0.9, turbulence);
        float edgeFade = smoothstep(0.0, 0.12, vUv.y) * smoothstep(1.0, 0.88, vUv.y);

        vec3 color = mix(uColorA, uColorB, clamp(turbulence * 0.5 + 0.5, 0.0, 1.0));
        color = mix(color, vec3(1.0, 0.15, 0.55), uDanger * 0.6);

        float alpha = band * edgeFade * uOpacity;
        gl_FragColor = vec4(color * (1.2 + uDanger), alpha);
      }
    `,
  }) as PlasmaMaterial;

  return material;
}

export function updatePlasmaMaterial(material: PlasmaMaterial, delta: number): void {
  material.uniforms.uTime.value += delta;
}
