# Voxel Sandbox — Design Document

Three.js WebGPU voxel game. Fully destructible world — terrain, structures, vehicles, player. Structural physics, cellular-automata water, lockstep co-op multiplayer. First scene: suburban block (houses, cars, streets, pools).

## 1. Locked Decisions (from design interview, 2026-07-02)

| Axis | Decision | Rationale |
|---|---|---|
| Voxel size | 10 cm (Teardown-scale) | Fine destruction, realistic read |
| World | Fixed arena ~100×100×50 m, fully loaded | No streaming complexity; combat-arena sized |
| Rendering | Greedy-meshed chunks | Plays nice with three.js pipeline, shadows, materials |
| Destruction | Full structural — disconnected islands become rigid bodies | The core fantasy |
| Physics engine | Jolt (WASM) | AAA-grade, deterministic mode, character controller included |
| Water | Cellular automata, integer state, GPU compute | Correct behavior (drains, floods, fills craters); deterministic |
| Materials | Byte-packed ID → table: strength, density, flags (flammable, floats, transparent) | ~16 materials; drives destruction feel |
| Player | Voxel body, losable parts; FP/TP camera toggle | Destructibility "terrain to player" |
| Gameplay | Sandbox first; combat shape decided after playtest | De-risk design |
| Tools (day 1) | Dig (sphere remove), gun (raycast), explosives, builder (place) | Full edit-pipeline coverage |
| Style | Teardown-ish: realistic lighting on voxel geometry, AAA aspiration — real PBR texture sets (CC0: ambientcg.com, freepbr.com) via triplanar mapping, physical sky/fog/AO/AA post stack | Lighting sells the tech |
| Platform | Desktop Chrome, WebGPU only, 60 fps on mid-range dGPU / Apple Silicon | TSL compute is load-bearing; no WebGL fallback |
| Multiplayer | Co-op 2–4, deterministic lockstep, WebRTC P2P (one peer hosts) | Tiny bandwidth; voxel edits and physics come "free" |
| Authoring | Procedural layout (streets/lots/terrain) + MagicaVoxel `.vox` props (houses/cars) | Art-directable without editor scope |

## 2. Architecture

### 2.1 The determinism split (multiplayer corner-avoidance)

Lockstep means every client simulates identically from the same command stream. This splits the engine in two:

**Authoritative sim (deterministic, fixed tick, 60 Hz):**
- Voxel world state + edit application
- Water CA (integer-only, GPU compute — see 2.5)
- Jolt physics (fixed timestep, deterministic mode, single-threaded WASM — same binary everywhere ⇒ same results)
- Connectivity analysis / island extraction (CPU worker, deterministic order)
- Seeded PRNG; all randomness flows from it

**Render layer (non-deterministic allowed):**
- Chunk meshing, voxel AO
- Debris/dust particles, decals, screen effects
- Interpolation between sim ticks
- All lighting/post

**Day-one rules (cheap now, impossible to retrofit):**
1. All world mutations flow through a single command stream: `(tick, playerId, seq, op)`. No system pokes voxel buffers directly.
2. Fixed sim tick decoupled from render; render interpolates.
3. `Math.random`, `Date.now`, wall-clock: banned in sim code. Seeded PRNG only.
4. Sim state is serializable and hashable — enables drift detection and late-join snapshots.
5. GPU may run authoritative sims **only** if integer-math, gather-only (ping-pong), fixed dispatch — floats on GPU are not cross-vendor deterministic.
6. Entity IDs allocated deterministically (counter in sim state, not UUIDs).

Singleplayer runs the same loop with a local command queue. Multiplayer = swap the queue for a networked one.

### 2.2 Voxel data

- 1 byte per voxel = material ID (0 = air). Material table holds color ramp, strength, density, flags.
- Chunks: 32³ voxels (3.2 m cube) = 32 KB dense. Arena ≈ 32×32×16 = ~16k chunk slots.
- Sparse storage: chunks are `empty | uniform(material) | dense(buffer)`. Ground interior stays `uniform` until first edit realizes it. Keeps memory in the hundreds of MB → tens of MB range.
- Authoritative copy lives CPU-side (typed arrays, transferable to workers). GPU-side mirror for rendering/water sampling, updated on dirty.

### 2.3 Edit → mesh → physics pipeline

```
command (dig/place/explode)
  → stamp voxels, mark dirty chunks           [sim, deterministic]
  → connectivity flood-fill on affected region [sim worker, deterministic]
  → disconnected island? extract voxels →
      new dynamic body: own mini voxel grid
      + Jolt compound collider (greedy-merged boxes)
      + impulse from source (explosion)        [sim]
  → remesh dirty chunks (greedy + voxel AO)    [render workers, async, non-deterministic OK]
```

- Dynamic bodies render as their own meshes, transform driven by Jolt. They collide, tumble, can be damaged further (edits in body-local space).
- Bodies stay dynamic after settling (Teardown model — simpler than re-welding).
- Remesh budget per frame; big explosions amortize over a few frames (visual-only latency, sim is already correct).

### 2.4 Rendering

- three.js `WebGPURenderer` + TSL node materials.
- Greedy meshing in CPU workers first (simple, debuggable); migrate to TSL compute if profiling demands.
- Per-vertex voxel AO computed in the mesher (classic 4-neighbor corner trick) — biggest visual win per effort.
- Directional sun + cascaded shadow maps, PBR-ish material params from the material table, bloom. Water shading via TSL (refraction, absorption by depth).

### 2.5 Water (cellular automata)

- Separate GPU buffer: water level 0–255 (integer) per cell, aligned to voxel grid.
- Ping-pong double buffer, gather-only kernel: each cell reads neighbors' previous state, writes own next state. Pairwise-symmetric flow rules for mass conservation. No atomics, no floats ⇒ deterministic across GPU vendors (validate early — see risks).
- Solids block flow (samples voxel occupancy mirror). Breaking a pool wall just works.
- Buoyancy: read back water field (deterministic state, so one-tick-delayed readback is still deterministic), apply forces to Jolt bodies with `floats` material flag. Wood debris floats in the pool.
- Render: surface mesh extracted from water field (marching or column tops), TSL water material.

### 2.6 Player

- Locomotion: Jolt character controller (capsule), deterministic, driven by input commands.
- Body: segmented voxel rig — head/torso/upper+lower arms/legs, each a small voxel grid parented to a bone. Damage removes voxels in the hit segment; segment destroyed → gameplay effect (lose arm → drop weapon, lose leg → crawl). Capsule stays for movement; voxel body is the damage + visual model.
- FP camera for aiming, TP toggle to see your body take damage. TP camera needs collision vs destructible world (sphere-cast).

### 2.7 Multiplayer (co-op 2–4, lockstep, WebRTC)

- One peer hosts the session; tiny signaling server (static host + WS) for WebRTC handshake only.
- Per tick, each client sends its input commands; sim advances when all commands for tick N have arrived (small input delay buffer, ~2–3 ticks, hides typical co-op latency).
- Periodic state hash exchange → drift detection (desync = loud error, not silent divergence).
- Late join / rejoin: host serializes sim state (sparse chunks compress well — RLE), transfers snapshot, joiner fast-forwards buffered ticks.
- Not required for M0–M4, but rules in 2.1 are enforced from M0 so this bolts on without rewrite.

### 2.8 Content pipeline

- Procedural layout: street grid, lots, terrain heightfield, pool placement — parameters + seed.
- `.vox` (MagicaVoxel) import for houses, cars, props; stamped into world at load with material remapping.
- Scene = layout params + prop placements, replayable deterministically from seed (doubles as MP map sync).

## 3. Milestones

| M | Name | Contents | Exit criteria |
|---|---|---|---|
| M0 | Skeleton | Vite + TS + three.js WebGPU; fixed-tick loop; command stream; seeded PRNG; chunk store; flat ground; fly cam | Ground renders; dig command carves a hole; sim tick hashable |
| M1 | World + edit | Greedy mesh workers + voxel AO; material table; dig/build/gun tools; `.vox` import; proc suburb v0; FP camera + walk (capsule) | Walk a suburban block, dig pools, shoot holes in a house, 60 fps |
| M2 | Structure ⚠ riskiest | Connectivity flood-fill; island extraction; Jolt integration; explosives; debris particles | Blow out house corner → roof section tumbles as rigid body |
| M3 | Water | CA sim; pools in authoring; surface render; buoyancy | Break pool wall → water floods lawn; wood floats |
| M4 | Player body | Segmented voxel body; damage model; TP camera; ragdoll on death | Lose an arm visibly; TP camera works in rubble |
| M5 | Multiplayer | WebRTC signaling; lockstep transport; state hash; join snapshot | 2 clients, synced destruction, desync detector green for 30 min |
| M6 | Combat | Shape decided from sandbox playtest (wave defense / FPS / physics-weapons) | TBD after M4 playtest |

Determinism spikes pulled early (they're cheap and de-risk M5):
- **M0:** sim-hash harness exists from the first commit.
- **M2:** verify Jolt WASM determinism — same input log twice ⇒ identical hashes.
- **M3:** verify water CA cross-GPU — same log on NVIDIA + Apple Silicon ⇒ identical hashes.

## 4. Risks

| Risk | Mitigation |
|---|---|
| Jolt WASM nondeterminism (threading, SIMD) | Deterministic mode, single-threaded; spike test in M2; fallback = physics on host + body snapshot sync (drop pure lockstep for bodies only) |
| GPU CA nondeterminism on some vendor | Integer-only gather kernels; hash-validate on 2 GPUs in M3; fallback = CPU worker CA (slower, still fine at pool scale) |
| Remesh storms after big explosions | Per-frame remesh budget, prioritize near-camera chunks |
| Connectivity flood-fill cost on huge islands | Region-limited incremental fill; chunk-graph coarse pass before voxel-fine pass |
| Voxel skinning/animation for player body | Segments are rigid per-bone (no smooth skinning) — deliberate style choice |
| Scope | Combat undefined until M4 playtest; streaming, fire sim, editor: explicitly out of scope v1 |

## 5. Out of scope (v1)

Streaming/open world, WebGL fallback, mobile, fire/smoke sim (phase 2 candidate), in-engine editor, PvP/anticheat, dedicated servers.
