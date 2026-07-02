# INTEGRATION — physics + player track (T10–T13, T21–T23)

Track P/PL deliverables and how to wire them into `src/main.ts`.
Files: `src/sim/{physics,connectivity,greedy-boxes,materials,destruction,player}.ts`,
`src/render/{player-cam,player-input,player-mesh}.ts`.

## main.ts wiring (exact)

```ts
import { FixedStepDriver, Sim } from './sim/loop'
import { registerEditOps } from './sim/edit-ops'
import { createPhysics } from './sim/physics'
import { PlayerCam } from './render/player-cam'
import { PlayerInput } from './render/player-input'
import { PlayerMesh } from './render/player-mesh'

const sim = new Sim(SEED)
registerEditOps(sim)                    // dig/place (T5)

// 1. stamp ALL authored scene content here (proc suburb T19/T20, .vox T18).
//    createPhysics drains the dirty set and builds static collision for it
//    WITHOUT connectivity checks (authored content is taken as-is).
//    Content stamped after createPhysics gets connectivity-checked on the
//    next tick like any edit — floating authored props would fall.

// 2. async physics init — MUST complete before the loop starts (WASM load).
//    Registers: 'explode' (T13), 'spawn'/'move' (T21) op handlers, and the
//    physics step as a Sim system.
const phys = await createPhysics(sim)

// 3. any OTHER sim systems (water T15, etc.): register order = execution
//    order inside the tick. Physics registered first ⇒ runs first. If another
//    track needs to run before physics, call sim.addSystem before
//    createPhysics resolves — i.e. decide order here in main, deterministically.

// 4. buoyancy coupling (T17/T40.6) — REQUIRED order: physics → water → buoyancy.
//    attachBuoyancy must be called after BOTH createPhysics and attachWaterSim:
import { attachWaterSim } from './sim/water/water-sim'
import { attachBuoyancy } from './sim/buoyancy-coupling'
const water = attachWaterSim(sim)
attachBuoyancy(sim, phys, water)
//    Why this order: buoyancy samples the tick's post-step body transforms and
//    post-step water field, then accumulates Jolt AddForce/AddTorque; Jolt
//    consumes accumulated forces in the NEXT tick's step. One-tick force
//    latency — deterministic (pure function of tick-N state) and stable (drag
//    far below critical damping; 16.7ms ≪ bob period). Full rationale in
//    src/sim/buoyancy-coupling.ts header. Floats-flagged (I.mat) island
//    bodies bob and settle at the waterline; everything else sinks normally.

const driver = new FixedStepDriver()
const input = new PlayerInput(renderer.domElement)
const cam = new PlayerCam(innerWidth / innerHeight, renderer.domElement) // KeyV = fp/tp toggle
let playerMesh: PlayerMesh | undefined

const LOCAL_PLAYER = 1
sim.queue.push({ tick: 0, playerId: LOCAL_PLAYER, seq: 0, op: { kind: 'spawn' } })

let last = performance.now()
renderer.setAnimationLoop((now) => {
  // push this tick's input BEFORE advancing (lockstep swaps this for the net queue)
  sim.queue.push(input.moveCommand(sim.tick, LOCAL_PLAYER))
  driver.advance(now - last, sim)
  last = now

  const player = phys.players.get(LOCAL_PLAYER)
  if (player) {
    if (!playerMesh) { playerMesh = new PlayerMesh(player); scene.add(playerMesh.group) }
    playerMesh.update(player)
    cam.update(player, sim.world)      // both cameras read the same entity (V6)
  }

  // remesh feed for the render/mesher track — see "dirty channel" below
  for (const ci of phys.drainRemesh()) mesher.enqueue(ci)

  // dynamic island bodies: phys.bodies (id → DynamicBody). Render however you
  // like: body.grid/sx/sy/sz (voxel content, corner-origin local frame),
  // body.px..pz + qx..qw (transform, updated every tick), body.version
  // (bump = grid changed). Simple v1: InstancedMesh like PlayerMesh.

  renderer.render(scene, cam.camera)
})
```

Hash for the desync detector: combine `hashSim(sim)` and `hashPhysics(phys)`
(both FNV u32; send both, compare both — V10).

## The dirty channel contract (render track: READ THIS)

`ChunkStore.dirty` is now drained by the physics system *inside the sim tick*
(it must see edits the tick they happen to rebuild static collision and run
connectivity). The render layer therefore must NOT call `world.drainDirty()`
— it would race the physics system and one side would starve.

Instead the physics world re-exposes everything it drained (including island
extraction fallout): call `phys.drainRemesh(): number[]` once per frame —
sorted chunk indices needing remesh/mirror upload.

## Jolt determinism findings (verified vs assumed)

Verified on this machine (arm64 mac, node 24, jolt-physics 1.0.0 wasm-compat):

- `PhysicsSettings.mDeterministicSimulation` defaults to `true` in this build;
  the constructor asserts/forces it anyway.
- Same-process repeat runs (fresh `PhysicsWorld` per run, shared WASM heap):
  bit-identical hash sequences over 20–90 ticks incl. falling islands,
  explosions, impulses, character walking (tests: physics/explode/player).
- Cross-process: same scripted scenario (spawn+move+place+explode, 60 ticks,
  physics+sim hashes each tick) in two separate node processes → identical
  output (manual probe, not in CI).
- Single-threaded build (`jolt-physics` default entry is the non-multithread
  wasm-compat binary; `mMaxWorkerThreads = 0` set regardless).

Assumed, NOT verified:

- Cross-machine / cross-browser determinism. Jolt documents determinism for
  "same binary"; browser WASM is compiled per-engine. Same wasm bytes on
  desktop Chrome (the only §C target) should hold, but the M5 desync detector
  is the real test. Do not skip V10 hash exchange.
- `Math.sin/cos/sqrt` in player movement + impulse code: deterministic within
  one JS engine, not spec-pinned across engines. Fine for Chrome-only (§C).
  If cross-engine play ever matters, replace with table/fixed-point.
- Long-horizon determinism (hours) and body-count extremes untested.

## Design decisions / caveats

- **Connectivity trigger**: any world edit (dig/place/explode) funnels through
  the dirty set; the structural pass runs connectivity on the union bbox of
  this tick's dirty chunks + 8-voxel margin, clamped to 128 per axis. Two
  far-apart same-tick edits produce one big (clamped) union region — worst
  case an island near a clamped face is treated as supported (escape hatch)
  until the next edit nearby. Documented v1 tradeoff.
- **Cascades**: island removal re-dirties chunks; their static bodies rebuild
  the same tick (no 1-tick ghost collision), but their connectivity check runs
  next tick — progressive collapse settles over ticks, deterministically.
- **Islands stay dynamic forever** (V12); sleeping allowed, no re-weld.
- **T40 feel**: island bodies get per-material friction/restitution
  (MATERIAL_FEEL in physics.ts, keyed by the island's dominant material —
  `DynamicBody.mat`), MaxLinearVelocity 60 m/s + MaxAngularVelocity 25 rad/s
  caps, angular damping 0.25. Kill plane: bodies with py < −10 m are removed
  from sim+Jolt inside the tick (ascending id); `phys.removedBodies` counts
  them and is part of hashPhysics.
- **Sleeping floaters** are not re-woken by water changes (buoyancy skips
  inactive bodies) — a drained pool leaves a slept floater hovering until the
  next nearby impulse/edit wakes it. v1 tradeoff, documented in
  buoyancy-coupling.ts.
- **Mass** = voxel count × `MATERIALS[mat].density` × 0.001 m³;
  inertia from compound shape via `EOverrideMassProperties_CalculateInertia`.
- **materials.ts** is the sim-side I.mat slice (density/strength/flags).
  Render track: add colors in your own module but import density/strength
  from here — one table, no forked material ids. `MAT_FLESH = 9` is used by
  player segments.
- **Player damage model ignores yaw** (segments axis-aligned at feet voxel).
  v1 simplification; rotate blast center into local space later if it matters.
- **'shoot' op is NOT handled** (T28/other track). Wiring a shoot handler:
  raycast, then `damagePlayersSphere(...)` + small `destroySphere(...)`.
- **Jolt JS pitfalls** (cost me a crash): methods returning `BodyID`/`Vec3`/
  `RVec3`/`Quat` return transient wrappers — never store them; store
  `Jolt.Body` pointers. Statics live on `.prototype` at runtime. `d.ts`
  mistypes `DefaultBroadPhaseLayerFilter` (cast needed).
- **Memory**: `ShapeSettings` trees are destroyed after `Create()`; Vec3/Quat
  temporaries destroyed after use. `CharacterVirtual` instances are not freed
  on `dispose()` (no safe destroy path via the wrapper) — negligible leak,
  test-only concern.

## Open issues

1. Character capsule does not push / get pushed by dynamic island bodies
   (no CharacterContactListener, no inner body). Islands can intersect the
   player. Add `mInnerBodyShape` or a contact listener when it matters.
2. Impulse uses body origin (grid corner), not center of mass — slightly
   off-center shove for large islands. Cosmetic at v1 scale.
3. `drainRemesh()` grows unbounded if the render layer never drains (headless
   tests). Harmless (Set of chunk indices), but know it exists.
4. Explosions do not impulse players (only bodies). Gameplay decision pending.
5. If two tracks both register a `'spawn'`-adjacent op or another system
   drains `world.dirty`, things break loudly (duplicate-handler throw) or
   subtly (starved dirty). Coordinate in main.ts.
6. `PlayerInput.seq` is module-local; other command sources for the same
   player must coordinate seq allocation (CommandQueue orders by (playerId, seq)).
