// cs2-web-game — Phase 3: Grenades + Bomb Defusal
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
//   kick     = view punch in radians (camera jumps up when firing)
//   pellets  = rays per shot (Nova)
//   spread   = pellet cone (tangent units, camera right/up offsets)
//   zoomFov  = right-click scope FOV (AWP)
// ================================================================
const BASE_FOV = 90;
const WEAPONS = [
  { name: 'Glock',  slot: 'PISTOL',  price: 0,    damage: 26, fireRate: 170, magSize: 20, killReward: 300,  scale: 0.80, kick: 0.016 },
  { name: 'MP5',    slot: 'SMG',     price: 1200, damage: 28, fireRate: 90,  magSize: 30, killReward: 600,  scale: 1.00, kick: 0.013 },
  { name: 'Deagle', slot: 'PISTOL',  price: 3000, damage: 60, fireRate: 500, magSize: 7,  killReward: 1500, scale: 0.88, kick: 0.032 },
  { name: 'AWP',    slot: 'SNIPER',  price: 4750, damage: 130, fireRate: 1450, magSize: 5, killReward: 100,  scale: 1.15, kick: 0.050, zoomFov: 40 },
  { name: 'Nova',   slot: 'SHOTGUN', price: 1050, damage: 17, fireRate: 850,  magSize: 8,  killReward: 900,  scale: 1.05, kick: 0.045, pellets: 5, spread: 0.09 },
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
      route: null,
      routeIdx: 0,
      stuckAt: 0,
      stuckX: x,
      stuckZ: z,
      stuckN: 0,
      plantProg: 0,
      defuseProg: 0,
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

  // ---- AWP (sniper): long barrel, big scope, bolt handle, green body ----
  function buildSniper() {
    const g = new THREE.Group();
    addBox(g, 2.6, 2.4, 16, 0, 0.6, -2, 0x37472f, 0.35, 0.65);      // green receiver
    addBox(g, 2.2, 1.4, 8,  0, 0.3, -12, 0x1f2a1c, 0.3, 0.7);       // forend
    addCyl(g, 0.7, 13, 0, 1.1, -17.5, 0x1a1d22);                    // long barrel (to z -24)
    addBox(g, 1.9, 4.6, 2.6, 0, -2.6, 3.4, 0x37472f, 0.3, 0.7, 0.25); // grip
    addBox(g, 2.4, 3.2, 6,  0, -1.2, 9, 0x23262b, 0.35, 0.65);      // stock
    addCyl(g, 1.1, 7, 0, 3.2, -3, 0x1a1d22);                        // scope tube
    addCyl(g, 1.45, 2.2, 0, 3.2, -7.2, 0x1a1d22);                   // objective bell
    addCyl(g, 1.3, 1.6, 0, 3.2, 1.2, 0x1a1d22);                     // eyepiece
    addBox(g, 0.7, 1.7, 0.9, 0, 2.0, -1, 0x2f3540, 0.6, 0.4);       // scope mount
    addBox(g, 0.5, 0.9, 0.6, 1.7, 0.5, 0.6, 0x9aa1ac, 0.75, 0.35);  // bolt handle
    addBox(g, 0.4, 0.8, 0.5, 0, 4.9, -8.6, 0x1a1d22);               // front sight post
    return { group: g, flash: new THREE.Vector3(0, 1.1, -24.5) };
  }

  // ---- Nova (pump shotgun): black barrel + tube, wood forend/stock ----
  function buildShotgun() {
    const g = new THREE.Group();
    addBox(g, 2.6, 2.6, 10, 0, 0.4, 0, 0x2b2f36, 0.5, 0.5);         // receiver
    addCyl(g, 0.75, 14, 0, 1.5, -10, 0x1a1d22);                     // barrel (to z -17)
    addCyl(g, 0.6, 10, 0, -0.6, -8, 0x2f3540);                      // tube magazine
    addBox(g, 2.5, 1.9, 5.5, 0, 0.4, -8, 0x9a6b3f, 0.15, 0.85);     // wooden pump/forend
    addBox(g, 2.0, 4.2, 2.6, 0, -2.6, 3.6, 0x9a6b3f, 0.15, 0.85, 0.22); // wood grip
    addBox(g, 2.4, 3.0, 6,  0, -1.0, 9, 0x9a6b3f, 0.15, 0.85);      // wood stock
    addBox(g, 2.7, 0.5, 3.5, 0, 2.05, -1, 0xe11d48, 0.3, 0.4);      // red accent
    addBox(g, 0.35, 0.6, 0.4, 0, 2.6, -16.5, 0x1a1d22);             // bead sight
    return { group: g, flash: new THREE.Vector3(0, 1.5, -17.5) };
  }

  const VIEWS = [buildPistol(), buildSMG(), buildDeagle(), buildSniper(), buildShotgun()];
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

  // ---- grenade viewmodels (key 6 = smoke, key 7 = flashbang) ----
  function buildSmokeNade() {
    const g = new THREE.Group();
    addCyl(g, 1.5, 6, 0, 0, -3, 0x2f6b3a, 0.3, 0.7);            // green canister
    addCyl(g, 1.7, 1.2, 0, 0, -6.2, 0x1f4a28, 0.3, 0.7);         // bottom ring
    addBox(g, 0.9, 1.1, 1.4, 0, 1.6, -1, 0x9aa1ac, 0.7, 0.35);   // spoon lever
    addBox(g, 0.5, 1.2, 0.5, 0, 1.5, 0.4, 0xd94f4f, 0.2, 0.6);   // pull ring
    return { group: g, flash: new THREE.Vector3(0, 0, -7) };
  }
  function buildFlashNade() {
    const g = new THREE.Group();
    addCyl(g, 1.4, 5.5, 0, 0, -2.5, 0x8a8f96, 0.7, 0.35);        // grey body
    addCyl(g, 1.6, 1.1, 0, 0, -5.4, 0x5f646b, 0.7, 0.35);
    addBox(g, 0.9, 1.0, 1.3, 0, 1.5, -0.8, 0x9aa1ac, 0.7, 0.35);
    addBox(g, 0.5, 1.2, 0.5, 0, 1.4, 0.5, 0xe11d48, 0.2, 0.6);
    return { group: g, flash: new THREE.Vector3(0, 0, -6) };
  }
  const NADE_VIEWS = { smoke: buildSmokeNade(), flash: buildFlashNade() };
  for (const k in NADE_VIEWS) {
    NADE_VIEWS[k].group.visible = false;
    gunRig.add(NADE_VIEWS[k].group);
  }

  // ---- C4 bomb model (tan block + blinking red light) ----
  const c4Mesh = new THREE.Group();
  c4Mesh.add(new THREE.Mesh(
    new THREE.BoxGeometry(14, 6, 10),
    new THREE.MeshStandardMaterial({ color: 0xb08d57, roughness: 0.75 })
  ));
  const c4Light = new THREE.Mesh(
    new THREE.SphereGeometry(1.6, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0xff2020 })
  );
  c4Light.position.set(4, 3.2, 3);
  c4Mesh.add(c4Light);
  c4Mesh.userData.light = c4Light;
  c4Mesh.visible = false;
  scene.add(c4Mesh);

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
  let scoped = false;           // AWP right-click zoom state
  let viewPunch = 0;            // current camera recoil offset (radians, + = up)
  let viewPunchApplied = 0;     // part of viewPunch already baked into camera

  // ---------------- Phase 3: grenade state ----------------
  let grenadeMode = null;       // 'smoke' | 'flash' | null
  let lastNadeAt = 0;
  let lastGunIndex = 0;
  const projectiles = [];       // thrown grenades {mesh, body, kind, thrownAt, slowSince}
  const smokes = [];            // active smoke clouds {mesh, mat, until}
  let flashOverlayUntil = 0;    // white flashbang overlay fade end

  // ---------------- Phase 3: bomb state ----------------
  const BOMB_TIMER = 40000;     // 40s from plant to explosion
  const PLANT_TIME = 3000;      // hold E for 3s to plant
  const DEFUSE_TIME = 5000;     // hold E for 5s to defuse
  const bomb = { planted: false, plantedAt: 0, x: 0, y: 0, z: 0, site: null };
  let bombCarrier = null;       // enemy mesh carrying C4 (when player is CT)
  let plantProgress = 0;
  let defuseProgress = 0;

  // plant zones (XZ rect + capsule-center Y range)
  const PLANT_ZONES = [
    { site: 'A', x1: 250, x2: 400, z1: -175, z2: -70, y1: 50, y2: 180 },   // A platform
    { site: 'A', x1: 250, x2: 295, z1: -290, z2: -175, y1: 50, y2: 180 },  // A platform (palace side)
    { site: 'B', x1: -340, x2: -120, z1: -160, z2: -40, y1: 15, y2: 140 }, // B site
  ];

  // straight-line waypoint routes ("bots can't pathfind" — stuck-skip + teleport safety)
  const CARRIER_ROUTES = {
    A: {
      south: [[60, 250], [60, 170], [54, 60], [54, -110], [95, -120], [130, -150], [255, -150], [285, -130]],
      east: [[240, -30], [110, -45], [110, -150], [255, -150], [285, -130]],
      mid: [[54, 100], [54, -110], [95, -120], [130, -150], [255, -150], [285, -130]],
      west: [[-60, 250], [-60, 180], [0, 140], [54, 100], [54, -110], [95, -120], [130, -150], [255, -150], [285, -130]],
    },
    B: {
      south: [[-60, 250], [-60, 170], [-54, 60], [-54, -110], [-95, -120], [-150, -110], [-245, -90]],
      west: [[-300, 100], [-240, 0], [-205, -60], [-205, -100], [-245, -90]],
      east: [[-130, 0], [-130, -100], [-150, -110], [-205, -100], [-245, -90]],
      mid: [[-54, 100], [-54, -110], [-95, -120], [-150, -110], [-245, -90]],
    },
  };
  const CT_ROUTES = {
    A: [[0, -340], [0, -300], [0, -260], [0, -200], [40, -130], [95, -120], [130, -150], [255, -150], [285, -130]],
    B: [[0, -340], [0, -300], [0, -260], [0, -200], [-40, -130], [-95, -120], [-150, -110], [-205, -100]],
  };

  function carrierRoute(cp, site) {
    const r = CARRIER_ROUTES[site];
    if (cp.z > 140) return r.south;
    if (cp.x > 150) return r.east;
    if (cp.x < -150) return r.west;
    return r.mid;
  }

  // ---------------- bullet holes (decals, capped at 50) ----------------
  const MAX_BULLET_HOLES = 50;
  const bulletHoles = [];
  const holeGeo = new THREE.CircleGeometry(1.7, 12);
  const holeMat = new THREE.MeshBasicMaterial({
    color: 0x0b0b0b,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  const HOLE_NORMAL = new THREE.Vector3(0, 0, 1);

  function spawnBulletHole(point, normal) {
    const m = new THREE.Mesh(holeGeo, holeMat);
    // lift off the surface a hair + polygonOffset => no z-fighting
    m.position.copy(point).addScaledVector(normal, 0.15);
    // CircleGeometry faces +Z -> rotate it flat onto the surface
    m.quaternion.setFromUnitVectors(HOLE_NORMAL, normal);
    scene.add(m);
    bulletHoles.push(m);
    // CRITICAL: never let more than MAX_BULLET_HOLES exist — drop the oldest
    if (bulletHoles.length > MAX_BULLET_HOLES) {
      const oldest = bulletHoles.shift();
      scene.remove(oldest);
    }
  }

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
  const bombLabelEl = document.getElementById('bombLabel');
  const bombBarEl = document.getElementById('bombBar');
  const bombBarLabelEl = document.getElementById('bombBarLabel');
  const bombBarFillEl = document.getElementById('bombBarFill');
  const flashOverlayEl = document.getElementById('flashOverlay');

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

  function updateBombHUD() {
    if (!bombLabelEl) return;
    if (bomb.planted) {
      const left = Math.max(0, BOMB_TIMER - (performance.now() - bomb.plantedAt));
      const sec = Math.ceil(left / 1000);
      bombLabelEl.textContent = 'PLANTED ' + Math.floor(sec / 60) + ':' +
        String(sec % 60).padStart(2, '0');
      bombLabelEl.classList.add('planted');
    } else {
      bombLabelEl.textContent = 'NOT PLANTED';
      bombLabelEl.classList.remove('planted');
    }
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
    if (i < 0 || i >= WEAPONS.length) return;
    const nadeActive = grenadeMode !== null;
    if (i === weaponIndex && !nadeActive) return;
    if (scoped) setScoped(false);   // leaving the AWP drops the scope
    grenadeMode = null;             // switching to a gun stows the grenade
    NADE_VIEWS.smoke.group.visible = false;
    NADE_VIEWS.flash.group.visible = false;
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

    // if the bomb carrier dies, another T bot picks the bomb up
    if (mesh === bombCarrier) {
      bombCarrier = null;
      if (c4Mesh.parent) c4Mesh.parent.remove(c4Mesh);
      c4Mesh.visible = false;
      if (!bomb.planted && enemies.length > 0) {
        bombCarrier = enemies[0];
        bombCarrier.add(c4Mesh);
        c4Mesh.position.set(0, 18, -14);
        c4Mesh.rotation.set(0, Math.PI, 0);
        c4Mesh.visible = true;
      }
    }

    // round won: every enemy down (a planted bomb still needs defusing)
    if (enemies.length === 0 && ROUND.state === 'active') {
      if (bomb.planted && playerTeam === 'CT') {
        // all Ts dead but the bomb is ticking — player must defuse it
      } else {
        endRound(true);
      }
    }
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

    // --- rays: 1 for normal weapons, N spread rays for the Nova ---
    const pellets = w.pellets || 1;
    const spread = w.spread || 0;
    raycaster.setFromCamera(SCREEN_CENTER, camera);
    const baseDir = raycaster.ray.direction.clone();
    const camRight = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const camUp = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);

    for (let i = 0; i < pellets; i++) {
      if (pellets > 1) {
        const d = baseDir.clone()
          .addScaledVector(camRight, (Math.random() * 2 - 1) * spread)
          .addScaledVector(camUp, (Math.random() * 2 - 1) * spread)
          .normalize();
        raycaster.ray.direction.copy(d);
      }
      // bullets pass through smoke clouds (CS-style), but not walls
      const hits = raycaster.intersectObjects(shootables, false)
        .filter(h => !h.object.userData.smoke);
      if (hits.length === 0) continue;
      const hit = hits[0];
      if (hit.object.userData.enemy) {
        const e = hit.object;
        e.userData.hp -= w.damage;
        e.userData.flashUntil = now + 90;
        hitmarkerUntil = now + 130;
        playBlip(1200, 0.05, 0.22);
        if (e.userData.hp <= 0) killEnemy(e, w);
      } else if (hit.face) {
        // wall / ground / crate -> bullet hole, oriented to the surface
        const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
        spawnBulletHole(hit.point, normal);
      }
    }

    updateAmmoHUD();

    // --- gun kick (backward + up, smoothed back in frame()) ---
    recoil = Math.min(1.8, recoil + w.kick * 55);
    // --- view punch (camera jumps up, recovers smoothly in frame()) ---
    viewPunch = Math.min(0.06, viewPunch + w.kick);

    flashUntil = now + 45;
    muzzleLight.intensity = 50;
    playShotSound();
  }

  // ================================================================
  // PHASE 3 — GRENADES (Smoke / Flashbang)
  // ================================================================
  function selectNade(mode) {
    if (grenadeMode === mode) return;
    if (scoped) setScoped(false);
    if (grenadeMode === null) lastGunIndex = weaponIndex;
    grenadeMode = mode;
    VIEWS.forEach(v => { v.group.visible = false; });
    NADE_VIEWS.smoke.group.visible = mode === 'smoke';
    NADE_VIEWS.flash.group.visible = mode === 'flash';
    weaponNameEl.textContent = mode === 'smoke' ? 'SMOKE' : 'FLASHBANG';
    playBlip(620, 0.05, 0.15);
  }

  function throwGrenade() {
    if (!grenadeMode) return;
    const now = performance.now();
    if (now - lastNadeAt < 900) return;   // throw cooldown
    lastNadeAt = now;
    const kind = grenadeMode;

    raycaster.setFromCamera(SCREEN_CENTER, camera);
    const dir = raycaster.ray.direction.clone();
    const origin = camera.position.clone().addScaledVector(dir, 24);
    origin.y -= 4;

    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(4, 10, 10),
      new THREE.MeshStandardMaterial({
        color: kind === 'smoke' ? 0x2f6b3a : 0x8a8f96,
        roughness: 0.6,
      })
    );
    mesh.position.copy(origin);
    mesh.castShadow = true;
    scene.add(mesh);

    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(origin.x, origin.y, origin.z)
    );
    world.createCollider(
      RAPIER.ColliderDesc.ball(4).setRestitution(0.35).setFriction(0.7),
      body
    );
    body.setLinvel({ x: dir.x * 480, y: dir.y * 480 + 40, z: dir.z * 480 }, true);

    projectiles.push({ mesh, body, kind, thrownAt: now, slowSince: 0 });
    playShotSound(0.3);

    // auto-switch back to the primary gun
    grenadeMode = null;
    NADE_VIEWS.smoke.group.visible = false;
    NADE_VIEWS.flash.group.visible = false;
    weaponIndex = lastGunIndex;
    VIEWS.forEach((v, idx) => { v.group.visible = idx === weaponIndex; });
    updateAmmoHUD();
  }

  function detonateProjectile(p, i) {
    const t = p.body.translation();
    world.removeRigidBody(p.body);
    scene.remove(p.mesh);
    p.mesh.geometry.dispose();
    p.mesh.material.dispose();
    projectiles.splice(i, 1);

    if (p.kind === 'smoke') {
      spawnSmoke(t.x, t.y, t.z);
      playBlip(170, 0.3, 0.22);
    } else {
      spawnFlash(t.x, t.y, t.z);
      playBlip(1500, 0.35, 0.3);
    }
  }

  function updateGrenades(dt, now) {
    // projectiles: detonate after landing (slow for 350ms) or 5s fuse
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const p = projectiles[i];
      const t = p.body.translation();
      p.mesh.position.set(t.x, t.y, t.z);
      p.mesh.rotation.x += dt * 7;

      const lv = p.body.linvel();
      const spd = Math.hypot(lv.x, lv.y, lv.z);
      const expired = now - p.thrownAt > 5000;
      if (spd < 25) {
        if (!p.slowSince) p.slowSince = now;
        if (expired || now - p.slowSince > 350) detonateProjectile(p, i);
      } else {
        p.slowSince = 0;
        if (expired) detonateProjectile(p, i);
      }
    }

    // smoke cloud lifetimes (15s, fade out in the last 2s)
    for (let i = smokes.length - 1; i >= 0; i--) {
      const s = smokes[i];
      const left = s.until - now;
      if (left <= 0) { removeSmoke(i); continue; }
      if (left < 2000) s.mat.opacity = 0.85 * (left / 2000);
    }
  }

  function spawnSmoke(x, y, z) {
    if (smokes.length >= 4) removeSmoke(0);   // cap active smokes
    const mat = new THREE.MeshBasicMaterial({
      color: 0xb9bcbe,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(90, 18, 14), mat);
    mesh.position.set(x, y + 70, z);
    mesh.userData.smoke = true;
    scene.add(mesh);
    shootables.push(mesh);   // blocks enemy line-of-sight for 15s
    smokes.push({ mesh, mat, until: performance.now() + 15000 });
  }

  function removeSmoke(i) {
    const s = smokes[i];
    scene.remove(s.mesh);
    const j = shootables.indexOf(s.mesh);
    if (j >= 0) shootables.splice(j, 1);
    s.mesh.geometry.dispose();
    s.mat.dispose();
    smokes.splice(i, 1);
  }

  function spawnFlash(x, y, z) {
    const t = playerBody.translation();
    const eye = new THREE.Vector3(t.x, t.y - CAPSULE_HALF + PLAYER.eyeHeight, t.z);
    const to = new THREE.Vector3(x, y, z).sub(eye);
    const dist = to.length();
    if (dist > 900) return;              // too far to be blinded
    if (dist > 1) {
      to.normalize();
      // walls block the flash
      losRaycaster.set(eye, to);
      losRaycaster.far = dist;
      const wallsOnly = shootables.filter(o => !o.userData.enemy && !o.userData.smoke);
      if (losRaycaster.intersectObjects(wallsOnly, false).length > 0) return;
    }
    const fwd = camera.getWorldDirection(new THREE.Vector3());
    // blinded only when roughly facing the detonation (~60 deg cone)
    if (dist < 1 || fwd.dot(to) > 0.5) {
      flashOverlayUntil = performance.now() + 3000;
    }
  }

  function clearGrenades() {
    for (const p of projectiles) {
      world.removeRigidBody(p.body);
      scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      p.mesh.material.dispose();
    }
    projectiles.length = 0;
    while (smokes.length) removeSmoke(0);
    flashOverlayUntil = 0;
    if (flashOverlayEl) flashOverlayEl.style.opacity = '0';
    grenadeMode = null;
    lastNadeAt = 0;
    NADE_VIEWS.smoke.group.visible = false;
    NADE_VIEWS.flash.group.visible = false;
    VIEWS.forEach((v, idx) => { v.group.visible = idx === weaponIndex; });
  }

  // ================================================================
  // PHASE 3 — BOMB DEFUSAL
  // ================================================================
  function zoneAt(x, y, z) {
    for (const zn of PLANT_ZONES) {
      if (x >= zn.x1 && x <= zn.x2 && z >= zn.z1 && z <= zn.z2 &&
          y >= zn.y1 && y <= zn.y2) return zn;
    }
    return null;
  }

  // straight-line walkability test (walls/crates block it; smoke does not)
  function clearPathTo(fx, fy, fz, tx, ty, tz) {
    const from = new THREE.Vector3(fx, fy, fz);
    const dir = new THREE.Vector3(tx, ty, tz).sub(from);
    const dist = dir.length();
    if (dist <= 10) return true;
    dir.normalize();
    losRaycaster.set(from, dir);
    losRaycaster.far = dist - 8;
    const worldOnly = shootables.filter(o => !o.userData.enemy && !o.userData.smoke);
    return losRaycaster.intersectObjects(worldOnly, false).length === 0;
  }

  function plantBomb(x, y, z, site) {
    if (bomb.planted) return;
    bomb.planted = true;
    bomb.plantedAt = performance.now();
    bomb.x = x; bomb.y = y; bomb.z = z;
    bomb.site = site;
    bombCarrier = null;
    if (c4Mesh.parent) c4Mesh.parent.remove(c4Mesh);
    scene.add(c4Mesh);
    c4Mesh.position.set(x, y + 7, z);
    c4Mesh.rotation.set(0, 0, 0);
    c4Mesh.visible = true;
    showBanner('BOMB PLANTED', 1500, '#ff4d5e');
    playBlip(440, 0.15, 0.25);

    // CT bots rush the bomb site to defuse
    if (playerTeam === 'T') {
      const route = bomb.site === 'A' ? CT_ROUTES.A : CT_ROUTES.B;
      for (const e of enemies) {
        const ep = e.userData.body.translation();
        e.userData.route = route;
        e.userData.routeIdx = 0;
        e.userData.stuckAt = 0;
        e.userData.stuckX = ep.x;
        e.userData.stuckZ = ep.z;
        e.userData.stuckN = 0;
        e.userData.defuseProg = 0;
      }
    }
  }

  function resetBomb() {
    bomb.planted = false;
    bomb.plantedAt = 0;
    bomb.site = null;
    bomb.x = 0; bomb.y = 0; bomb.z = 0;
    bombCarrier = null;
    plantProgress = 0;
    defuseProgress = 0;
    if (c4Mesh.parent) c4Mesh.parent.remove(c4Mesh);
    c4Mesh.visible = false;
    if (bombBarEl) bombBarEl.style.display = 'none';

    // player is CT -> a T bot picks up the bomb and carries it to a site
    if (playerTeam === 'CT' && enemies.length > 0) {
      bombCarrier = enemies[0];
      const cp = bombCarrier.userData.body.translation();
      const site = cp.x > 150 ? 'A' : cp.x < -150 ? 'B' : (Math.random() < 0.5 ? 'A' : 'B');
      bombCarrier.userData.targetSite = site;
      bombCarrier.userData.route = carrierRoute(cp, site);
      bombCarrier.userData.routeIdx = 0;
      bombCarrier.userData.stuckAt = 0;
      bombCarrier.userData.stuckX = cp.x;
      bombCarrier.userData.stuckZ = cp.z;
      bombCarrier.userData.stuckN = 0;
      bombCarrier.add(c4Mesh);
      c4Mesh.position.set(0, 18, -14);
      c4Mesh.rotation.set(0, Math.PI, 0);
      c4Mesh.visible = true;
    }
    updateBombHUD();
  }

  // follow e.userData.route with waypoint advance + stuck teleport safety
  function navRoute(e, p, spd, now) {
    const u = e.userData;
    const route = u.route;
    if (!route || u.routeIdx >= route.length) return { vx: 0, vz: 0, speed: 0, done: true };

    if (!u.stuckAt) u.stuckAt = now;   // don't judge movement before the first step
    if (now - u.stuckAt > 2000) {
      const moved = Math.hypot(p.x - u.stuckX, p.z - u.stuckZ);
      if (moved < 15) {
        if (u.routeIdx < route.length - 1) {
          u.routeIdx++;
        } else {
          u.stuckN = (u.stuckN || 0) + 1;
          if (u.stuckN >= 3) {
            // hard-stuck at the final waypoint: snap onto it (A route ends on platform)
            const wp = route[route.length - 1];
            const ty = (wp[0] >= 240 && wp[1] >= -300 && wp[1] <= -60) ? 100 : 36;
            u.body.setTranslation({ x: wp[0], y: ty, z: wp[1] }, true);
            u.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
            u.stuckN = 0;
          }
        }
      } else {
        u.stuckN = 0;
      }
      u.stuckAt = now;
      u.stuckX = p.x;
      u.stuckZ = p.z;
    }

    const wp = route[u.routeIdx];
    const dx = wp[0] - p.x, dz = wp[1] - p.z;
    const d = Math.hypot(dx, dz);
    if (d < 28) {
      if (u.routeIdx < route.length - 1) {
        u.routeIdx++;
        return navRoute(e, p, spd, now);
      }
      return { vx: 0, vz: 0, speed: 0, done: true };
    }
    e.rotation.y = Math.atan2(dx, dz);
    return { vx: dx / d, vz: dz / d, speed: spd, done: false };
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
    ROUND.nextAt = ROUND.stateAt + 5000;   // 5s win banner, then reset

    const winner = won ? playerTeam : (playerTeam === 'T' ? 'CT' : 'T');
    const banner = winner === 'T' ? 'TERRORISTS WIN' : 'COUNTER-TERRORISTS WIN';

    // freeze every bot in place during the round-over banner
    for (const e of enemies) {
      e.userData.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    }

    if (won) {
      playerMoney += 1000;
      updateAmmoHUD();
      playBlip(660, 0.15, 0.2);
      delay(() => playBlip(880, 0.2, 0.2), 160);
    } else {
      playBlip(200, 0.3, 0.22);
    }
    showBanner(banner, 4600, won ? '#4dff88' : '#ff4d5e');
    keys.clear();
    updateRoundHUD();
  }

  function startRound(n) {
    ROUND.number = n;
    ROUND.state = 'active';
    ROUND.stateAt = performance.now();
    respawnPlayer();
    spawnRoundEnemies();
    clearGrenades();
    resetBomb();
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
  const scopeEl = document.getElementById('scope');
  const crosshairEl = document.getElementById('crosshair');

  // ---------------- AWP SCOPE (right-click) ----------------
  function setScoped(on) {
    const w = WEAPONS[weaponIndex];
    scoped = Boolean(on) && Boolean(w.zoomFov);
    camera.fov = scoped ? w.zoomFov : BASE_FOV;
    camera.updateProjectionMatrix();
    scopeEl.style.display = scoped ? 'block' : 'none';
    if (controls.isLocked) crosshairEl.style.display = scoped ? 'none' : 'block';
    gunRig.visible = controls.isLocked && !scoped;
  }

  function toggleZoom() {
    if (grenadeMode) return;  // no scope while holding a grenade
    const w = WEAPONS[weaponIndex];
    if (!w.zoomFov) return;   // only the AWP can zoom
    setScoped(!scoped);
    playBlip(scoped ? 700 : 500, 0.04, 0.12);
  }

  // keep the camera punch tracking consistent no matter what
  function applyViewPunch() {
    const delta = viewPunch - viewPunchApplied;
    if (delta !== 0) {
      camera.rotation.x += delta;
      viewPunchApplied += delta;
    }
  }

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
    crosshairEl.style.display = scoped ? 'none' : 'block';
    document.getElementById('hud').style.display = 'block';
    document.getElementById('roundHud').style.display = 'flex';
    document.getElementById('hpBox').style.display = 'block';
    ammoEl.style.display = 'block';
    gunRig.visible = !scoped;
  });
  controls.addEventListener('unlock', () => {
    if (scoped) setScoped(false);
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
    if (!controls.isLocked || buyMenuOpen) return;
    if (e.button === 0) {
      if (grenadeMode) throwGrenade();
      else shoot();
    } else if (e.button === 2) {
      toggleZoom();   // AWP scope
    }
  });
  window.addEventListener('contextmenu', e => e.preventDefault());

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
    if (e.code === 'Digit4') switchWeapon(3);
    if (e.code === 'Digit5') switchWeapon(4);
    if (e.code === 'Digit6') selectNade('smoke');
    if (e.code === 'Digit7') selectNade('flash');
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
  function updateEnemies(now, dt) {
    const pp = playerBody.translation();

    for (const e of enemies) {
      if (ROUND.state !== 'active') return;
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
      const enemyIsCT = playerTeam === 'T';                       // enemies are the opposite team
      const isDefuser = bomb.planted && enemyIsCT;                // CT bots rush the bomb
      const isPlanter = !bomb.planted && !enemyIsCT && e === bombCarrier; // T bot carries the bomb

      if (e.userData.hasLOS && dist < ENEMY.shootRange && sameHeight) {
        // ---- ATTACK: stop, face player, shoot on cooldown ----
        state = 'attack';
        e.userData.stuckN = 0;
        if (dist > 1) { vx = dx / dist; vz = dz / dist; }   // facing only
        e.rotation.y = Math.atan2(dx, dz);

        if (now >= e.userData.nextShotAt) {
          e.userData.nextShotAt = now + 900 + Math.random() * 700;
          fireEnemyShot(p);
        }
      } else if (isDefuser) {
        // ---- RUSH THE BOMB, THEN DEFUSE IT (hold 5s) ----
        state = 'defuse';
        const bx = bomb.x - p.x;
        const bz = bomb.z - p.z;
        const bd = Math.hypot(bx, bz);
        const feet = p.y - CAPSULE_HALF;
        if (bd < 40 && Math.abs(feet - bomb.y) < 40) {
          e.rotation.y = Math.atan2(bx, bz);
          e.userData.defuseProg = (e.userData.defuseProg || 0) + dt;
          if (e.userData.defuseProg >= 5) {
            e.userData.defuseProg = 0;
            endRound(false);   // CTs defused -> the T player loses
            return;
          }
        } else {
          e.userData.defuseProg = 0;
          const route = e.userData.route;
          const clear = clearPathTo(p.x, p.y + 20, p.z, bomb.x, bomb.y + 8, bomb.z);
          if (!clear && route && e.userData.routeIdx < route.length) {
            const nav = navRoute(e, p, ENEMY.chaseSpeed, now);
            vx = nav.vx; vz = nav.vz; speed = nav.speed;
          } else if (bd > 1e-3) {
            vx = bx / bd; vz = bz / bd;
            speed = ENEMY.chaseSpeed;
            e.rotation.y = Math.atan2(bx, bz);
          }
        }
      } else if (isPlanter) {
        // ---- CARRY THE BOMB TO A SITE, THEN PLANT IT (hold 3s) ----
        state = 'plant';
        const zone = zoneAt(p.x, p.y, p.z);
        if (zone) {
          e.userData.plantProg = (e.userData.plantProg || 0) + dt;
          if (e.userData.plantProg >= 3) {
            e.userData.plantProg = 0;
            plantBomb(p.x, p.y - CAPSULE_HALF, p.z, zone.site);
            state = 'patrol';
          }
        } else {
          e.userData.plantProg = 0;
          const nav = navRoute(e, p, ENEMY.chaseSpeed, now);
          if (nav.done) {
            // route finished but not in a zone -> walk at the site center
            const site = e.userData.targetSite || 'A';
            const zn = PLANT_ZONES.find(z => z.site === site) || PLANT_ZONES[0];
            const tx = (zn.x1 + zn.x2) / 2;
            const tz = (zn.z1 + zn.z2) / 2;
            const sdx = tx - p.x, sdz = tz - p.z;
            const sd = Math.hypot(sdx, sdz);
            if (sd > 1) {
              vx = sdx / sd; vz = sdz / sd;
              speed = ENEMY.chaseSpeed;
              e.rotation.y = Math.atan2(sdx, sdz);
            }
          } else {
            vx = nav.vx; vz = nav.vz; speed = nav.speed;
          }
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
    if (!buyMenuOpen && ROUND.state === 'active') updateEnemies(now, dt);
    updateTracers(dt);
    world.step();
    updateGrenades(dt, now);

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

    // ---- bomb: 40s timer + blinking C4 light ----
    if (bomb.planted && ROUND.state === 'active' && now - bomb.plantedAt >= BOMB_TIMER) {
      endRound(playerTeam === 'T');   // bomb explodes -> terrorists win
    }
    if (bomb.planted) {
      updateBombHUD();
      const left = BOMB_TIMER - (now - bomb.plantedAt);
      const iv = left < 10000 ? 150 : 400;   // panic blink in the last 10s
      c4Mesh.userData.light.material.color.setHex(
        Math.floor(now / iv) % 2 ? 0xff2020 : 0x440000
      );
    }

    // ---- bomb: hold E to plant / defuse (with HUD progress bar) ----
    let barText = '';
    let barPct = 0;
    if (ROUND.state === 'active') {
      const feet = p.y - CAPSULE_HALF;
      const zone = zoneAt(p.x, p.y, p.z);
      const nearBomb = bomb.planted &&
        Math.hypot(p.x - bomb.x, p.z - bomb.z) < 40 &&
        Math.abs(feet - bomb.y) < 40;
      const eHeld = keys.has('KeyE');

      if (playerTeam === 'T' && !bomb.planted && zone) {
        barText = eHeld ? 'PLANTING BOMB…' : 'HOLD [E] TO PLANT';
        if (eHeld) {
          plantProgress += dt * 1000;
          if (plantProgress >= PLANT_TIME) {
            plantProgress = 0;
            playerMoney += 300;   // +$300 for planting
            updateAmmoHUD();
            plantBomb(p.x, feet, p.z, zone.site);
          }
        } else {
          plantProgress = 0;
        }
        barPct = Math.min(1, plantProgress / PLANT_TIME);
      } else if (playerTeam === 'CT' && nearBomb) {
        barText = eHeld ? 'DEFUSING BOMB…' : 'HOLD [E] TO DEFUSE';
        if (eHeld) {
          defuseProgress += dt * 1000;
          if (defuseProgress >= DEFUSE_TIME) {
            defuseProgress = 0;
            playerMoney += 300;   // +$300 for defusing
            updateAmmoHUD();
            endRound(true);       // CT defused -> counter-terrorists win
          }
        } else {
          defuseProgress = 0;
        }
        barPct = Math.min(1, defuseProgress / DEFUSE_TIME);
      } else {
        plantProgress = 0;
        defuseProgress = 0;
      }
    } else {
      plantProgress = 0;
      defuseProgress = 0;
    }
    if (barText) {
      bombBarEl.style.display = 'block';
      bombBarLabelEl.textContent = barText;
      bombBarFillEl.style.width = (barPct * 100).toFixed(1) + '%';
    } else {
      bombBarEl.style.display = 'none';
    }

    // ---- flashbang white overlay (fades over 3s) ----
    if (now < flashOverlayUntil) {
      flashOverlayEl.style.opacity = String((flashOverlayUntil - now) / 3000);
    } else {
      flashOverlayEl.style.opacity = '0';
    }

    const hSpeed = Math.hypot(vel.x, vel.z);
    speedEl.textContent = hSpeed.toFixed(0);
    stateEl.textContent = isGrounded ? 'ON GROUND' : 'AIR';

    if (controls.isLocked && now - lastSpeedLog >= 250) {
      lastSpeedLog = now;
      console.log('[speed]', hSpeed.toFixed(1), 'ups',
        isGrounded ? '(ground)' : '(air)', 'state:', ROUND.state);
    }

    // ---- gun kick: backward + up, smooth lerp back to rest ----
    recoil += (0 - recoil) * Math.min(1, dt * 11);
    if (recoil < 0.001) recoil = 0;
    gunRig.position.z = GUN_BASE.z + recoil * 3;      // kicks backward
    gunRig.position.y = GUN_BASE.y + recoil * 1.2;    // and slightly up
    gunRig.rotation.x = recoil * 0.13;

    // ---- view punch: camera jumped up on fire, recover smoothly ----
    viewPunch += (0 - viewPunch) * Math.min(1, dt * 9);
    if (Math.abs(viewPunch) < 1e-5) viewPunch = 0;
    applyViewPunch();

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


