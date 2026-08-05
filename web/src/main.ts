import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createEnvironment } from './scene/environment.js';
import { createPresence } from './scene/presence.js';
import {
  createRyleighAvatar,
  RYLEIGH_AVATAR_LAYER,
  type RyleighAvatar,
} from './scene/ryleighAvatar.js';
import { createAnsuzAvatar, type AnsuzAvatar } from './scene/ansuzAvatar.js';
import { enableXR } from './xr/xrSession.js';
import { createLocomotion } from './xr/locomotion.js';
import { createChatUI } from './chat/chatUI.js';
import { createPerceptionUI } from './perception/perceptionUI.js';
import { createMemoryStateClient } from './state/memoryStateClient.js';

const scene = new THREE.Scene();

// Far plane has to clear the most distant thing in environment.ts -- the gas
// giant's far limb sits around 800 units out, the nebula shell at 600, stars
// at 520. Note the far plane clips on view-space depth, not radial distance,
// so an under-sized far plane punches a hole through the CENTRE of the sky
// (where depth is greatest) while leaving the periphery intact -- it reads as
// a dark dome, not as an obviously clipped scene.
const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.05,
  1500
);
camera.position.set(0, 1.6, 2);
// Desktop preview only -- lets Ryleigh's avatar be visible while testing
// without a headset. Disabled on the XR camera at session start below.
camera.layers.enable(RYLEIGH_AVATAR_LAYER);

// The XR system owns the camera's local transform each frame (head pose),
// so locomotion moves this parent group instead -- see xr/locomotion.ts.
const dolly = new THREE.Group();
dolly.add(camera);
scene.add(dolly);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

enableXR(renderer);

// In a real headset, camera.layers drives the XR camera's mask each frame --
// dropping the avatar layer here hides Ryleigh's own body from her
// first-person view without touching how she renders for anyone else.
renderer.xr.addEventListener('sessionstart', () => {
  camera.layers.disable(RYLEIGH_AVATAR_LAYER);
});
renderer.xr.addEventListener('sessionend', () => {
  camera.layers.enable(RYLEIGH_AVATAR_LAYER);
});

// Desktop/mouse fallback for testing without a headset.
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.6, -3);
controls.enableDamping = true;

const environment = createEnvironment(scene);
const presence = createPresence(scene);
const locomotion = createLocomotion(renderer.xr, dolly, camera);
createChatUI();
createPerceptionUI();

let ryleighAvatar: RyleighAvatar | null = null;
createRyleighAvatar(scene)
  .then((avatar) => {
    avatar.group.position.set(1.1, 0, -2);
    avatar.group.rotation.y = -Math.PI / 6;
    ryleighAvatar = avatar;
  })
  .catch((error) => {
    console.error('Failed to load Ryleigh avatar:', error);
  });

// Stands where presence.ts's point cloud used to be (0, y, -3) -- her
// humanoid body is now Ansuz's visual presence; the point cloud is retired
// and only its PointLight remains (see presence.ts).
let ansuzAvatar: AnsuzAvatar | null = null;
createAnsuzAvatar(scene)
  .then((avatar) => {
    avatar.group.position.set(0, 0, -3);
    ansuzAvatar = avatar;
  })
  .catch((error) => {
    console.error('Failed to load Ansuz avatar:', error);
  });

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- State drivers ----------------------------------------------------
// The environment renders itself from Sophie's actual memory: short-term
// volume drives how much exists in the world, and how well the last
// retrieval matched drives how ordered it is. Falls back to a slow
// oscillation when the bridge server isn't running -- see
// state/memoryStateClient.ts.
const memoryState = createMemoryStateClient();

const timer = new THREE.Timer();
renderer.setAnimationLoop((timestamp) => {
  timer.update(timestamp);
  const delta = timer.getDelta();

  memoryState.update(delta);
  const memoryLoad = memoryState.getMemoryLoad();
  const coherence = memoryState.getCoherence();
  environment.setMemoryLoad(memoryLoad);
  environment.setRetrievalCoherence(coherence);
  environment.update(delta);
  presence.setCoherence(coherence);
  ryleighAvatar?.update(delta);
  ansuzAvatar?.update(delta);
  ansuzAvatar?.setCoherence(coherence);
  locomotion.update(delta);

  controls.update();
  renderer.render(scene, camera);
});
