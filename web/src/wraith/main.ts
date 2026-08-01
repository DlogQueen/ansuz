import * as THREE from 'three';
import { enableXR } from '../xr/xrSession.js';
import { createGameState } from './core/state.js';
import { createDesktopControls, readXRInput, type InputState } from './core/input.js';
import { createPlayer } from './core/player.js';
import { createFirstPersonArms } from './arms/firstPersonArms.js';
import { createMission1Scene, type Mission1Scene } from './scenes/mission1.js';
import { createMission2Scene, type Mission2Scene } from './scenes/mission2.js';
import { createTeleportEffect, type TeleportEffect } from './scenes/teleportEffect.js';
import { createSophiaAvatar, type SophiaAvatar } from './avatars/sophiaAvatar.js';
import { mountBootOverlay } from './ui/booting.js';
import { mountHud, type Hud } from './ui/hud.js';
import { mountDebriefOverlay } from './ui/debrief.js';
import { mountTeleportingOverlay } from './ui/teleporting.js';
import { runAwakeningSequence } from './ui/awakening.js';
import { mountMissionCompleteOverlay } from './ui/missionComplete.js';
import { createWraithAudio } from './audio/audio.js';

const uiRoot = document.getElementById('ui-root');
if (!uiRoot) throw new Error('#ui-root missing from wraith.html');

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 800);
const player = createPlayer(camera);
scene.add(player.dolly);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
document.body.appendChild(renderer.domElement);

enableXR(renderer);

const desktopControls = createDesktopControls(renderer.domElement, camera);
const arms = createFirstPersonArms(camera);
const audio = createWraithAudio();
window.addEventListener('pointerdown', () => audio.resume(), { once: true });
window.addEventListener('keydown', () => audio.resume(), { once: true });

const gameState = createGameState();

let mission1: Mission1Scene | null = null;
let mission2: Mission2Scene | null = null;
let teleportEffect: TeleportEffect | null = null;
let teleportAvatar: SophiaAvatar | null = null;
let hud: Hud | null = null;
let cleanupPhase: (() => void) | null = null;
let sophiaAvatarPromise: Promise<SophiaAvatar> | null = null;
let m1Completed = false;
let m2Completed = false;

function loadSophiaAvatar(): Promise<SophiaAvatar> {
  if (!sophiaAvatarPromise) sophiaAvatarPromise = createSophiaAvatar();
  return sophiaAvatarPromise;
}

function clearUI() {
  uiRoot!.innerHTML = '';
}

function enterBooting() {
  clearUI();
  const overlay = mountBootOverlay(uiRoot!, () => gameState.set('m1'));
  cleanupPhase = () => overlay.dispose();
}

function enterM1() {
  clearUI();
  audio.setAmbient('alien');
  m1Completed = false;

  const m1 = createMission1Scene(scene);
  mission1 = m1;
  player.dolly.position.copy(m1.spawnPosition);
  player.setColliders(m1.colliders);
  gameState.stats.m1TimeElapsed = 0;
  gameState.stats.m1AlertsTriggered = 0;
  gameState.stats.m1ScanProgress = 0;

  hud = mountHud(uiRoot!);
  hud.setCorners('MISSION 1 // YXIS FIELD', 'BEACON: YXIS-9');

  cleanupPhase = () => {
    hud?.dispose();
    hud = null;
    m1.dispose();
    mission1 = null;
  };
}

function enterDebrief() {
  clearUI();
  audio.setAmbient('none');
  const overlay = mountDebriefOverlay(uiRoot!, gameState.stats, () => gameState.set('teleporting'));
  cleanupPhase = () => overlay.dispose();
}

function enterTeleporting() {
  clearUI();
  const overlay = mountTeleportingOverlay(uiRoot!);
  const center = player.dolly.position.clone();
  center.y += 1.2;
  const effect = createTeleportEffect(scene, center);
  teleportEffect = effect;

  let attachedAvatar: SophiaAvatar | null = null;
  loadSophiaAvatar().then((avatar) => {
    if (gameState.phase !== 'teleporting') return;
    avatar.setOpacity(0);
    avatar.group.scale.setScalar(0.01);
    avatar.group.position.set(0, -1.2, 0);
    effect.group.add(avatar.group);
    attachedAvatar = avatar;
    teleportAvatar = avatar;
  });

  cleanupPhase = () => {
    overlay.dispose();
    effect.dispose();
    teleportEffect = null;
    if (attachedAvatar) {
      attachedAvatar.dispose();
      teleportAvatar = null;
      sophiaAvatarPromise = null;
    }
  };
}

function enterAwakening() {
  clearUI();
  const controller = runAwakeningSequence(uiRoot!, renderer.domElement, {
    playMedPack: (onComplete) => arms.playMedPack(onComplete),
    startTinnitus: () => audio.startTinnitus(),
    stopTinnitus: () => audio.stopTinnitus(),
    onComplete: () => gameState.set('m2'),
  });
  cleanupPhase = () => controller.dispose();
}

function enterM2() {
  clearUI();
  audio.setAmbient('station');
  m2Completed = false;

  const m2 = createMission2Scene(scene);
  mission2 = m2;
  player.dolly.position.copy(m2.spawnPosition);
  player.setColliders(m2.colliders);
  gameState.stats.m2TimeElapsed = 0;
  gameState.stats.m2HazardHits = 0;
  gameState.stats.m2ArrayProgress = 0;

  hud = mountHud(uiRoot!);
  hud.setCorners('MISSION 2 // G.B.R.', 'QUANTUM TRANSPORTER ARRAY');

  cleanupPhase = () => {
    hud?.dispose();
    hud = null;
    m2.dispose();
    mission2 = null;
  };
}

function enterM2Complete() {
  clearUI();
  audio.setAmbient('none');
  const overlay = mountMissionCompleteOverlay(uiRoot!, gameState.stats);
  cleanupPhase = () => overlay.dispose();
}

gameState.onChange((phase) => {
  cleanupPhase?.();
  cleanupPhase = null;
  switch (phase) {
    case 'booting':
      enterBooting();
      break;
    case 'm1':
      enterM1();
      break;
    case 'debrief':
      enterDebrief();
      break;
    case 'teleporting':
      enterTeleporting();
      break;
    case 'awakening':
      enterAwakening();
      break;
    case 'm2':
      enterM2();
      break;
    case 'm2Complete':
      enterM2Complete();
      break;
  }
});
enterBooting();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const timer = new THREE.Timer();
renderer.setAnimationLoop((timestamp) => {
  timer.update(timestamp);
  const delta = Math.min(timer.getDelta(), 0.1);

  const xrInput = readXRInput(renderer.xr);
  const input: InputState = xrInput ?? desktopControls.update();

  const phase = gameState.phase;
  const moveEnabled = phase === 'm1' || phase === 'm2';
  player.update(delta, input, moveEnabled);

  const speed = moveEnabled ? Math.min(1, Math.hypot(input.moveX, input.moveZ)) : 0;
  arms.update(delta, speed);

  if (phase === 'm1' && mission1) {
    gameState.stats.m1TimeElapsed += delta;
    const result = mission1.update(delta, player.position, input.interactHeld);
    gameState.stats.m1ScanProgress = result.scanProgress;
    hud?.setProgress(result.scanComplete ? null : result.nearBeacon ? result.scanProgress : null);
    hud?.setPrompt(
      result.scanComplete
        ? 'BEACON SCANNED'
        : result.nearBeacon
          ? 'HOLD [F] / TRIGGER TO SCAN'
          : null
    );
    if (result.alertActive) {
      hud?.flashAlert();
      gameState.stats.m1AlertsTriggered += 1;
    }
    if (result.scanComplete && !m1Completed) {
      m1Completed = true;
      audio.playChime();
      window.setTimeout(() => gameState.set('debrief'), 1200);
    }
  }

  if (phase === 'teleporting' && teleportEffect) {
    const result = teleportEffect.update(delta);
    if (teleportAvatar) {
      const fadeStart = 0.55;
      const t = THREE.MathUtils.clamp((result.progress - fadeStart) / (1 - fadeStart), 0, 1);
      teleportAvatar.setOpacity(t);
      teleportAvatar.group.scale.setScalar(THREE.MathUtils.lerp(0.01, 1, t));
      teleportAvatar.update(delta);
    }
    if (result.complete) gameState.set('awakening');
  }

  if (phase === 'm2' && mission2) {
    gameState.stats.m2TimeElapsed += delta;
    const result = mission2.update(delta, player.position, input.interactHeld);
    gameState.stats.m2ArrayProgress = result.arrayProgress;
    hud?.setProgress(result.arrayComplete ? null : result.nearArray ? result.arrayProgress : null);
    hud?.setPrompt(
      result.arrayComplete
        ? 'ARRAY ONLINE'
        : result.nearArray
          ? 'HOLD [F] / TRIGGER TO ACTIVATE'
          : null
    );
    if (result.hazardHit) {
      hud?.flashAlert();
      audio.playHazard();
      gameState.stats.m2HazardHits += 1;
    }
    if (result.arrayComplete && !m2Completed) {
      m2Completed = true;
      audio.playChime();
      window.setTimeout(() => gameState.set('m2Complete'), 1200);
    }
  }

  renderer.render(scene, camera);
});
