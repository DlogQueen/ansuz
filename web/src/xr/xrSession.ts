import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';

/**
 * Enables WebXR on the renderer and appends the enter-VR button. On a
 * device/browser without WebXR support, VRButton renders a disabled
 * "VR NOT SUPPORTED" affordance and the scene still renders normally in
 * the flat browser view -- no separate install or fallback path needed.
 *
 * Requests the dom-overlay feature so HTML elements (voice UI status text,
 * the hold-to-talk button) stay visible inside an immersive session --
 * without this, regular DOM content is invisible once presenting, with no
 * error or warning, which otherwise makes an immersive session
 * indistinguishable from "nothing is working."
 */
export function enableXR(renderer: THREE.WebGLRenderer): void {
  renderer.xr.enabled = true;
  document.body.appendChild(
    VRButton.createButton(renderer, {
      optionalFeatures: ['dom-overlay'],
      domOverlay: { root: document.body },
    })
  );
}
