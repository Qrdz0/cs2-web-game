// cs2-web-game — Phase 3: Map Blockout, Weapon System, Economy
// Three.js (rendering) + Rapier (collisions) via CDN importmap.
//
// Physics model:
//   - floor / walls / crates / ramps : FIXED rigid bodies (one per mesh)
//   - player                         : DYNAMIC capsule, rotations locked, CCD
//   - gravity                        : Rapier applies it (sv_gravity 800)
//   - ground detection               : 0.3u downward ray from below the feet
//   - movement                       : Source friction/accelerate on ground,
//                                      exact Quake/Source air-accelerate in air
//
// Phase 3 (this file):
//   - structured map: T Spawn -> Mid -> A Site, corridors, cover, a ramp
//   - weapon system: Glock / MP5 / Deagle (keys 1-2-3, per-weapon ammo)
//   - economy: $800 start, kill rewards, money HUD

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
};

// ================================================================
// WEAPON SYSTEM
// ================================================================
const WEAPONS = [
  { name: 'Glock',  damage: 26, fireRate: 170, magSize: 20, killReward: 300,  color: 0x3a4048, scale: 0.80 },
  { name: 'MP5',    damage: 28, fireRate: 90,  magSize: 30, killReward: 600,  color: 0x2f3540, scale: 1.00 },
  { name: 'Deagle', damage: 60, fireRate: 500, magSize: 7,  killReward: 1500, color: 0x9aa1ac, scale: 0.88 },
];
const ENEMY_HP = 100;

// ================================================================
// ECONOMY
// ================================================================
let playerMoney = 800;

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

function playShotSound() {
  const ctx = getAudio();
  if (!ctx) return;
  const t = ctx.currentTime;
  // white-noise burst with fast decay = gunshot body
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
  gain.gain.setValueAtTime(0.5, t);
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
  scene.background = new THREE.Color(0x131922);
  scene.fog = new THREE.Fog(0x131922, 1100, 2800);

  const camera = new THREE.PerspectiveCamera(
    90, window.innerWidth / window.innerHeight, 0.1, 3000
  );
  scene.add(camera);   // required so camera children (gun viewmodel) render

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);

  // ---------------- lighting (bright map visibility) ----------------
  scene.add(new THREE.AmbientLight(0xffffff, 1.1));
  const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
  sun.position.set(500, 800, 300);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const S = 650;
  sun.shadow.camera.left = -S; sun.shadow.camera.right = S;
  sun.shadow.camera.top = S; sun.shadow.camera.bottom = -S;
  sun.shadow.camera.far = 2500;
  scene.add(sun);

  // ---------------- physics world ----------------
  const world = new RAPIER.World({ x: 0, y: -MOVEMENT.gravity, z: 0 });

  // everything a bullet can hit (floor, walls, crates, ramp, enemies)
  const shootables = [];

  // ---------------- materials & textures ----------------
  const concreteTex = makeConcreteTexture();
  concreteTex.repeat.set(9, 10);                 // tiling over the big floor
  const floorMat = new THREE.MeshStandardMaterial({ map: concreteTex, roughness: 1 });
  const wallMat = new THREE.MeshStandardMaterial({ map: makeSandTexture(), roughness: 0.95 });
  const crateMat = new THREE.MeshStandardMaterial({ map: makeWoodTexture(), roughness: 0.85 });

  // ---------------- map helpers (every mesh gets a FIXED collider) -----
  const BOX = (x, y, z, w, h, d, type = 'wall') => {
    const mat = type === 'crate' ? crateMat : type === 'concrete' ? floorMat : wallMat;
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

  const RAMP = (x, y, z, w, h, d, rotX, type = 'concrete') => {
    const mat = type === 'concrete' ? floorMat : wallMat;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    mesh.rotation.x = rotX;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    shootables.push(mesh);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rotX, 0, 0));
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(x, y, z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
    );
    world.createCollider(RAPIER.ColliderDesc.cuboid(w / 2, h / 2, d / 2), body);
    return mesh;
  };

  // visual-only zone marker (no collider)
  const MARK = (x, y, z, w, d, color) => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, 1, d),
      new THREE.MeshStandardMaterial({ color, roughness: 1 })
    );
    mesh.position.set(x, y, z);
    mesh.receiveShadow = true;
    scene.add(mesh);
    return mesh;
  };

  // ================================================================
  // MAP BLOCKOUT — T Spawn -> Mid -> A Site   (x: -350..350, z: -400..400)
  // ================================================================

  // floor: 700 x 800 concrete slab, top surface exactly at y = 0
  BOX(0, -2, 0, 700, 4, 800, 'concrete');

  // ---- perimeter (height 128) ----
  BOX(0, 64, -400, 716, 128, 16, 'wall');    // north
  BOX(0, 64, 400, 716, 128, 16, 'wall');     // south
  BOX(-350, 64, 0, 16, 128, 800, 'wall');    // west
  BOX(350, 64, 0, 16, 128, 800, 'wall');     // east

  // ---- T Spawn (south, z 240..400) — exit north into Mid / A-short ----
  // divider at z = 240 with two gaps: Mid [-70,70], A-short [180,260]
  BOX(-210, 48, 240, 280, 96, 16, 'wall');   // x -350..-70
  BOX(125, 48, 240, 110, 96, 16, 'wall');    // x 70..180
  BOX(305, 48, 240, 90, 96, 16, 'wall');     // x 260..350

  // ---- Mid (lane x -70..70, z -90..240) ----
  BOX(-70, 48, 75, 16, 96, 330, 'wall');     // west lane wall
  BOX(70, 48, 75, 16, 96, 330, 'wall');      // east lane wall
  BOX(0, 20, 40, 64, 40, 16, 'wall');        // low cover (jumpable, h40)

  // ---- west area (x -350..-78) — extra divider for cover ----
  BOX(-220, 48, -20, 16, 96, 160, 'wall');

  // ---- A Site (north-east, platform 64u high) ----
  BOX(215, 32, -310, 250, 64, 160, 'concrete');           // platform x90..340 z-390..-230
  // ramp: floor (z=-90, y=0) up to platform top (z=-230, y=64), run 140
  RAMP(175, 21, -165, 130, 24, 154, 0.4289, 'concrete');

  // ---- wooden crates (cover + boosts) ----
  BOX(-200, 32, 300, 64, 64, 64, 'crate');    // T spawn stack
  BOX(-200, 96, 300, 64, 64, 64, 'crate');
  BOX(200, 32, 320, 64, 64, 64, 'crate');     // T spawn
  BOX(300, 32, 100, 64, 64, 64, 'crate');     // A-short lane
  BOX(-100, 32, -160, 64, 64, 64, 'crate');   // mid-top
  BOX(150, 96, -320, 64, 64, 64, 'crate');    // A site stack (on platform)
  BOX(214, 96, -320, 64, 64, 64, 'crate');
  BOX(150, 160, -320, 64, 64, 64, 'crate');

  // ---- zone markers (visual only) ----
  MARK(0, 0.5, 320, 500, 130, 0x8a6f4a);      // T Spawn floor paint
  MARK(215, 64.5, -310, 180, 120, 0xa8324a);  // A Site floor paint

  // ================================================================
  // ENEMIES — red capsule dummies, 100 HP each
  // ================================================================
  const enemies = [];
  function spawnEnemy(x, y, z) {
    const mesh = new THREE.Mesh(
      // radius 16 + cylinder 40 = 72 total — same hull size as the player
      new THREE.CapsuleGeometry(16, 40, 4, 14),
      new THREE.MeshStandardMaterial({
        color: 0xc41e3a,
        roughness: 0.6,
        emissive: 0x000000,
      })
    );
    mesh.position.set(x, y, z);                // y = floorTop + 36
    mesh.rotation.y = Math.random() * Math.PI * 2;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData = {
      enemy: true,
      hp: ENEMY_HP,
      flashUntil: 0,
    };
    scene.add(mesh);
    enemies.push(mesh);
    shootables.push(mesh);
    return mesh;
  }
  spawnEnemy(0, 36, 0);                        // Mid
  spawnEnemy(-240, 36, 120);                   // west area
  spawnEnemy(215, 100, -320);                  // A Site (on platform: 64 + 36)

  // ================================================================
  // player — DYNAMIC capsule (T Spawn, feet 5 above floor -> lands)
  // ================================================================
  const CAPSULE_HALF = PLAYER.halfHeight + PLAYER.radius; // 36 = center -> feet
  const SPAWN_Y = CAPSULE_HALF + 5;
  const playerBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, SPAWN_Y, 350)
      .setCcdEnabled(true)
  );
  playerBody.lockRotations(true);           // never tips over

  const playerCollider = world.createCollider(
    RAPIER.ColliderDesc.capsule(PLAYER.halfHeight, PLAYER.radius)
      .setFriction(0)                       // engine friction off — we do CS friction ourselves
      .setRestitution(0),
    playerBody
  );

  const controls = new PointerLockControls(camera, renderer.domElement);

  // ================================================================
  // GUN VIEWMODEL — primitive boxes parented to the camera
  // ================================================================
  const gun = new THREE.Group();
  const GUN_BASE = new THREE.Vector3(6.5, -7.5, -14);   // bottom-right of screen
  gun.position.copy(GUN_BASE);

  const gunTintParts = [];   // parts recolored per weapon

  const part = (w, h, d, x, y, z, color, metal = 0.6, rough = 0.5, tint = false) => {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshStandardMaterial({ color, metalness: metal, roughness: rough })
    );
    m.position.set(x, y, z);
    gun.add(m);
    if (tint) gunTintParts.push(m);
    return m;
  };

  part(2.4, 3, 11, 0, 0, 0, 0x3a4048, 0.6, 0.5, true);   // receiver (tint)
  part(2.45, 0.5, 4, 0, 1.2, 0, 0xe11d48, 0.4, 0.4);     // red accent stripe
  part(1.3, 1.3, 8, 0, 0.9, -8, 0x1a1d22);               // barrel
  part(1.9, 4.2, 2.6, 0, -3.2, 3.4, 0x23262b, 0.6, 0.5, true); // grip (tint)
  part(1.7, 4.6, 2.2, 0, -3.6, -0.5, 0x1a1d22, 0.6, 0.5, true); // magazine (tint)
  part(0.5, 1.2, 1, 0, 2, -1, 0x1a1d22);                 // rear sight
  part(0.4, 1, 0.6, 0, 1.8, -9.5, 0x1a1d22);             // front sight

  // muzzle flash: small emissive sphere + point light
  const flashMesh = new THREE.Mesh(
    new THREE.SphereGeometry(1.5, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0xfff2cc })
  );
  flashMesh.position.set(0, 0.9, -12.4);
  flashMesh.visible = false;
  gun.add(flashMesh);

  const muzzleLight = new THREE.PointLight(0xffcc88, 0, 80, 2);
  muzzleLight.position.set(0, 0.9, -13);
  gun.add(muzzleLight);

  camera.add(gun);
  gun.visible = false;   // hidden until pointer lock (shown on 'lock')

  // ================================================================
  // COMBAT + ECONOMY STATE
  // ================================================================
  let weaponIndex = 0;
  const ammo = WEAPONS.map(w => ({ mag: w.magSize, reserve: w.magSize * 3 }));
  let lastShotAt = 0;
  let recoil = 0;                 // 0..1, decays each frame
  let flashUntil = 0;
  let hitmarkerUntil = 0;

  const raycaster = new THREE.Raycaster();
  const SCREEN_CENTER = new THREE.Vector2(0, 0);

  const ammoEl = document.getElementById('ammo');
  const ammoMagEl = document.getElementById('ammoMag');
  const ammoResEl = document.getElementById('ammoRes');
  const moneyEl = document.getElementById('money');
  const weaponNameEl = document.getElementById('weaponName');
  const hitmarkerEl = document.getElementById('hitmarker');

  function updateAmmoHUD() {
    const w = WEAPONS[weaponIndex];
    const a = ammo[weaponIndex];
    ammoMagEl.textContent = a.mag;
    ammoResEl.textContent = '/ ' + a.reserve;
    moneyEl.textContent = '$' + playerMoney;
    weaponNameEl.textContent = w.name;
    ammoEl.classList.toggle('low', a.mag <= Math.max(2, Math.floor(w.magSize * 0.3)));
  }

  function switchWeapon(i) {
    if (i < 0 || i >= WEAPONS.length || i === weaponIndex) return;
    weaponIndex = i;
    const w = WEAPONS[i];
    gun.scale.setScalar(w.scale);                    // size per weapon
    for (const m of gunTintParts) {
      m.material.color.setHex(w.color);              // color per weapon
    }
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
    const i = enemies.indexOf(mesh);
    if (i >= 0) enemies.splice(i, 1);
    const j = shootables.indexOf(mesh);
    if (j >= 0) shootables.splice(j, 1);
    mesh.geometry.dispose();
    mesh.material.dispose();
    // economy: kill reward of the weapon that got the kill
    playerMoney += weapon.killReward;
    console.log('[combat] killed with', weapon.name, '-> +$' + weapon.killReward,
                '(total $' + playerMoney + ')');
  }

  function shoot() {
    const w = WEAPONS[weaponIndex];
    const a = ammo[weaponIndex];
    const now = performance.now();
    if (now - lastShotAt < w.fireRate) return;
    lastShotAt = now;

    if (a.mag <= 0) {
      playBlip(500, 0.04, 0.12);            // dry click
      return;
    }
    a.mag--;

    // raycast from screen center — only against map + enemies
    raycaster.setFromCamera(SCREEN_CENTER, camera);
    const hits = raycaster.intersectObjects(shootables, false);

    if (hits.length > 0) {
      const hit = hits[0];                  // closest thing in front of the muzzle
      if (hit.object.userData.enemy) {
        const e = hit.object;
        e.userData.hp -= w.damage;
        e.userData.flashUntil = now + 90;   // red hit flash
        hitmarkerUntil = now + 130;         // show hitmarker
        playBlip(1200, 0.05, 0.22);         // hit tick
        if (e.userData.hp <= 0) killEnemy(e, w);
      }
    }

    updateAmmoHUD();

    // feedback: recoil + muzzle flash + sound
    recoil = 1;
    flashUntil = now + 45;
    muzzleLight.intensity = 50;
    playShotSound();
  }

  // apply starting weapon (index 0 = Glock)
  gun.scale.setScalar(WEAPONS[0].scale);
  for (const m of gunTintParts) m.material.color.setHex(WEAPONS[0].color);
  updateAmmoHUD();

  // ================================================================
  // per-frame player state (movement — unchanged from Phase 1/2)
  // ================================================================
  const vel = new THREE.Vector3();
  let isGrounded = false;
  let jumpQueued = false;

  const overlay = document.getElementById('overlay');
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsModal = document.getElementById('settingsModal');

  overlay.addEventListener('click', () => controls.lock());
  controls.addEventListener('lock', () => {
    overlay.style.display = 'none';
    settingsBtn.style.display = 'none';   // no cursor while locked anyway
    document.getElementById('crosshair').style.display = 'block';
    document.getElementById('hud').style.display = 'block';
    ammoEl.style.display = 'block';
    gun.visible = true;
  });
  controls.addEventListener('unlock', () => {
    overlay.style.display = 'flex';
    settingsBtn.style.display = 'flex';
    document.getElementById('crosshair').style.display = 'none';
    document.getElementById('hud').style.display = 'none';
    ammoEl.style.display = 'none';
    gun.visible = false;
    keys.clear();
    jumpQueued = false;
  });

  // shooting — LEFT MOUSE, only while pointer is locked (so UI/settings
  // clicks can never fire a bullet)
  window.addEventListener('mousedown', e => {
    if (e.button !== 0 || !controls.isLocked) return;
    shoot();
  });

  // ---------------- input (window-level: live the moment you click) ----------------
  const keys = new Set();
  window.addEventListener('keydown', e => {
    if (!controls.isLocked) {
      // Esc closes the settings modal when playing is paused
      if (e.code === 'Escape') settingsModal.classList.remove('open');
      return;
    }
    keys.add(e.code);
    // weapon switch: 1 / 2 / 3
    if (e.code === 'Digit1') switchWeapon(0);
    if (e.code === 'Digit2') switchWeapon(1);
    if (e.code === 'Digit3') switchWeapon(2);
    // reload
    if (e.code === 'KeyR' && !e.repeat) reload();
    // jump: Spacebar bind (Space is prevented from scrolling either way)
    if (e.code === 'Space') {
      e.preventDefault();
      if (settings.jumpBind === 'space' && !e.repeat) jumpQueued = true;
    }
    if (['ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
  });
  window.addEventListener('keyup', e => keys.delete(e.code));

  // jump: Mouse Wheel Down bind — each wheel notch = one jump press
  window.addEventListener('wheel', e => {
    if (!controls.isLocked || settings.jumpBind !== 'wheel') return;
    if (e.deltaY > 0) jumpQueued = true;   // deltaY > 0 = scroll down
  }, { passive: true });

  // ================================================================
  // SETTINGS UI
  // ================================================================
  settingsBtn.addEventListener('click', e => {
    e.stopPropagation();
    settingsModal.classList.add('open');
  });
  document.getElementById('settingsClose')
    .addEventListener('click', () => settingsModal.classList.remove('open'));
  // click on the dark backdrop (not the panel) closes
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
  // GROUND CHECK — ray straight down from just below the feet.
  // Origin is 0.1 below the capsule bottom (outside our own collider),
  // so it can only hit world geometry. Hit within 0.3u => grounded.
  // ================================================================
  function checkGrounded() {
    const p = playerBody.translation();
    const feet = p.y - CAPSULE_HALF;
    const ray = new RAPIER.Ray(
      { x: p.x, y: feet - 0.1, z: p.z },
      { x: 0, y: -1, z: 0 }
    );
    const hit = world.castRay(ray, 0.3, true);
    return Boolean(hit);
  }

  // ================================================================
  // Source ground math (Quake/Source friction + accelerate)
  // ================================================================

  // clamp addspeed, scale by accel * wishspeed — used on the ground
  function accelerate(v, wishDir, wishSpeed, accel, dt) {
    const currentSpeed = v.x * wishDir.x + v.z * wishDir.z;
    const addSpeed = wishSpeed - currentSpeed;
    if (addSpeed <= 0) return;
    let accelSpeed = accel * wishSpeed * dt;
    if (accelSpeed > addSpeed) accelSpeed = addSpeed;
    v.x += accelSpeed * wishDir.x;
    v.z += accelSpeed * wishDir.z;
  }

  // Source friction — GROUNDED ONLY
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

  // ================================================================
  // AIR ACCELERATION — exact Quake/Source engine formula
  //
  // This is the PM_AirMove / PM_Accelerate logic from the Source /
  // Quake engine, verbatim — no angle gate, no extra conditions:
  //
  //   1. wishdir   = normalized 2D (x/z) direction from WASD,
  //                  rotated by the camera YAW only (pitch ignored)
  //   2. wishspeed = 30 (sv_air_max_wishspeed)
  //   3. current_speed = dot(velocity, wishdir)
  //   4. add_speed = wishspeed - current_speed
  //   5. if add_speed > 0:
  //          accelspeed = air_acceleration * wishspeed * delta
  //          accelspeed = min(accelspeed, add_speed)
  //          velocity  += wishdir * accelspeed
  //
  // Why this gains speed when strafing: turning the mouse rotates
  // wishdir away from the velocity vector, which LOWERS
  // current_speed (the dot product), which makes add_speed > 0 and
  // lets the engine inject velocity sideways. The sideways impulse
  // grows |velocity| a little every tick (|v+Δ| > |v|). Holding W
  // and looking forward keeps wishdir aligned with velocity,
  // current_speed ~= |v| (>> 30), add_speed < 0 -> NOTHING happens.
  // ================================================================
  function airAccelerate(v, wishX, wishZ, dt) {
    // 1) wishdir: 2D, built from camera yaw (see updateMovement)
    //    (wishX/wishZ arrive already normalized)

    // 2) wishspeed = max air speed
    const wishspeed = MOVEMENT.airCap;

    // 3) current_speed = dot(velocity, wishdir)  (wishdir.y = 0)
    const currentSpeed = v.x * wishX + v.z * wishZ;

    // 4) add_speed = wishspeed - current_speed
    const addSpeed = wishspeed - currentSpeed;

    // 5) apply acceleration if there is room
    if (addSpeed > 0) {
      let accelSpeed = MOVEMENT.airAccelerate * wishspeed * dt;
      if (accelSpeed > addSpeed) accelSpeed = addSpeed;   // clamp to add_speed
      v.x += accelSpeed * wishX;
      v.z += accelSpeed * wishZ;
    }
  }

  function updateMovement(dt) {
    // 1) raycast ground state FIRST
    isGrounded = checkGrounded();

    // 2) start from the velocity the engine produced last step
    //    (so wall hits / bumps affect us naturally)
    const lv = playerBody.linvel();
    vel.set(lv.x, lv.y, lv.z);

    // 3) wish direction from WASD — built from CAMERA YAW explicitly,
    //    so mouse movement (yaw) always rotates wishdir correctly.
    //    Pitch is ignored (movement stays horizontal) and a straight
    //    up/down view can never produce a NaN direction.
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    const yaw = Math.atan2(-dir.x, -dir.z);   // camera yaw on Y axis
    const sinY = Math.sin(yaw);
    const cosY = Math.cos(yaw);
    // forward = (-sin(yaw), 0, -cos(yaw))   right = (cos(yaw), 0, -sin(yaw))
    let wx = 0, wz = 0;
    if (keys.has('KeyW')) { wx += -sinY; wz += -cosY; }
    if (keys.has('KeyS')) { wx -= -sinY; wz -= -cosY; }
    if (keys.has('KeyD')) { wx +=  cosY; wz -=  sinY; }
    if (keys.has('KeyA')) { wx -=  cosY; wz -= -sinY; }

    // normalize the 2D wish vector
    const wishLen = Math.hypot(wx, wz);
    if (wishLen > 1e-9) { wx /= wishLen; wz /= wishLen; }
    const moving = wishLen > 1e-9;

    // 4) GROUND vs AIR
    if (isGrounded) {
      applyFriction(vel, dt);                       // friction (grounded only)
      if (moving) {
        accelerate(vel, { x: wx, z: wz }, MOVEMENT.maxSpeed, MOVEMENT.accelerate, dt);
      }
      if (jumpQueued) {
        vel.y = MOVEMENT.jumpVelocity;              // jump
      } else if (vel.y < 0) {
        vel.y = 0;                                  // cancel resting downward speed
      }
    } else if (
      (keys.has('KeyA') || keys.has('KeyD')) &&     // strafe keys only:
      moving                                         // W alone gains NOTHING
    ) {
      airAccelerate(vel, wx, wz, dt);               // exact Source air formula
    }
    jumpQueued = false;

    // 5) write velocity back (gravity is applied by Rapier itself)
    playerBody.setLinvel({ x: vel.x, y: vel.y, z: vel.z }, true);
  }

  // ---------------- HUD ----------------
  const speedEl = document.getElementById('speed');
  const stateEl = document.getElementById('state');

  // ---------------- speed debug log (throttled to 4x/sec) ----------------
  let lastSpeedLog = 0;

  // ---------------- main loop ----------------
  const clock = new THREE.Clock();

  function frame() {
    requestAnimationFrame(frame);
    let dt = Math.min(clock.getDelta(), 0.05);   // clamp lag spikes
    if (dt <= 0) dt = 1 / 120;

    if (controls.isLocked) updateMovement(dt);
    world.step();

    // camera glued to the physics body (feet + eye height)
    const p = playerBody.translation();
    camera.position.set(
      p.x,
      p.y - CAPSULE_HALF + PLAYER.eyeHeight,
      p.z
    );

    const hSpeed = Math.hypot(vel.x, vel.z);
    speedEl.textContent = hSpeed.toFixed(0);
    stateEl.textContent = isGrounded ? 'ON GROUND' : 'AIR';

    // console: current player speed (so strafe gains are visible)
    const now = performance.now();
    if (controls.isLocked && now - lastSpeedLog >= 250) {
      lastSpeedLog = now;
      console.log(
        '[speed]', hSpeed.toFixed(1), 'ups',
        isGrounded ? '(ground)' : '(air)',
        'vy:', vel.y.toFixed(1)
      );
    }

    // ---------------- combat visuals ----------------
    // recoil: kick back (+z) and pitch up, then ease home
    if (recoil > 0) recoil = Math.max(0, recoil - dt * 7);
    gun.position.z = GUN_BASE.z + recoil * 3;
    gun.rotation.x = recoil * 0.12;

    // muzzle flash
    muzzleLight.intensity = Math.max(0, muzzleLight.intensity - dt * 600);
    flashMesh.visible = now < flashUntil;

    // hitmarker (130 ms)
    hitmarkerEl.style.display = now < hitmarkerUntil ? 'block' : 'none';

    // enemy hit flash
    for (const e of enemies) {
      e.material.emissive.setHex(now < e.userData.flashUntil ? 0x772211 : 0x000000);
    }

    renderer.render(scene, camera);
  }

  addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  document.getElementById('loading').style.display = 'none';
  document.getElementById('play').style.display = 'block';
  frame();
}

// ================================================================
// Procedural textures (grey concrete / sandy walls / wooden crates)
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
  // darker splotches
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
  // block courses (sandy stone walls)
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
  // planks
  g.strokeStyle = '#744f2c';
  g.lineWidth = 4;
  for (let x = 0; x <= 256; x += 64) {
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 256); g.stroke();
  }
  // grain
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
