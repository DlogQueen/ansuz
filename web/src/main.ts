import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createEnvironment } from './scene/environment.js';
import { createPresence } from './scene/presence.js';
import { enableXR } from './xr/xrSession.js';

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.05,
  500
);
camera.position.set(0, 1.6, 2);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

enableXR(renderer);

// Desktop/mouse fallback for testing without a headset.
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.6, -3);
controls.enableDamping = true;

const environment = createEnvironment(scene);
const presence = createPresence(scene);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Demo drivers -----------------------------------------------------
// Placeholder until Phase 3/4 feed real short-term memory load and
// retrieval-coherence values in over the WebSocket. Slow oscillation just
// proves the environment/presence actually respond to state changes.
let demoT = 0;

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const delta = clock.getDelta();
  demoT += delta;

  const memoryLoad = (Math.sin(demoT * 0.1) + 1) / 2;
  const coherence = (Math.sin(demoT * 0.07 + 1.5) + 1) / 2;
  environment.setMemoryLoad(memoryLoad);
  environment.setRetrievalCoherence(coherence);
  presence.setCoherence(coherence);
  presence.update(delta);

  controls.update();
  renderer.render(scene, camera);
});
