import * as THREE from 'three';

/**
 * G.B.R. station deck plating: dark brushed metal with an emissive
 * conduit grid etched in world-space (not UV-space, so it stays crisp
 * across the whole platform without a texture atlas).
 */
export function createStationFloorMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uGridColor: { value: new THREE.Color('#28f5ff') },
      uBaseColor: { value: new THREE.Color('#0a0e18') },
    },
    vertexShader: /* glsl */ `
      varying vec2 vWorldXZ;
      void main() {
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldXZ = worldPos.xz;
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uGridColor;
      uniform vec3 uBaseColor;
      varying vec2 vWorldXZ;

      float gridLine(vec2 p, float spacing, float thickness) {
        vec2 g = abs(fract(p / spacing - 0.5) - 0.5) * spacing;
        return 1.0 - smoothstep(0.0, thickness, min(g.x, g.y));
      }

      void main() {
        float major = gridLine(vWorldXZ, 4.0, 0.04);
        float minor = gridLine(vWorldXZ, 1.0, 0.015) * 0.35;
        float pulse = 0.6 + 0.4 * sin(uTime * 0.6 + vWorldXZ.x * 0.05 + vWorldXZ.y * 0.05);

        vec3 color = uBaseColor + uGridColor * (major + minor) * pulse;
        gl_FragColor = vec4(color, 1.0);
      }
    `,
  });
}

export function updateStationFloorMaterial(material: THREE.ShaderMaterial, delta: number): void {
  material.uniforms.uTime.value += delta;
}
