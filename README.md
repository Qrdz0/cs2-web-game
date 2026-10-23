# cs2-web-game

A browser-based tactical FPS prototype with authentic CS2/Source-engine movement mechanics — no install, no build step, just open a tab and play.

## Features

- **Source-engine movement** — exact Quake/Source friction, ground accelerate, and air-accelerate formulas, so counter-strafing and air-strafing feel like the real thing (250 ups run speed, 301 ups jump).
- **Round-based game loop** — CS2-style state machine: Warmup → Active → Round Over. Kill all 5 enemies to win the round and earn a $1000 bonus; die and the round is lost.
- **Economy + buy menu** — start with $800, earn kill rewards ($300 / $600 / $1500), and spend money in the buy menu (press `B`) on a Glock, MP5, or Deagle.
- **Enemy AI** — bots patrol waypoints, chase with random A/D strafing, and open fire with visible tracer rounds when they have line-of-sight; you get a red damage flash and a directional hit indicator.
- **Physics-driven world** — Rapier 3D colliders on every wall, crate, and ramp; the player and bots are dynamic capsules.
- **Atmosphere** — procedural sand/concrete/wood textures, gradient skybox, fog, and a shadowed sun over a T Spawn → Mid → A Site map.

## Tech Stack

- **Three.js 0.160** — rendering, composite gun viewmodels, procedural canvas textures
- **Rapier 3D** (`@dimforge/rapier3d-compat` 0.12) — WebGL physics (collisions, capsules, raycasts)
- **PointerLockControls** — mouse look
- **Vanilla JS ES modules** — no framework, no bundler; Three.js and Rapier load via CDN importmap
- **Web Audio API** — synthesized gunshot/hit sounds (zero audio assets)

## How to run it locally

The game is fully static — serve the folder with any local web server (ES modules don't work over `file://`):

```bash
npx serve -l 8000 .
```

or with Python:

```bash
python -m http.server 8000
```

Then open **http://localhost:8000** and click to play.

**Controls:** `WASD` move · `Space` jump · `LMB` shoot · `R` reload · `1/2/3` switch weapon · `B` buy menu · `A/D + mouse` air-strafe · `Esc` release mouse

---

Built by [Qrdz0](https://github.com/Qrdz0). I vibecode for fun, but I always try to learn a bit.
