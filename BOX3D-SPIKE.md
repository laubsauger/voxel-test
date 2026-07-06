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

### The three blockers (B30)

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
3. **Determinism.** f32 + a different body decomposition ⇒ Box3D **cannot share
   `hashPhysics` with Jolt** and can't be MP-lockstep-compatible with the Jolt
   build. It must be its own canonical, non-MP build.

## Recommendation

- **For destruction/debris in single-player or a Box3D-canonical mode: viable
  now.** The pipeline works, perf is good, integration is minimal (interface +
  one backend class). Convex-hull debris is an acceptable fidelity trade.
- **Do NOT rip Jolt out wholesale.** Players + vehicles + MP determinism keep us
  on Jolt. A dual-backend (Jolt for players/vehicles/MP, Box3D for destruction)
  is possible but adds two-world coupling cost.
- **If chasing a Box3D-only future:** the gating work is (a) a kinematic capsule
  character controller, (b) a raycast-suspension vehicle, (c) accepting
  convex-hull (or authoring a box-union body abstraction if a future box3d
  exposes offset shapes), (d) re-verifying cross-peer determinism for MP.

## Artifacts

- `box3d-spike.html` + `src/spike/*` — live scene (real pipeline) + Box3D wrapper.
- `tests/box3d-physics.test.ts` — headless real-pipeline proof.
- `tests/box3d-sync.test.ts` / `box3d-isolation.test.ts` — V15 / V14 guards.
- SPEC §T T78–T85, §V V14–V16, §B B30.
