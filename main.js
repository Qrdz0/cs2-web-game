// cs2-web-game — Phase 1: Mirage Map, Team Select, AI Fix
// Three.js (rendering) + Rapier (collisions) via CDN importmap.
//
// Physics model (unchanged):
//   - floor / walls / crates / ramps : FIXED rigid bodies (one per mesh)
//   - player                         : DYNAMIC capsule, rotations locked, CCD
//   - gravity                        : Rapier applies it (sv_gravity 800)
//   - ground detection               : downward ray from the capsule
//   - movement                       : Source friction/accelerate on ground,
//                                      exact Quake/Source air-accelerate in air
//
// Phase 1 (this file):
//   - team select screen: Join T / Join CT before pointer lock
//   - de_mirage-style blockout: T Spawn, Mid + Xbox, A Site (ramp,
//     Palace, Tetris), B Site (van + apartments), CT Spawn
//   - enemy shots now start a few units IN FRONT of the enemy body and
//     are tested against the player capsule -> no more grazing misses
//   - visible fast red tracer bolts for enemy fire
//   - desert atmosphere: sky-blue background, fog, shadowed sun
//
// Run:  npx serve -l 8000 .   ->  http://localhost:8000

import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import RAPIER from '@dimforge/rapier3d-compat';

const errEl = document.getElementById('err');
function fatal(msg) {
  errEl.style.display = 'block';
  errEl.textContent = 'ERROR: ' + msg;
  console.error(msg);
}

// ================================================================
// Source-engine movement constants (units = CS units, ups = u/s)
// ================================================================
const MOVEMENT = {
  maxSpeed: 250,      // sv_maxspeed (run)
  accelerate: 5.5,    // sv_accelerate
  friction: 5.2,      // sv_friction
  stopSpeed: 100,     // sv_stopspeed
  airAccelerate: 12,  // sv_airaccelerate
  airCap: 30,         // wishspeed in air (sv_air_max_wishspeed = 30)
  gravity: 800,       // sv_gravity (Rapier world gravity)
  jumpVelocity: 301,  // jump boost (CS jump ~301 ups)
};

const PLAYER = {
  radius: 16,
  halfHeight: 20,     // capsule cylinder half -> total height 72
  eyeHeight: 64,      // eye above feet (CS eye height)
  maxHP: 100,
};

// ================================================================
// WEAPON SYSTEM
// ================================================================
const WEAPONS = [
  { name: 'Glock',  slot: 'PISTOL', price: 0,    damage: 26, fireRate: 170, magSize: 20, killReward: 300,  scale: 0.80 },
  { name: 'MP5',    slot: 'SMG',    price: 1200, damage: 28, fireRate: 90,  magSize: 30, killReward: 600,  scale: 1.00 },
  { name: 'Deagle', slot: 'PISTOL', price: 3000, damage: 60, fireRate: 500, magSize: 7,  killReward: 1500, scale: 0.88 },
];
const ENEMY_HP = 100;

// enemy AI tuning
const ENEMY = {
  patrolSpeed: 60,
  chaseSpeed: 120,
  strafeSpeed: 70,
  chaseRange: 500,
  shootRange: 420,
  chaseYRange: 100,   // platform <-> ground players can still fight
  damage: 12,
  tracerSpeed: 1600,
};

// ================================================================
// TEAMS + ROUND STATE
// ================================================================
let playerTeam = null;    // 'T' | 'CT'  (set from the team select screen)

let playerMoney = 800;
let playerHP = PLAYER.maxHP;

const ROUND = {
  state: 'menu',          // 'menu' | 'warmup' | 'active' | 'roundover'
  number: 0,
  perRound: 5,
  stateAt: 0,             // timestamp of last state change
  nextAt: 0,              // when roundover -> next round
};

// ================================================================
// Settings (localStorage)
// ================================================================
const SETTINGS_KEY = 'cs2web.settings';
let settings = { jumpBind: 'space' };   // 'space' | 'wheel'
try {
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (raw) settings = { ...settings, ...JSON.parse(raw) };
} catch (_) { /* corrupted storage -> defaults */ }

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
}

// ================================================================
// Web Audio — synthesized shot / hit / dry-click (no assets needed)
// ================================================================
let audioCtx = null;
function getAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx = new AC();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function playShotSound(vol = 0.5) {
  const ctx = getAudio();
  if (!ctx) return;
  const t = ctx.currentTime;
  const len = Math.floor(ctx.sampleRate * 0.18);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    const k = i / len;
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - k, 2.5);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filt = ctx.createBiquadFilter();
  filt.type = 'lowpass';
  filt.frequency.value = 1500;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
  src.connect(filt);
  filt.connect(gain);
  gain.connect(ctx.destination);
  src.start(t);
}

function playBlip(freq, dur, vol) {
  const ctx = getAudio();
  if (!ctx) return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'square';
  osc.frequency.value = freq;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur);
}

// ================================================================
// Boot
// ================================================================
async function boot() {
  await RAPIER.init();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87ceeb);        // bright desert sky
  scene.fog = new THREE.Fog(0xc7c0b0, 700, 2500);      // dusty haze

  const camera = new THREE.PerspectiveCamera(
    90, window.innerWidth / window.innerHeight, 0.1, 3000
  );
  camera.rotation.order = 'YXZ';
  scene.add(camera);   // required so camera children (gun viewmodel) render

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);

  // ---------------- lighting (desert sun + soft fill) ----------------
  scene.add(new THREE.AmbientLight(0xffffff, 0.45));
  const sun = new THREE.DirectionalLight(0xfff1d6, 2.2);
  sun.position.set(600, 900, 400);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const S = 800;
  sun.shadow.camera.left = -S; sun.shadow.camera.right = S;
  sun.shadow.camera.top = S; sun.shadow.camera.bottom = -S;
  sun.shadow.camera.far = 3000;
  sun.shadow.bias = -0.0006;
  scene.add(sun);

  // ---------------- physics world ----------------
  const world = new RAPIER.World({ x: 0, y: -MOVEMENT.gravity, z: 0 });

  // everything a bullet can hit (floor, walls, crates, ramp, enemies)
  const shootables = [];

  // ---------------- materials (all map = MeshLambertMaterial) ---------
  const concreteTex = makeConcreteTexture();
  concreteTex.repeat.set(9, 10);
  const midTex = makeConcreteTexture();
  midTex.repeat.set(2, 2);
  const floorMat = new THREE.MeshLambertMaterial({ map: concreteTex });
  const midMat = new THREE.MeshLambertMaterial({ map: midTex, color: 0x9aa0a6 });
  const wallMat = new THREE.MeshLambertMaterial({ map: makeSandTexture() });
  const crateMat = new THREE.MeshLambertMaterial({ map: makeWoodTexture() });
  const paintMat = c => new THREE.MeshLambertMaterial({ color: c });

  // ---------------- map helpers (every BOX/RAMP gets a FIXED collider) -
  const BOX = (x, y, z, w, h, d, type = 'wall') => {
    const mat =
      type === 'crate'    ? crateMat :
      type === 'mid'      ? midMat :
      type === 'concrete' ? floorMat :
      wallMat;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    shootables.push(mesh);
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z));
    world.createCollider(RAPIER.ColliderDesc.cuboid(w / 2, h / 2, d / 2), body);
    return mesh;
  };

  // ramp rises along +X (rotate around Z by a positive angle)
  const RAMP = (x, y, z, w, h, d, rotZ, type = 'concrete') => {
    const mat = type === 'concrete' ? floorMat : wallMat;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    mesh.rotation.z = rotZ;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    shootables.push(mesh);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, rotZ));
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(x, y, z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
    );
    world.createCollider(RAPIER.ColliderDesc.cuboid(w / 2, h / 2, d / 2), body);
    return mesh;
  };

  // thin ground paint — VISUAL ONLY (no collider, never hit by bullets)
  const PAINT = (x, y, z, w, d, color) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, 1, d), paintMat(color));
    mesh.position.set(x, y, z);
    mesh.receiveShadow = true;
    scene.add(mesh);
    return mesh;
  };

  const MARK = (x, y, z, w, d, color) => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, 1, d),
      new THREE.MeshLambertMaterial({ color })
    );
    mesh.position.set(x, y, z);
    mesh.receiveShadow = true;
    scene.add(mesh);
    return mesh;
  };

  // ================================================================
  // MAP BLOCKOUT — de_mirage style
  //   x: -420..420 (west..east)   z: -460..460 (CT..T)
  //   T Spawn = south, CT Spawn = north, A = east, B = west, Mid = center
  // ================================================================
  BOX(0, -2, 0, 840, 4, 920, 'concrete');        // ground

  // ---- perimeter (height 140) ----
  BOX(0, 70, -452, 840, 140, 16, 'wall');       // north
  BOX(0, 70, 452, 840, 140, 16, 'wall');        // south
  BOX(-412, 70, 0, 16, 140, 920, 'wall');       // west
  BOX(412, 70, 0, 16, 140, 920, 'wall');        // east

  // ---- zone paint (visual only, staggered heights = no z-fighting) ----
  PAINT(0, 0.50, 380, 840, 160, 0xd9b87c);      // T Spawn — sand
  PAINT(0, 0.55, 210, 840, 180, 0xc7b48c);      // plaza — light sand
  PAINT(250, 0.60, -90, 340, 440, 0xd2c09a);    // A Site — tan
  PAINT(-250, 0.65, -90, 340, 440, 0xbfb9a6);   // B Site — dust grey
  PAINT(0, 0.70, -90, 160, 440, 0x9aa0a6);      // Mid — grey concrete
  PAINT(0, 0.75, -380, 840, 160, 0xa8adb3);     // CT Spawn — grey

  // ---- T Spawn (south, z 300..444) ----
  BOX(-265, 48, 300, 310, 96, 16, 'wall');      // front wall x -420..-110
  BOX(265, 48, 300, 310, 96, 16, 'wall');       // front wall x 110..420
  //   -> gap x -110..110 = the T exit into plaza/mid
  BOX(-210, 48, 400, 16, 96, 80, 'wall');       // cover wall west
  BOX(210, 48, 400, 16, 96, 80, 'wall');        // cover wall east

  // ---- CT Spawn (north, z -444..-300) ----
  BOX(-350, 48, -300, 140, 96, 16, 'wall');     // x -420..-280
  BOX(-130, 48, -300, 180, 96, 16, 'wall');     // x -220..-40
  BOX(130, 48, -300, 180, 96, 16, 'wall');      // x 40..220
  BOX(350, 48, -300, 140, 96, 16, 'wall');      // x 280..420
  //   -> gaps: -280..-220 (to B), -40..40 (to Mid), 220..280 (to A)
  BOX(-210, 48, -400, 16, 96, 80, 'wall');      // cover wall west
  BOX(210, 48, -400, 16, 96, 80, 'wall');       // cover wall east

  // ---- Mid (grey concrete corridor, x -72..72) ----
  BOX(80, 48, -240, 16, 96, 120, 'mid');        // east wall z -300..-180
  BOX(80, 48, 30, 16, 96, 180, 'mid');          // east wall z -60..120
  BOX(-80, 48, -240, 16, 96, 120, 'mid');       // west wall z -300..-180
  BOX(-80, 48, 30, 16, 96, 180, 'mid');         // west wall z -60..120
  //   -> gaps z -180..-60 lead to A (east) and B (west)
  BOX(0, 24, -40, 72, 48, 96, 'mid');           // "Xbox" — jump on top

  // ---- A Site (east): raised platform + ramp + Palace + Tetris ----
  BOX(322, 32, -180, 164, 64, 240, 'concrete'); // platform x 240..404, top y=64
  // ramp: ground y=0 at x~110 -> platform y=64 at x=240 (~26 deg)
  RAMP(178.5, 24.8, -180, 145, 16, 140, 0.4595, 'concrete');

  // Palace (room sitting on the platform, doorway in its south wall)
  BOX(352, 112, -292, 104, 96, 16, 'wall');     // palace north
  BOX(300, 112, -240, 16, 96, 120, 'wall');     // palace west
  BOX(320, 112, -180, 40, 96, 16, 'wall');      // palace south x 300..340
  BOX(392, 112, -180, 24, 96, 16, 'wall');      // palace south x 380..404
  //   -> doorway x 340..380

  // Tetris (stacked crates on the platform, near the ramp top)
  BOX(340, 80, -90, 48, 32, 48, 'crate');
  BOX(380, 80, -90, 48, 32, 48, 'crate');
  BOX(380, 112, -90, 48, 32, 48, 'crate');

  // ---- B Site (west): van + apartment building + crates ----
  BOX(-300, 20, -140, 150, 40, 70, 'mid');      // van body (top y=40)
  BOX(-385, 25, -140, 30, 50, 70, 'mid');       // van cab  (top y=50)

  // apartment building (big box, doorway in the south wall)
  BOX(-332, 60, -292, 144, 120, 16, 'wall');    // north wall
  BOX(-260, 60, -232, 16, 120, 128, 'wall');    // east wall (west = perimeter)
  BOX(-384, 60, -164, 40, 120, 16, 'wall');     // south wall x -404..-364
  BOX(-292, 60, -164, 64, 120, 16, 'wall');     // south wall x -324..-260
  //   -> doorway x -364..-324

  // B crates + plaza cover
  BOX(-300, 32, -60, 64, 64, 64, 'crate');
  BOX(-300, 96, -60, 64, 64, 64, 'crate');
  BOX(-140, 32, -260, 64, 64, 64, 'crate');
  BOX(140, 32, 200, 64, 64, 64, 'crate');
  BOX(-150, 32, 180, 64, 64, 64, 'crate');
  BOX(0, 32, 240, 64, 64, 64, 'crate');

  // ---- zone markers ----
  MARK(322, 64.6, -180, 140, 200, 0xa8324a);    // A site (on platform)
  MARK(-300, 0.8, -60, 200, 160, 0x4a7fc0);     // B site

  // ================================================================
  // SPAWN POINTS
  //   TEAM_SPAWNS  — where the player spawns per chosen team
  //   ENEMY_SPAWNS — keyed by PLAYER team: enemies always spawn on the
  //                   opposite side (T player -> enemies north/CT side)
  //   wps = patrol waypoints [x, z] for that area
  // ================================================================
  const TEAM_SPAWNS = {
    T:  { x: 0, y: 0, z: 400,  yaw: 0 },          // faces north (-Z)
    CT: { x: 0, y: 0, z: -400, yaw: Math.PI },    // faces south (+Z)
  };

  const ENEMY_SPAWNS = {
    // player picked T -> enemies (CTs) hold the north half
    T: [
      { x: -150, y: 36,  z: -390, wps: [[-190, -430], [-50, -430], [-50, -330], [-190, -330]] }, // CT spawn W
      { x: 150,  y: 36,  z: -390, wps: [[60, -430], [190, -430], [190, -340], [60, -340]] },     // CT spawn E
      { x: 170,  y: 36,  z: -60,  wps: [[120, -30], [230, -30], [230, -80], [120, -80]] },       // A site ground
      { x: 270,  y: 100, z: -200, wps: [[270, -270], [270, -190], [265, -100], [295, -100]] },    // A platform (top y=64)
      { x: -170, y: 36,  z: -70,  wps: [[-130, -30], [-210, -30], [-210, -90], [-130, -90]] },    // B site
      { x: -340, y: 36,  z: -230, wps: [[-390, -280], [-275, -280], [-275, -180], [-390, -180]] },// B apartments
      { x: 0,    y: 36,  z: -240, wps: [[-40, -270], [40, -270], [40, -160], [-40, -160]] },      // Mid north
      { x: 0,    y: 36,  z: 60,   wps: [[-40, 20], [40, 20], [40, 100], [-40, 100]] },            // Mid south
    ],
    // player picked CT -> enemies (Ts) hold the south half
    CT: [
      { x: -120, y: 36, z: 400, wps: [[-190, 430], [-50, 430], [-50, 330], [-190, 330]] },        // T spawn W
      { x: 120,  y: 36, z: 400, wps: [[50, 330], [190, 330], [190, 430], [50, 430]] },            // T spawn E
      { x: 170,  y: 36, z: 60,  wps: [[120, 30], [230, 30], [230, 90], [120, 90]] },              // A site south
      { x: 300,  y: 36, z: -40, wps: [[260, -40], [380, -40], [380, 10], [260, 10]] },            // A site mid
      { x: -170, y: 36, z: 40,  wps: [[-130, 20], [-210, 20], [-210, 90], [-130, 90]] },          // B site south
      { x: -340, y: 36, z: 200, wps: [[-390, 150], [-275, 150], [-275, 250], [-390, 250]] },      // plaza west
      { x: 0,    y: 36, z: 160, wps: [[-50, 140], [50, 140], [50, 260], [-50, 260]] },            // plaza mid
      { x: 0,    y: 36, z: 60,  wps: [[-40, 20], [40, 20], [40, 100], [-40, 100]] },              // Mid south
    ],
  };

  // ================================================================
  // ENEMIES
  // ================================================================
  const enemies = [];
  const tracers = [];

  function spawnEnemy(x, y, z, waypoints) {
    const mat = new THREE.MeshStandardMaterial({ color: 0xc41e3a, roughness: 0.6, emissive: 0x000000 });
    const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(16, 40, 4, 14), mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    enemies.push(mesh);
    shootables.push(mesh);

    // little gun hint on the front (local +Z faces the player)
    const gunHint = new THREE.Mesh(
      new THREE.BoxGeometry(2, 2, 8),
      new THREE.MeshStandardMaterial({ color: 0x1a1d22, roughness: 0.5, metalness: 0.6 })
    );
    gunHint.position.set(6, -4, 16);
    mesh.add(gunHint);

    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z)
    );
    body.lockRotations(true);
    world.createCollider(
      RAPIER.ColliderDesc.capsule(PLAYER.halfHeight, PLAYER.radius)
        .setFriction(0)
        .setRestitution(0),
      body
    );

    mesh.userData = {
      enemy: true,
      hp: ENEMY_HP,
      flashUntil: 0,
      body,
      waypoints,
      wpIndex: 0,
      state: 'patrol',
      checkAt: performance.now(),
      checkX: x,
      checkZ: z,
      strafeDir: Math.random() < 0.5 ? -1 : 1,
      strafeUntil: 0,
      nextShotAt: performance.now() + 800 + Math.random() * 900,
      losAt: 0,
      hasLOS: false,
    };
    return mesh;
  }

  function clearEnemies() {
    for (const e of enemies) {
      scene.remove(e);
      world.removeRigidBody(e.userData.body);
      const j = shootables.indexOf(e);
      if (j >= 0) shootables.splice(j, 1);
      e.geometry.dispose();
      e.material.dispose();
    }
    enemies.length = 0;
  }

  function spawnRoundEnemies() {
    clearEnemies();
    const pts = (ENEMY_SPAWNS[playerTeam] || ENEMY_SPAWNS.T).slice();
    // shuffle spawn points, take 5
    for (let i = pts.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pts[i], pts[j]] = [pts[j], pts[i]];
    }
    for (let i = 0; i < ROUND.perRound && i < pts.length; i++) {
      const s = pts[i];
      spawnEnemy(s.x, s.y, s.z, s.wps);
    }
  }

  // ================================================================
  // player — DYNAMIC capsule (spawned at the chosen team's spawn)
  // ================================================================
  const CAPSULE_HALF = PLAYER.halfHeight + PLAYER.radius; // 36 = center -> feet
  const SPAWN_Y = CAPSULE_HALF + 5;
  const playerBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(TEAM_SPAWNS.T.x, SPAWN_Y, TEAM_SPAWNS.T.z)
      .setCcdEnabled(true)
  );
  playerBody.lockRotations(true);

  const playerCollider = world.createCollider(
    RAPIER.ColliderDesc.capsule(PLAYER.halfHeight, PLAYER.radius)
      .setFriction(0)
      .setRestitution(0),
    playerBody
  );

  const controls = new PointerLockControls(camera, renderer.domElement);

  // ================================================================
  // GUN VIEWMODELS — composite groups of primitives, one per weapon.
  // All live under gunRig (bottom-right of screen); only the active
  // weapon's group is visible.
  // ================================================================
  const gunRig = new THREE.Group();
  const GUN_BASE = new THREE.Vector3(6.5, -7.5, -14);
  gunRig.position.copy(GUN_BASE);
  camera.add(gunRig);
  gunRig.visible = false;   // hidden until pointer lock

  const mkMat = (color, metal = 0.6, rough = 0.5) =>
    new THREE.MeshStandardMaterial({ color, metalness: metal, roughness: rough });

  const addBox = (g, w, h, d, x, y, z, color, metal, rough, rotX = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mkMat(color, metal, rough));
    m.position.set(x, y, z);
    m.rotation.x = rotX;
    g.add(m);
    return m;
  };

  const addCyl = (g, r, len, x, y, z, color, metal = 0.7, rough = 0.4) => {
    // cylinder along Z (barrels point forward, -Z)
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 10), mkMat(color, metal, rough));
    m.rotation.x = Math.PI / 2;
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };

  // ---- Pistol (Glock): sleek slide + angled grip ----
  function buildPistol() {
    const g = new THREE.Group();
    addBox(g, 2.2, 1.6, 9,   0, 1.0, -1, 0x3a4048, 0.55, 0.45);      // slide
    addBox(g, 2.0, 0.9, 7,   0, 0.0, -0.5, 0x23262b, 0.5, 0.5);      // frame
    addBox(g, 1.9, 3.8, 2.4, 0, -2.4, 2.6, 0x23262b, 0.4, 0.6, 0.28);// grip (raked back)
    addCyl(g, 0.55, 4.5, 0, 0.85, -6.5, 0x1a1d22);                    // barrel tip
    addBox(g, 2.3, 0.4, 3.5, 0, 1.95, -3, 0xe11d48, 0.3, 0.4);       // red accent stripe
    addBox(g, 0.4, 0.7, 0.5, 0, 2.1, 2.8, 0x1a1d22);                 // rear sight
    addBox(g, 0.35, 0.6, 0.4, 0, 2.1, -4.6, 0x1a1d22);               // front sight
    addBox(g, 1.5, 1.4, 0.5, 0, -1.1, 0.6, 0x1a1d22, 0.5, 0.5);      // trigger guard block
    return { group: g, flash: new THREE.Vector3(0, 0.85, -9) };
  }

  // ---- SMG (MP5): long body, barrel, magazine ----
  function buildSMG() {
    const g = new THREE.Group();
    addBox(g, 2.4, 2.0, 13,  0, 0.8, -1, 0x2f3540, 0.55, 0.45);      // receiver
    addBox(g, 2.0, 1.2, 6,   0, 0.4, -8, 0x23262b, 0.5, 0.5);        // handguard
    addCyl(g, 0.6, 7,  0, 0.9, -11, 0x1a1d22);                       // barrel
    addBox(g, 1.6, 4.4, 2.2, 0, -2.6, 1.8, 0x23262b, 0.4, 0.6, 0.15);// grip
    addBox(g, 1.4, 5.0, 1.8, 0, -2.8, -3.5, 0x1a1d22, 0.5, 0.5, -0.12); // magazine (raked)
    addBox(g, 2.5, 0.4, 5,   0, 2.0, -2, 0xe11d48, 0.3, 0.4);        // red accent
    addBox(g, 1.8, 1.6, 3.5, 0, 0.9, 5.5, 0x23262b, 0.5, 0.5);       // stock stub
    addBox(g, 0.4, 0.7, 0.5, 0, 2.2, 4.5, 0x1a1d22);                 // rear sight
    addBox(g, 0.35, 0.6, 0.4, 0, 2.1, -7.5, 0x1a1d22);               // front sight
    return { group: g, flash: new THREE.Vector3(0, 0.9, -15) };
  }

  // ---- Deagle: chunky, heavy, long barrel ----
  function buildDeagle() {
    const g = new THREE.Group();
    addBox(g, 2.8, 2.4, 12,  0, 1.1, -1.5, 0x9aa1ac, 0.7, 0.35);     // big slide
    addBox(g, 2.5, 1.3, 9,   0, 0.0, -1, 0x6d7480, 0.6, 0.4);        // frame
    addCyl(g, 0.8, 6.5, 0, 1.1, -9.5, 0x4a5058);                     // long barrel
    addBox(g, 2.2, 4.6, 2.8, 0, -3.0, 3.0, 0x23262b, 0.4, 0.6, 0.3); // big grip
    addBox(g, 2.9, 0.5, 4,   0, 2.45, -4, 0xe11d48, 0.3, 0.4);       // red accent
    addBox(g, 0.5, 0.8, 0.6, 0, 2.7, 3.4, 0x1a1d22);                 // rear sight
    addBox(g, 0.45, 0.7, 0.5, 0, 2.6, -6.8, 0x1a1d22);               // front sight
    addBox(g, 1.7, 1.6, 0.6, 0, -1.3, 0.8, 0x1a1d22, 0.5, 0.5);      // trigger guard
    return { group: g, flash: new THREE.Vector3(0, 1.1, -13) };
  }

  const VIEWS = [buildPistol(), buildSMG(), buildDeagle()];
  for (const v of VIEWS) {
    v.group.visible = false;
    gunRig.add(v.group);
  }

  // muzzle flash: small emissive sphere + point light on the rig
  const flashMesh = new THREE.Mesh(
    new THREE.SphereGeometry(1.5, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0xfff2cc })
  );
  flashMesh.visible = false;
  gunRig.add(flashMesh);

  const muzzleLight = new THREE.PointLight(0xffcc88, 0, 80, 2);
  gunRig.add(muzzleLight);

  // ================================================================
  // COMBAT + HUD STATE
  // ================================================================
  let weaponIndex = 0;
  const ammo = WEAPONS.map(w => ({ mag: w.magSize, reserve: w.magSize * 3 }));
  let lastShotAt = 0;
  let recoil = 0;
  let flashUntil = 0;
  let hitmarkerUntil = 0;
  let damageFlashUntil = 0;     // red screen flash
  const dmgIndicators = [];     // directional arrows {el, until}

  const raycaster = new THREE.Raycaster();
  const SCREEN_CENTER = new THREE.Vector2(0, 0);

  const ammoEl = document.getElementById('ammo');
  const ammoMagEl = document.getElementById('ammoMag');
  const ammoResEl = document.getElementById('ammoRes');
  const moneyEl = document.getElementById('money');
  const weaponNameEl = document.getElementById('weaponName');
  const hitmarkerEl = document.getElementById('hitmarker');
  const hpEl = document.getElementById('hp');
  const hpBarEl = document.getElementById('hpBarFill');
  const roundNumEl = document.getElementById('roundNum');
  const enemiesEl = document.getElementById('enemiesLeft');
  const bannerEl = document.getElementById('roundBanner');
  const damageFlashEl = document.getElementById('damageFlash');
  const dmgIndicatorsEl = document.getElementById('dmgIndicators');
  const teamLabelEl = document.getElementById('teamLabel');

  function updateAmmoHUD() {
    const w = WEAPONS[weaponIndex];
    const a = ammo[weaponIndex];
    ammoMagEl.textContent = a.mag;
    ammoResEl.textContent = '/ ' + a.reserve;
    moneyEl.textContent = '$' + playerMoney;
    weaponNameEl.textContent = w.name;
    ammoEl.classList.toggle('low', a.mag <= Math.max(2, Math.floor(w.magSize * 0.3)));
  }

  function updateHPHUD() {
    hpEl.textContent = 'HP ' + Math.max(0, Math.ceil(playerHP));
    hpBarEl.style.width = Math.max(0, playerHP) + '%';
    hpEl.classList.toggle('low', playerHP <= 30);
  }

  function updateRoundHUD() {
    roundNumEl.textContent = ROUND.number || '—';
    enemiesEl.textContent = enemies.length;
  }

  let bannerUntil = 0;
  function showBanner(text, ms, color) {
    bannerEl.textContent = text;
    bannerEl.style.color = color || '#fff';
    bannerEl.style.opacity = '1';
    bannerEl.style.display = 'block';
    bannerUntil = performance.now() + ms;
  }

  function switchWeapon(i) {
    if (i < 0 || i >= WEAPONS.length || i === weaponIndex) return;
    weaponIndex = i;
    VIEWS.forEach((v, idx) => { v.group.visible = idx === i; });
    updateAmmoHUD();
    playBlip(900, 0.05, 0.18);
  }

  function reload() {
    const w = WEAPONS[weaponIndex];
    const a = ammo[weaponIndex];
    if (a.mag >= w.magSize || a.reserve <= 0) return;
    const take = Math.min(w.magSize - a.mag, a.reserve);
    a.mag += take;
    a.reserve -= take;
    updateAmmoHUD();
    playBlip(700, 0.05, 0.15);
  }

  function killEnemy(mesh, weapon) {
    scene.remove(mesh);
    world.removeRigidBody(mesh.userData.body);
    const i = enemies.indexOf(mesh);
    if (i >= 0) enemies.splice(i, 1);
    const j = shootables.indexOf(mesh);
    if (j >= 0) shootables.splice(j, 1);
    mesh.geometry.dispose();
    mesh.material.dispose();
    playerMoney += weapon.killReward;
    updateRoundHUD();
    console.log('[combat] killed with', weapon.name, '-> +$' + weapon.killReward,
                '(total $' + playerMoney + ')');

    // round won: every enemy down
    if (enemies.length === 0 && ROUND.state === 'active') endRound(true);
  }

  function shoot() {
    const w = WEAPONS[weaponIndex];
    const a = ammo[weaponIndex];
    const now = performance.now();
    if (now - lastShotAt < w.fireRate) return;
    lastShotAt = now;

    if (a.mag <= 0) {
      playBlip(500, 0.04, 0.12);
      return;
    }
    a.mag--;

    raycaster.setFromCamera(SCREEN_CENTER, camera);
    const hits = raycaster.intersectObjects(shootables, false);

    if (hits.length > 0) {
      const hit = hits[0];
      if (hit.object.userData.enemy) {
        const e = hit.object;
        e.userData.hp -= w.damage;
        e.userData.flashUntil = now + 90;
        hitmarkerUntil = now + 130;
        playBlip(1200, 0.05, 0.22);
        if (e.userData.hp <= 0) killEnemy(e, w);
      }
    }

    updateAmmoHUD();

    recoil = 1;
    flashUntil = now + 45;
    muzzleLight.intensity = 50;
    playShotSound();
  }

  // apply starting weapon
  VIEWS[0].group.visible = true;
  updateAmmoHUD();
  updateHPHUD();
  updateRoundHUD();

  // ================================================================
  // PLAYER DAMAGE — red flash + directional indicator + death
  // ================================================================
  function damagePlayer(amount, fromPos) {
    if (ROUND.state !== 'active') return;
    playerHP -= amount;
    updateHPHUD();
    damageFlashUntil = performance.now() + 220;
    playBlip(220, 0.08, 0.25);

    // directional indicator: angle of the shooter relative to look dir
    if (fromPos) {
      const p = playerBody.translation();
      const eye = new THREE.Vector3(p.x, p.y - CAPSULE_HALF + PLAYER.eyeHeight, p.z);
      const to = new THREE.Vector3(fromPos.x, eye.y, fromPos.z).sub(eye).normalize();
      const fwd = camera.getWorldDirection(new THREE.Vector3());
      const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
      const angle = Math.atan2(to.dot(right), to.dot(fwd));  // 0 = straight ahead

      const el = document.createElement('div');
      el.className = 'dmg-arrow';
      el.style.marginLeft = '-14px';   // center the 28px-wide triangle
      el.style.transform = 'rotate(' + (-angle * 180 / Math.PI) + 'deg)';
      dmgIndicatorsEl.appendChild(el);
      dmgIndicators.push({ el, until: performance.now() + 700 });
    }

    if (playerHP <= 0) {
      playerHP = 0;
      endRound(false);   // round lost
    }
  }

  function respawnPlayer() {
    const s = TEAM_SPAWNS[playerTeam] || TEAM_SPAWNS.T;
    playerBody.setTranslation({ x: s.x, y: SPAWN_Y, z: s.z }, true);
    playerBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
    camera.rotation.y = s.yaw;   // face the enemy side
    playerHP = PLAYER.maxHP;
    updateHPHUD();
  }

  // ================================================================
  // ROUND SYSTEM — (menu) -> Warmup -> Active -> Round Over -> next
  // ================================================================
  function endRound(won) {
    if (ROUND.state !== 'active') return;
    ROUND.state = 'roundover';
    ROUND.stateAt = performance.now();
    ROUND.nextAt = ROUND.stateAt + 3000;
    if (won) {
      playerMoney += 1000;
      updateAmmoHUD();
      showBanner('ROUND ' + ROUND.number + ' WON   +$1000', 2600, '#4dff88');
      playBlip(660, 0.15, 0.2);
      delay(() => playBlip(880, 0.2, 0.2), 160);
    } else {
      showBanner('ROUND ' + ROUND.number + ' LOST', 2600, '#ff4d5e');
      playBlip(200, 0.3, 0.22);
      clearEnemies();   // clean up remaining bots on a loss
    }
    updateRoundHUD();
  }

  function startRound(n) {
    ROUND.number = n;
    ROUND.state = 'active';
    ROUND.stateAt = performance.now();
    respawnPlayer();
    spawnRoundEnemies();
    updateRoundHUD();
    showBanner('ROUND ' + n, 1400, '#fff');
    playBlip(520, 0.1, 0.18);
  }

  function startWarmup() {
    ROUND.state = 'warmup';
    ROUND.stateAt = performance.now();
    ROUND.nextAt = ROUND.stateAt + 3000;
    ROUND.number = 0;
    updateRoundHUD();
    showBanner('WARMUP — GET READY', 2200, '#ffc14d');
  }

  function delay(fn, ms) { setTimeout(fn, ms); }

  // round state machine tick (called every frame)
  function tickRounds(now) {
    if (ROUND.state === 'menu') return;   // no rounds until a team is picked
    if (ROUND.state === 'warmup' && now >= ROUND.nextAt) {
      startRound(1);
    } else if (ROUND.state === 'roundover' && now >= ROUND.nextAt) {
      startRound(ROUND.number + 1);
    }
  }

  // ================================================================
  // BUY MENU — press B to toggle (pauses game inputs)
  // ================================================================
  let buyMenuOpen = false;
  const owned = WEAPONS.map((_, i) => i === 0);
  const buyMenuEl = document.getElementById('buyMenu');
  const buyCardsEl = document.getElementById('buyCards');
  const buyMoneyEl = document.getElementById('buyMoney');

  function refreshBuyMenu() {
    buyMoneyEl.textContent = '$' + playerMoney;
    for (const card of buyCardsEl.children) {
      const i = +card.dataset.i;
      const w = WEAPONS[i];
      const btn = card.querySelector('.buy-btn');
      const equipped = i === weaponIndex;
      card.classList.toggle('equipped', equipped);
      btn.disabled = equipped || (!owned[i] && playerMoney < w.price);
      btn.textContent = equipped ? 'EQUIPPED'
        : owned[i] ? 'EQUIP'
        : 'BUY $' + w.price;
    }
  }

  function buyWeapon(i) {
    const w = WEAPONS[i];
    if (i === weaponIndex) return;
    if (!owned[i]) {
      if (playerMoney < w.price) { playBlip(300, 0.1, 0.15); return; }
      playerMoney -= w.price;
      owned[i] = true;
      ammo[i] = { mag: w.magSize, reserve: w.magSize * 3 };
    }
    switchWeapon(i);
    updateAmmoHUD();
    refreshBuyMenu();
    playBlip(1100, 0.06, 0.2);
  }

  function openBuyMenu() {
    buyMenuOpen = true;
    buyMenuEl.classList.add('open');
    refreshBuyMenu();
    keys.clear();
    jumpQueued = false;
    if (controls.isLocked) controls.unlock();
  }

  function closeBuyMenu() {
    buyMenuOpen = false;
    buyMenuEl.classList.remove('open');
  }

  function toggleBuyMenu() {
    if (buyMenuOpen) closeBuyMenu();
    else if (controls.isLocked) openBuyMenu();
  }

  WEAPONS.forEach((w, i) => {
    const card = document.createElement('div');
    card.className = 'buy-card';
    card.dataset.i = i;
    card.innerHTML = `
      <div class="bc-top"><span class="bc-name">${w.name}</span><span class="bc-slot">${w.slot}</span></div>
      <div class="bc-stats">
        <div><b>${w.damage}</b><span>DMG</span></div>
        <div><b>${Math.round(60000 / w.fireRate)}</b><span>RPM</span></div>
        <div><b>${w.magSize}</b><span>MAG</span></div>
      </div>
      <button class="buy-btn"></button>`;
    card.querySelector('.buy-btn').addEventListener('click', ev => {
      ev.stopPropagation();
      buyWeapon(i);
    });
    buyCardsEl.appendChild(card);
  });

  document.getElementById('buyClose').addEventListener('click', closeBuyMenu);
  buyMenuEl.addEventListener('click', e => {
    if (e.target === buyMenuEl) closeBuyMenu();
  });

  // ================================================================
  // per-frame player state (movement — unchanged)
  // ================================================================
  const vel = new THREE.Vector3();
  let isGrounded = false;
  let jumpQueued = false;

  const overlay = document.getElementById('overlay');
  const loadingEl = document.getElementById('loading');
  const teamSelectEl = document.getElementById('teamSelect');
  const resumeEl = document.getElementById('resume');
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsModal = document.getElementById('settingsModal');

  // ---------------- TEAM SELECT ----------------
  function joinTeam(team) {
    if (playerTeam) return;
    playerTeam = team;

    // spawn at the chosen team's spawn, facing the enemy side
    const s = TEAM_SPAWNS[team];
    playerBody.setTranslation({ x: s.x, y: SPAWN_Y, z: s.z }, true);
    playerBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
    camera.rotation.y = s.yaw;

    // HUD team label
    teamLabelEl.textContent = team;
    teamLabelEl.className = 'val ' + team.toLowerCase();

    teamSelectEl.style.display = 'none';
    resumeEl.style.display = 'block';

    startWarmup();          // round machine begins AFTER a team is chosen
    controls.lock();        // click on the button = user gesture -> allowed
  }

  document.getElementById('joinT').addEventListener('click', e => {
    e.stopPropagation();
    joinTeam('T');
  });
  document.getElementById('joinCT').addEventListener('click', e => {
    e.stopPropagation();
    joinTeam('CT');
  });

  // clicking the overlay resumes only once a team is chosen
  overlay.addEventListener('click', () => {
    if (!playerTeam) return;
    controls.lock();
  });

  controls.addEventListener('lock', () => {
    overlay.style.display = 'none';
    settingsBtn.style.display = 'none';
    document.getElementById('crosshair').style.display = 'block';
    document.getElementById('hud').style.display = 'block';
    document.getElementById('roundHud').style.display = 'flex';
    document.getElementById('hpBox').style.display = 'block';
    ammoEl.style.display = 'block';
    gunRig.visible = true;
  });
  controls.addEventListener('unlock', () => {
    overlay.style.display = 'flex';
    settingsBtn.style.display = 'flex';
    loadingEl.style.display = 'none';
    teamSelectEl.style.display = playerTeam ? 'none' : 'block';
    resumeEl.style.display = playerTeam ? 'block' : 'none';
    document.getElementById('crosshair').style.display = 'none';
    document.getElementById('hud').style.display = 'none';
    document.getElementById('roundHud').style.display = 'none';
    document.getElementById('hpBox').style.display = 'none';
    ammoEl.style.display = 'none';
    gunRig.visible = false;
    keys.clear();
    jumpQueued = false;
  });

  window.addEventListener('mousedown', e => {
    if (e.button !== 0 || !controls.isLocked || buyMenuOpen) return;
    shoot();
  });

  // ---------------- input ----------------
  const keys = new Set();
  window.addEventListener('keydown', e => {
    if (e.code === 'KeyB' && !e.repeat && (controls.isLocked || buyMenuOpen)) {
      toggleBuyMenu();
      return;
    }
    if (buyMenuOpen) {
      if (e.code === 'Escape') closeBuyMenu();
      return;
    }
    if (!controls.isLocked) {
      if (e.code === 'Escape') settingsModal.classList.remove('open');
      return;
    }
    keys.add(e.code);
    if (e.code === 'Digit1') switchWeapon(0);
    if (e.code === 'Digit2') switchWeapon(1);
    if (e.code === 'Digit3') switchWeapon(2);
    if (e.code === 'KeyR' && !e.repeat) reload();
    if (e.code === 'Space') {
      e.preventDefault();
      if (settings.jumpBind === 'space' && !e.repeat) jumpQueued = true;
    }
    if (['ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
  });
  window.addEventListener('keyup', e => keys.delete(e.code));

  window.addEventListener('wheel', e => {
    if (!controls.isLocked || settings.jumpBind !== 'wheel') return;
    if (e.deltaY > 0) jumpQueued = true;
  }, { passive: true });

  // ---------------- settings UI ----------------
  settingsBtn.addEventListener('click', e => {
    e.stopPropagation();
    settingsModal.classList.add('open');
  });
  document.getElementById('settingsClose')
    .addEventListener('click', () => settingsModal.classList.remove('open'));
  settingsModal.addEventListener('click', e => {
    if (e.target === settingsModal) settingsModal.classList.remove('open');
  });
  document.querySelectorAll('input[name="jumpBind"]').forEach(radio => {
    radio.checked = radio.value === settings.jumpBind;
    radio.addEventListener('change', () => {
      if (radio.checked) {
        settings.jumpBind = radio.value;
        saveSettings();
      }
    });
  });

  // ================================================================
  // GROUND CHECK — long enough to catch the ~26 deg A ramp
  // ================================================================
  function checkGrounded() {
    const p = playerBody.translation();
    const feet = p.y - CAPSULE_HALF;
    const ray = new RAPIER.Ray(
      { x: p.x, y: feet - 0.1, z: p.z },
      { x: 0, y: -1, z: 0 }
    );
    const hit = world.castRay(ray, 3, true);
    return Boolean(hit);
  }

  // ================================================================
  // LINE OF SIGHT — ray from enemy chest to player eye, walls only
  // ================================================================
  const losRaycaster = new THREE.Raycaster();
  function enemyHasLOS(fromPos) {
    const pp = playerBody.translation();
    const eye = new THREE.Vector3(pp.x, pp.y - CAPSULE_HALF + PLAYER.eyeHeight, pp.z);
    const from = new THREE.Vector3(fromPos.x, fromPos.y + 20, fromPos.z);
    const dir = eye.clone().sub(from);
    const dist = dir.length();
    if (dist > ENEMY.shootRange) return false;
    dir.normalize();
    losRaycaster.set(from, dir);
    losRaycaster.far = dist;
    // only world geometry blocks LOS (filter out enemies)
    const worldOnly = shootables.filter(o => !o.userData.enemy);
    const hits = losRaycaster.intersectObjects(worldOnly, false);
    return hits.length === 0;   // nothing between us and the player
  }

  // ================================================================
  // ENEMY SHOTS — origin starts IN FRONT of the enemy body, hit test
  // is ray-vs-player-capsule (no more grazing misses), visible fast
  // red tracer bolt.
  // ================================================================
  const boltGeo = new THREE.BoxGeometry(1.4, 1.4, 26);
  const boltMat = new THREE.MeshBasicMaterial({ color: 0xff2b2b });
  const BOLT_AXIS = new THREE.Vector3(0, 0, 1);
  const _pt = new THREE.Vector3();
  const _tmp = new THREE.Vector3();
  const _closest = new THREE.Vector3();

  // does a ray pass through the player's capsule (axis +/- halfHeight, r=16)?
  function rayHitsPlayer(origin, dir) {
    const pp = playerBody.translation();
    const top = pp.y + PLAYER.halfHeight;
    const bottom = pp.y - PLAYER.halfHeight;
    let best = Infinity;
    for (let i = 0; i <= 4; i++) {
      _pt.set(pp.x, bottom + (top - bottom) * (i / 4), pp.z);
      const t = Math.max(0, _tmp.copy(_pt).sub(origin).dot(dir));
      _closest.copy(origin).addScaledVector(dir, t);
      const d = _closest.distanceTo(_pt);
      if (d < best) best = d;
    }
    return best <= PLAYER.radius + 3;
  }

  function fireEnemyShot(enemyPos) {
    const pp = playerBody.translation();
    const eye = new THREE.Vector3(
      pp.x,
      pp.y - CAPSULE_HALF + PLAYER.eyeHeight,
      pp.z
    );
    const chest = new THREE.Vector3(enemyPos.x, enemyPos.y + 20, enemyPos.z);
    const dist = chest.distanceTo(eye);
    if (dist < 1) return;
    const toEye = eye.clone().sub(chest).divideScalar(dist);

    // start a few units in FRONT of the body so the ray never hits
    // the shooter's own capsule
    const start = chest.clone().addScaledVector(toEye, Math.min(24, dist * 0.4));

    // aim at the player's camera with distance-scaled spread
    const aim = eye.clone();
    const spread = 4 + dist * 0.018;
    aim.x += (Math.random() * 2 - 1) * spread;
    aim.y += (Math.random() * 2 - 1) * spread * 0.7;
    aim.z += (Math.random() * 2 - 1) * spread;

    const dir = aim.sub(start);
    const travel = dir.length();
    dir.normalize();

    // decide the hit NOW against the capsule — the bolt is just the visual
    const willHit = rayHitsPlayer(start, dir);

    const mesh = new THREE.Mesh(boltGeo, boltMat);
    mesh.position.copy(start);
    mesh.quaternion.setFromUnitVectors(BOLT_AXIS, dir);
    scene.add(mesh);
    tracers.push({
      mesh,
      dir,
      speed: ENEMY.tracerSpeed,
      traveled: 0,
      hitAt: travel,
      maxDist: willHit ? travel : travel + 60,
      willHit,
      damage: ENEMY.damage,
      origin: chest.clone(),
    });
    playShotSound(0.18);
  }

  function updateTracers(dt) {
    for (let i = tracers.length - 1; i >= 0; i--) {
      const t = tracers[i];
      const step = t.speed * dt;
      t.mesh.position.addScaledVector(t.dir, step);
      t.traveled += step;

      if (t.willHit && t.traveled >= t.hitAt) {
        damagePlayer(t.damage, t.origin);
        scene.remove(t.mesh);
        tracers.splice(i, 1);
        continue;
      }
      if (t.traveled >= t.maxDist) {
        scene.remove(t.mesh);
        tracers.splice(i, 1);
      }
    }
  }

  // ================================================================
  // ENEMY AI
  //   patrol — walk waypoints
  //   chase  — move at the player with random A/D strafing
  //   attack — in LOS + range: stop, face the player, fire red bolts
  // ================================================================
  function updateEnemies(now) {
    const pp = playerBody.translation();

    for (const e of enemies) {
      const body = e.userData.body;
      const p = body.translation();
      const dx = pp.x - p.x;
      const dz = pp.z - p.z;
      const dist = Math.hypot(dx, dz);

      // LOS check throttled to ~5 Hz
      if (now - e.userData.losAt > 200) {
        e.userData.hasLOS = enemyHasLOS(p);
        e.userData.losAt = now;
      }

      let vx = 0, vz = 0, speed = 0, state = 'patrol';
      const sameHeight = Math.abs(pp.y - p.y) < ENEMY.chaseYRange;

      if (e.userData.hasLOS && dist < ENEMY.shootRange && sameHeight) {
        // ---- ATTACK: stop, face player, shoot on cooldown ----
        state = 'attack';
        if (dist > 1) { vx = dx / dist; vz = dz / dist; }   // facing only
        e.rotation.y = Math.atan2(dx, dz);

        if (now >= e.userData.nextShotAt) {
          e.userData.nextShotAt = now + 900 + Math.random() * 700;
          fireEnemyShot(p);
        }
      } else if (dist < ENEMY.chaseRange && sameHeight) {
        // ---- CHASE: move at the player + strafe side to side ----
        state = 'chase';
        if (now >= e.userData.strafeUntil) {
          e.userData.strafeDir = Math.random() < 0.5 ? -1 : 1;
          e.userData.strafeUntil = now + 600 + Math.random() * 900;
        }
        if (dist > 1e-3) {
          const nx = dx / dist, nz = dz / dist;
          // perpendicular = (-nz, nx)
          vx = nx * 0.75 + (-nz) * e.userData.strafeDir * 0.6;
          vz = nz * 0.75 + (nx) * e.userData.strafeDir * 0.6;
          const l = Math.hypot(vx, vz);
          if (l > 1e-3) { vx /= l; vz /= l; }
          speed = ENEMY.chaseSpeed;
        }
        e.rotation.y = Math.atan2(dx, dz);
      } else {
        // ---- PATROL ----
        const wps = e.userData.waypoints;
        let wp = wps[e.userData.wpIndex];
        let wx = wp[0] - p.x, wz = wp[1] - p.z;
        let wd = Math.hypot(wx, wz);
        if (wd < 30) {
          let n = e.userData.wpIndex;
          while (n === e.userData.wpIndex) n = Math.floor(Math.random() * wps.length);
          e.userData.wpIndex = n;
          wx = wps[n][0] - p.x; wz = wps[n][1] - p.z;
          wd = Math.hypot(wx, wz);
        }
        if (wd > 1e-3) { vx = wx / wd; vz = wz / wd; speed = ENEMY.patrolSpeed; }

        if (now - e.userData.checkAt > 1200) {
          const moved = Math.hypot(p.x - e.userData.checkX, p.z - e.userData.checkZ);
          if (moved < 15) {
            let n = e.userData.wpIndex;
            while (n === e.userData.wpIndex) n = Math.floor(Math.random() * wps.length);
            e.userData.wpIndex = n;
          }
          e.userData.checkAt = now;
          e.userData.checkX = p.x;
          e.userData.checkZ = p.z;
        }
        if (speed > 0) e.rotation.y = Math.atan2(vx, vz);
      }

      e.userData.state = state;
      const lv = body.linvel();
      body.setLinvel({ x: vx * speed, y: lv.y, z: vz * speed }, true);
    }
  }

  // ================================================================
  // Source ground math (Quake/Source friction + accelerate) — unchanged
  // ================================================================
  function accelerate(v, wishDir, wishSpeed, accel, dt) {
    const currentSpeed = v.x * wishDir.x + v.z * wishDir.z;
    const addSpeed = wishSpeed - currentSpeed;
    if (addSpeed <= 0) return;
    let accelSpeed = accel * wishSpeed * dt;
    if (accelSpeed > addSpeed) accelSpeed = addSpeed;
    v.x += accelSpeed * wishDir.x;
    v.z += accelSpeed * wishDir.z;
  }

  function applyFriction(v, dt) {
    const speed = Math.hypot(v.x, v.z);
    if (speed < 0.1) { v.x = 0; v.z = 0; return; }
    const control = speed < MOVEMENT.stopSpeed ? MOVEMENT.stopSpeed : speed;
    const drop = control * MOVEMENT.friction * dt;
    let newSpeed = speed - drop;
    if (newSpeed < 0) newSpeed = 0;
    if (newSpeed !== speed) {
      newSpeed /= speed;
      v.x *= newSpeed;
      v.z *= newSpeed;
    }
  }

  function airAccelerate(v, wishX, wishZ, dt) {
    const wishspeed = MOVEMENT.airCap;
    const currentSpeed = v.x * wishX + v.z * wishZ;
    const addSpeed = wishspeed - currentSpeed;
    if (addSpeed > 0) {
      let accelSpeed = MOVEMENT.airAccelerate * wishspeed * dt;
      if (accelSpeed > addSpeed) accelSpeed = addSpeed;
      v.x += accelSpeed * wishX;
      v.z += accelSpeed * wishZ;
    }
  }

  function updateMovement(dt) {
    isGrounded = checkGrounded();

    const lv = playerBody.linvel();
    vel.set(lv.x, lv.y, lv.z);

    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    const yaw = Math.atan2(-dir.x, -dir.z);
    const sinY = Math.sin(yaw);
    const cosY = Math.cos(yaw);
    let wx = 0, wz = 0;
    if (keys.has('KeyW')) { wx += -sinY; wz += -cosY; }
    if (keys.has('KeyS')) { wx -= -sinY; wz -= -cosY; }
    if (keys.has('KeyD')) { wx +=  cosY; wz -=  sinY; }
    if (keys.has('KeyA')) { wx -=  cosY; wz -= -sinY; }

    const wishLen = Math.hypot(wx, wz);
    if (wishLen > 1e-9) { wx /= wishLen; wz /= wishLen; }
    const moving = wishLen > 1e-9;

    if (isGrounded) {
      applyFriction(vel, dt);
      if (moving) {
        accelerate(vel, { x: wx, z: wz }, MOVEMENT.maxSpeed, MOVEMENT.accelerate, dt);
      }
      if (jumpQueued) {
        vel.y = MOVEMENT.jumpVelocity;
      } else if (vel.y < 0) {
        vel.y = 0;
      }
    } else if (
      (keys.has('KeyA') || keys.has('KeyD')) &&
      moving
    ) {
      airAccelerate(vel, wx, wz, dt);
    }
    jumpQueued = false;

    playerBody.setLinvel({ x: vel.x, y: vel.y, z: vel.z }, true);
  }

  // ---------------- HUD (speed debug) ----------------
  const speedEl = document.getElementById('speed');
  const stateEl = document.getElementById('state');
  let lastSpeedLog = 0;

  // ================================================================
  // MAIN LOOP
  // ================================================================
  const clock = new THREE.Clock();

  function frame() {
    requestAnimationFrame(frame);
    let dt = Math.min(clock.getDelta(), 0.05);
    if (dt <= 0) dt = 1 / 120;
    const now = performance.now();

    tickRounds(now);

    if (controls.isLocked) updateMovement(dt);
    if (!buyMenuOpen && ROUND.state === 'active') updateEnemies(now);
    updateTracers(dt);
    world.step();

    for (const e of enemies) {
      const ep = e.userData.body.translation();
      e.position.set(ep.x, ep.y, ep.z);
    }

    const p = playerBody.translation();
    camera.position.set(
      p.x,
      p.y - CAPSULE_HALF + PLAYER.eyeHeight,
      p.z
    );

    const hSpeed = Math.hypot(vel.x, vel.z);
    speedEl.textContent = hSpeed.toFixed(0);
    stateEl.textContent = isGrounded ? 'ON GROUND' : 'AIR';

    if (controls.isLocked && now - lastSpeedLog >= 250) {
      lastSpeedLog = now;
      console.log('[speed]', hSpeed.toFixed(1), 'ups',
        isGrounded ? '(ground)' : '(air)', 'state:', ROUND.state);
    }

    // recoil
    if (recoil > 0) recoil = Math.max(0, recoil - dt * 7);
    gunRig.position.z = GUN_BASE.z + recoil * 3;
    gunRig.rotation.x = recoil * 0.12;

    // muzzle flash
    muzzleLight.intensity = Math.max(0, muzzleLight.intensity - dt * 600);
    if (now < flashUntil) {
      const fv = VIEWS[weaponIndex].flash;
      flashMesh.position.copy(fv);
      muzzleLight.position.copy(fv);
      flashMesh.visible = true;
    } else {
      flashMesh.visible = false;
    }

    // hitmarker
    hitmarkerEl.style.display = now < hitmarkerUntil ? 'block' : 'none';

    // damage flash + indicators
    if (now < damageFlashUntil) {
      const k = (damageFlashUntil - now) / 220;
      damageFlashEl.style.opacity = String(0.45 * k);
    } else {
      damageFlashEl.style.opacity = '0';
    }
    for (let i = dmgIndicators.length - 1; i >= 0; i--) {
      const d = dmgIndicators[i];
      if (now >= d.until) {
        d.el.remove();
        dmgIndicators.splice(i, 1);
      } else {
        d.el.style.opacity = String((d.until - now) / 700);
      }
    }

    // banner fade
    if (bannerUntil && now >= bannerUntil) {
      bannerEl.style.opacity = '0';
      bannerUntil = 0;
    }

    // enemy hit flash / chase glow
    for (const e of enemies) {
      e.material.emissive.setHex(
        now < e.userData.flashUntil ? 0x772211 :
        e.userData.state === 'chase' || e.userData.state === 'attack' ? 0x551111 :
        0x000000
      );
    }

    renderer.render(scene, camera);
  }

  addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // engine ready -> show the team select screen (rounds wait in 'menu')
  loadingEl.style.display = 'none';
  teamSelectEl.style.display = 'block';
  frame();
}

// ================================================================
// Procedural textures
// ================================================================
function noise(g, n, size, base, spread) {
  for (let i = 0; i < n; i++) {
    const v = base + (Math.random() * 2 - 1) * spread | 0;
    g.fillStyle = `rgba(${v},${v},${v + 4},0.4)`;
    g.fillRect(Math.random() * size, Math.random() * size, 3, 3);
  }
}

function makeConcreteTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#787d84';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 14; i++) {
    g.fillStyle = 'rgba(60,64,70,0.18)';
    const w = 30 + Math.random() * 70;
    g.fillRect(Math.random() * 256, Math.random() * 256, w, w * 0.6);
  }
  noise(g, 700, 256, 128, 45);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeSandTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#c8b487';
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = '#b09b6e';
  g.lineWidth = 3;
  for (let y = 0; y <= 256; y += 64) {
    g.beginPath(); g.moveTo(0, y); g.lineTo(256, y); g.stroke();
  }
  for (let row = 0; row < 4; row++) {
    const off = row % 2 ? 64 : 0;
    for (let x = off; x <= 256; x += 128) {
      g.beginPath(); g.moveTo(x, row * 64); g.lineTo(x, row * 64 + 64); g.stroke();
    }
  }
  noise(g, 500, 256, 190, 35);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeWoodTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#9a6b3f';
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = '#744f2c';
  g.lineWidth = 4;
  for (let x = 0; x <= 256; x += 64) {
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 256); g.stroke();
  }
  g.strokeStyle = 'rgba(60,38,18,0.25)';
  g.lineWidth = 1.5;
  for (let i = 0; i < 40; i++) {
    const x = Math.floor(Math.random() * 4) * 64 + 8 + Math.random() * 48;
    g.beginPath();
    g.moveTo(x, Math.random() * 256);
    g.lineTo(x + (Math.random() * 6 - 3), Math.random() * 256);
    g.stroke();
  }
  noise(g, 300, 256, 140, 40);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

boot().catch(e => fatal(e.stack || String(e)));


