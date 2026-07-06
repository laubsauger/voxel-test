# Box3D Physics Spike — Findings (T83)

Evaluation of **Box3D** (erincatto/box3d, C17 → WASM) as a replacement for our
Jolt physics backend, focused on voxel destruction. 2026-07-06.

## TL;DR

Box3D **can drive our real destruction pipeline** — proven headlessly
(`tests/box3d-physics.test.ts`) and in-browser (`box3d-spike.html`): the same
`explode` command → `structuralPass` → `connectivity.findUnsupportedIslands` →
`extractIsland` → debris runs on Box3D with **zero changes** to the voxel/
destruction code. But a *full* Jolt→Box3D swap has **three hard blockers** that
make it a partial, destruction-only backend today, not a drop-in for the whole game.

## Library facts

- `box3d-wasm@0.2.0` (community WASM build by monteslu of Erin Catto's Box3D
  v0.1.0). Prebuilt, isomorphic browser+Node, MIT, no deps, ~520 KB wasm.
  Used `/standard` (SIMD, single-thread) — `/deluxe` (threads) needs COOP/COEP
  cross-origin isolation we don't set.
- API is embind OO: `new World({gravity})`, `world.createBody({type,position})`,
  `body.createBox/createSphere/createHull`, `world.step(dt, subSteps)`,
  `body.getPosition()/getRotation()`, `world.explode(...)`, CCD via
  `world.enableContinuous()`/`body.setBullet()`, perf via `world.getProfile()`.
- The handoff's **"double-precision"** claim is **false** — transforms are f32.
- The cited `[1]` (planck.js) is a **2D** engine — unrelated; ignore.

## The three questions asked

**1. Voxel-edge collisions — clean or snagged?** Clean. Dropped boxes/spheres and
debris rest naturally on voxel structures with no jitter at the greedy-box seams.
Soft-step solver + per-body sleeping settle stacks well.

**2. Tunneling?** Box3D has real CCD (`enableContinuous` + per-body `setBullet`).
Fast movers (80 m/s test bullets) do not clip thin voxel walls with CCD on.
Toggleable for A/B.

**3. Performance / body model?** The lever is **collider count**, and greedy
merging is decisive:

| Static mapping | Bodies (15,354 solid voxels) | Build | Step |
|---|---|---|---|
| one body per voxel | 15,354 | 130 ms | 0.40 ms |
| **greedy-box merged** | **41** | **3.6 ms** | **0.20 ms** |

375× fewer bodies, 36× faster build. In the real-pipeline scene, an explosion
produced ~10–17 debris bodies + a full chunk-collider rebuild at **0.2–0.3 ms
step**. Perf is not the concern.

## Perf under repeated destruction — where the cost actually is

Profiled the real-suburb spike (`box3d-spike.html`) hammering a building with
barrages of `explode`, per-tick phase breakdown (peak ms):

| | structural (create bodies) | box3d step | readback | **render (chunk remesh)** | bodies |
|---|---|---|---|---|---|
| reweld OFF, 6 barrages | 1.4 | 0.5 | 0.2 | **6.2** | 50 |
| reweld ON, hammering | 1.7 | 0.2 | 0.1 | 3.7 | 5 |

**Box3D is NOT the bottleneck.** Body creation (chunk-collider rebuild + convex-hull
islands) peaks ~1.4–1.7 ms; stepping is ~0.2–0.5 ms even at 50 accumulated bodies
because box3d **sleeps** settled debris. This confirms "hundreds of thousands at
full fps" — the solver cost is trivial here.

**The dominant cost is the chunk MESH REBUILD (render, ~6 ms spikes)** — the spike
rebuilds a full 32³ chunk BufferGeometry on the main thread for every dirtied
chunk. That is engine-independent and is exactly the game's B23/B63 destruction
stutter — which the game already fixes with a **remesh worker + per-frame budget**
that the spike does not use.

**Why the game (Jolt) drops on the 3rd/4th rocket:** two things the spike shows
are cheap on Box3D but expensive on Jolt / unbounded in general:
1. **Rigid-body creation.** Each hit rebuilds per-chunk static colliders + spawns
   island bodies. On Jolt each chunk is a `StaticCompoundShape` whose `Create()` is
   heavy; rebuilding several per hit, every hit, adds up. Box3D's one-body-per-box
   creation is ~1.4 ms/heavy-tick.
2. **Debris accumulation.** Without prompt reweld/sleep, live bodies + their meshes
   grow every hit → per-frame readback/sync/object-count climb. Reweld bounds it:
   50 → 5 bodies (see table).

### Fixes (what to tweak)
- **Reweld/freeze sooner** — settled debris rasterises back to static + despawns.
  Implemented here (`REWELD_TICKS = 90` ≈ 1.5 s vs Jolt's 210); keeps body/mesh
  count flat. Biggest lever for "perf drops after N hits."
- **Enable sleeping** (box3d `enableSleeping`) so stepping cost is O(awake), not
  O(total). Done.
- **Don't rebuild whole-chunk collider shapes per hit** — rebuild only the dirtied
  sub-region, or (Jolt) mutate the compound instead of `Create()` from scratch.
- **Budgeted remesh on a worker**, not full-chunk BufferGeometry rebuilds on the
  main thread (the game already does this; a real Box3D integration must keep it).
- Box3D directly removes cost #1 (cheap body creation) and #2 stays a
  reweld/sleep-tuning problem independent of engine.

## Full-swap port map (the real seam)

Everything upstream of the Jolt `PhysicsWorld` is physics-agnostic. We extracted
`IPhysicsWorld` (`src/sim/iphysics.ts`) — the destruction method surface — and
`Box3DPhysicsWorld` (`src/spike/box3d-physics.ts`) implements it over box3d-wasm.
`destruction.ts` / `edit-ops.ts` / `shoot-op.ts` were re-typed to the interface;
`connectivity.ts` was already engine-free. **Jolt path unaffected: 509/509 tests
pass.**

### What ported cleanly (destruction)
`initStatic`, `tick`, `structuralPass`, `extractIsland`/`spawnDebrisBody`,
`setBodyVelocity`, `applyRadialImpulse`, `impulseBodyAt`, `damageBodySphere(s)`
(destroy+recreate hull, no live re-shape in box3d), `castRayBody`, `drainRemesh`.

### The blockers (B30) — 2 hard, determinism cleared

1. **Non-convex island bodies are inexpressible.** Jolt makes each debris chunk
   one multi-box *compound* body. box3d-wasm 0.2.0 `createBox` has **no
   shape-local offset**, and `createHull` is **convex-only**. So islands become
   **convex-hull approximations** — fine for blobby rubble, wrong for concave
   (an L of rubble collides as a wedge). This also means static chunk colliders
   must be **one body per greedy box** (N× Jolt's body count — cheap here, but a
   real budget change at world scale).
2. **CharacterVirtual (player) + VehicleConstraint/motorcycle are UNPORTABLE.**
   box3d 0.2.0 has no character controller and no wheeled-vehicle rig. Players
   and drivable vehicles need a full custom rebuild or must stay on Jolt.
3. **Determinism — NOT a blocker (corrected).** Box3D is engineered for
   determinism, and our backend is **replay-deterministic**: two identical runs
   produce **bit-identical** body-state sequences incl. explosions
   (`tests/box3d-determinism.test.ts`). So a **Box3D-canonical lockstep MP is
   viable** (Box3D peer vs Box3D peer), exactly as with Jolt. The only true
   limits: a Box3D peer can't sync with a *Jolt* peer (different engines →
   different exact values, so no shared `hashPhysics`), and cross-*platform*
   determinism (different CPU/wasm build) is unverified — the same open question
   Jolt has. f32 is not the issue; operation order is, and ours is fixed
   (deterministic Map/Set insertion order, seeded PRNG, no wall-clock).

## Recommendation

- **For destruction/debris: viable now**, and **MP-capable** as a Box3D-canonical
  build (replay-deterministic). Pipeline works, perf is good, integration is
  minimal (interface + one backend class). Convex-hull debris is the fidelity trade.
- **Blocking a full swap: only players + vehicles** (no character/vehicle rig in
  box3d 0.2.0). A dual-backend (Jolt for players/vehicles, Box3D for destruction)
  works but adds two-world coupling; a Box3D-only future needs those two
  controllers rebuilt.
- **If chasing a Box3D-only future:** the gating work is (a) a kinematic capsule
  character controller, (b) a raycast-suspension vehicle, (c) accepting
  convex-hull (or authoring a box-union body abstraction if a future box3d
  exposes offset shapes), (d) re-verifying cross-peer determinism for MP.

## Artifacts

- `box3d-spike.html` + `src/spike/*` — live scene (real pipeline) + Box3D wrapper.
- `tests/box3d-physics.test.ts` — headless real-pipeline proof.
- `tests/box3d-sync.test.ts` / `box3d-isolation.test.ts` — V15 / V14 guards.
- SPEC §T T78–T85, §V V14–V16, §B B30.
