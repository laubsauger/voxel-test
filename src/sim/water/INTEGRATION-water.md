# INTEGRATION — water track (T15–T17, T60–T62)

Owner: WATER track, branch `track/water2` (v2 pass over `track/w`). Status of
everything below: implemented and unit-tested unless marked **open**.

Files:

- `src/sim/water/rules.ts` — CA rule spec, single source of truth (integer,
  gather-only, pairwise-symmetric). Both implementations cite it.
- `src/sim/water/water-sim.ts` — CPU reference (authoritative), sparse pages,
  active set, source/sink API, `hashWater`/`hashWaterInto`, `attachWaterSim`.
- `src/sim/water/buoyancy.ts` — pure buoyancy solver (T17).
- `src/render/water/compute.ts` — TSL GPU CA mirror (perf path, V4).
- `src/render/water/surface.ts` — surface extraction + `WaterSurface` mesh (T16).
- `src/render/water/material.ts` — TSL water material (T16).

## 1. main.ts wiring (for whoever owns main.ts — I may not modify it)

`main.ts` currently has no Sim instance at all (it is still the T1 skeleton:
fly cam + placeholder ground). Once the CORE loop is instantiated there, water
plugs in like this:

```ts
import { Sim, FixedStepDriver } from './sim/loop'
import { attachWaterSim } from './sim/water/water-sim'
import { WaterSurface } from './render/water/surface'

const sim = new Sim(seed)
const water = attachWaterSim(sim)      // registers the CA as a Sim system (V1)
const waterSurface = new WaterSurface() // default TSL material
scene.add(waterSurface.mesh)

// render loop, after driver.advance(...):
waterSurface.update(water, sim.world)  // rebuilds geometry only on change (version counter)
```

Contract for edit ops (dig/place/explode owners): after mutating voxels, call
`water.notifyVoxelChanged(x, y, z)` for edited cells that might touch water
(cheap; per-chunk dedup happens inside). Without it a settled pool will not
react to a breached wall. Convenient hook: iterate the same cells the stamp
touched, or coarser — one call per dirty chunk corner is NOT enough, it must
be per changed voxel that became solid (water displacement) or air (flow
opening). `stampSphere`-scale loops are fine.

Placing solid into water destroys that cell's water and returns the displaced
amount — an explicit sink (V9 exception). If design later wants displacement
instead of destruction, push the returned amount into a neighbor cell via
`addWater`.

Global hash: `hashSim` (src/sim/hash.ts) does not know about water. Until the
CORE track folds it in, desync detection should combine:

```ts
const h = new Fnv()
h.u32(hashSim(sim))
hashWaterInto(h, water)
const fullHash = h.value
```

**Open:** whoever owns the tick-hash harness should adopt this combined form
(one-line change; water state is otherwise invisible to V3 replay checks).

## 2. CPU-vs-GPU validation harness (design — GPU cannot run in vitest)

Goal (DESIGN.md M3 spike): same command log on NVIDIA + Apple Silicon ⇒
identical water hashes, and GPU ≡ CPU bit-for-bit.

Harness (browser page or `npm run dev` debug panel; manual/CI-on-real-GPU):

1. Build a scenario world (reuse the terrain builders from
   `tests/water-mass.test.ts`), create `WaterSim`, pour via `addWater`.
2. Choose a region enclosing all water plus margin (e.g. the basin chunks
   ± 1 chunk). Create `WaterGpuCa(region)`.
3. Snapshot CPU → GPU:
   - `levels[gpuCellIndex(region,x,y,z)] = waterSim.levelAt(x,y,z)` → `uploadLevels`
   - `solid = world.getVoxel(x,y,z) !== 0 ? 1 : 0` → `uploadSolids`
   - sync step counters: `gpu.stepCount = water.stepCount` (phase schedule
     must match — lateral pairing parity is world-coordinate based on both
     sides, so region origin does not skew pairing).
4. For N steps (N ≥ several hundred, crossing all 4 phases many times):
   `water.step()` and `gpu.step(renderer)`.
   Caveat: the CPU active-set may sleep while GPU always computes — that is
   fine, sleeping is provably a fixpoint; hashes must still match.
5. Read back `await gpu.readLevels(renderer)`, hash both sides over the
   region in the same order (FNV-1a via `Fnv.bytes`), compare. On mismatch,
   diff cell-by-cell and print the first divergent (x,y,z,phase) — that
   localizes which rule leg diverged.
6. Repeat on a second GPU vendor; compare hashes across machines (paste the
   u32). Any difference = V4 violation (or a rules.ts/kernel drift).

Assertions the harness must make beyond equality:
- GPU total mass constant across N steps (V9 on the GPU path).
- No water within 1 cell of the region border at any checkpoint (region-wall
  semantics differ from open world; violation invalidates the run).

**Open:** harness page itself is not written (needs a renderer + a place to
live; render track owns the dev page). `WaterGpuCa` is API-complete for it.

**Open:** GPU path processes the whole region every step (no active-set yet).
Fine at pool scale; if profiling demands, add per-chunk dispatch culling later
— it must stay bit-identical (culling a provably-fixpoint chunk is exact, see
water-sim.ts header comment).

## 3. Scene loading / pool filling (content track, T19/T20 consumer)

Pools are water sources at load: after stamping the layout/props into the
world, for each pool volume (the layout knows its AABBs):

```ts
for (y of poolCells.y) for (z of ...) for (x of ...)
  water.addWater(x, y, z, 255)
```

- `addWater` refuses solid cells and returns the amount actually added, so
  overlapping a pool AABB with terrain is harmless.
- Fill bottom-up with full cells (255) to the design waterline; the CA then
  has nothing to do and the pool goes inactive after ~5 steps (WAKE_TTL) —
  load cost is near zero.
- Do the filling identically on all peers (it is part of deterministic scene
  construction from seed, before tick 0), or route it through a future
  `water_add` command op. The sim-side API is deliberately command-friendly:
  a handler is one line: `water.addWater(op.x, op.y, op.z, op.amount)`.

## 4. Interface expected from the physics track (T17 coupling, T12 bodies)

Water side is done and pure: `computeBuoyancy(waterLevelAt, body, opts)` in
`src/sim/water/buoyancy.ts`. Physics owns Jolt; the adapter I need from them,
per dynamic body whose material has the `floats` flag (I.mat):

```ts
interface FloatingBodyAdapter {
  /** world-space sample points (meters), e.g. voxel centers of the body's
   *  occupied cells (or every 2nd cell for big bodies), recomputed from the
   *  body transform each sim tick */
  getSamples(): Vec3[]
  /** m³ represented by each sample (cellVolume × sampling stride³) */
  readonly sampleVolume: number
  getCenterOfMass(): Vec3
  getLinearVelocity(): Vec3
  /** apply in the same sim tick, at COM: Jolt AddForce/AddTorque */
  applyForceAndTorque(force: Vec3, torque: Vec3): void
}
```

Per tick, in a sim system that runs after the water system:

```ts
const r = computeBuoyancy((x, y, z) => water.levelAt(x, y, z), {
  samples: adapter.getSamples(),
  sampleVolume: adapter.sampleVolume,
  centerOfMass: adapter.getCenterOfMass(),
  velocity: adapter.getLinearVelocity(),
})
adapter.applyForceAndTorque(r.force, r.torque)
```

Notes for physics:
- Determinism: the CPU water field is authoritative sim state, so sampling it
  directly in-tick is deterministic. When the GPU path becomes authoritative
  for perf, sampling switches to the one-tick-delayed readback (DESIGN 2.5);
  still deterministic, same interface.
- `submergedFraction` in the result is useful for extra angular damping
  (Jolt bodies bobbing forever otherwise) — tune on their side.
- Suggested defaults are exported: `FRESH_WATER_DENSITY`, `STANDARD_GRAVITY`;
  `linearDrag` default 60 gives wood-like settling at 10 cm voxels; tune.
- Angular-velocity-dependent drag is NOT modeled (linear drag per sample
  only). If spinning debris looks wrong, extend the descriptor with
  `angularVelocity` — solver change is local.

## 5. Behavior notes & known artifacts (by design, tested)

- Residue films (T62 update): the lateral settle deadband makes pairs with
  level difference ≤ 2 a fixpoint, so draining leaves a ≤2-level puddle
  gradient sloping toward the hole (~0.8% of a full cell per cell). Reads as
  a wet floor; not a leak (mass exact). The deadband exists because diff-2
  ramps under the alternating pairing previously sustained a bucket-brigade
  trickle for O(area) steps — the B21 "breach outflow runs forever" bug.
- Waterfall leg (T62): a supported donor gives its whole level to an empty
  partner that is about to fall — drains/cascades are advective, pools
  visibly drain when breached.
- Splash leg (T62): unsupported water landing on partial water spills a
  quarter of the level difference sideways — falls roll/slosh outward.
- `attachWaterSim` runs 2 CA steps per sim tick (WATER_STEPS_PER_TICK):
  12 m/s fall speed, doubled lateral transport. GPU-harness note: the GPU
  mirror still steps one CA step per `step()` call — keep the step COUNTS
  equal when comparing, not the tick counts.
- Falling columns stretch with air gaps (gather CA artifact) — reads as
  dripping; surface mesh closes each blob so it renders acceptably.
- No compression/pressure rule (marked optional in T15): water does not rise
  through U-bends, max level is 255 everywhere. **Open:** revisit post-M3 if
  pools breached from below look wrong.
- Water at world edge is walled in (no out-of-bounds leak), matching arena
  design.

## 6. T61 render wiring (game.ts owner — mostly none needed)

- `WaterSurface.update(water, world)` unchanged; it now also uploads a
  per-vertex `waterFlow` attribute (disturbance mask from the sim's wake
  set) — no new wiring.
- The material animates ripples via TSL `time`; no per-frame uniform pushes
  needed.
- **Open (wiring wanted):** underwater camera tint. Render-side component is
  ready: `src/render/water/underwater.ts`. game.ts should do:

  ```ts
  import { UnderwaterOverlay } from './render/water/underwater'
  const underwater = new UnderwaterOverlay() // appends a DOM overlay
  // in the frame loop, after cam update:
  underwater.update(this.cam.camera.position, this.water)
  ```

## 7. T60 swimming (sim implemented; audio/particles hooks open)

- Sim side is fully wired without game.ts changes: `attachBuoyancy` now sets
  `phys.water`, and the character update (src/sim/player.ts) swims whenever
  the capsule center is in water: jump = swim up, crouch = sink, neutral
  float holds the head above the waterline (FLOAT_DEPTH). Crouch does NOT
  shrink the capsule while swimming. Sprint has no effect in water.
  Constants exported from player.ts (SWIM_SPEED etc.).
- `p.swimming` (PlayerEntity) is derived per tick — render/audio may read it
  (e.g. swim animations); it is not hashed.
- **Splash hook (audio owner):** set `phys.onSplash = (e: SplashEvent) => …`
  (fields: playerId, x/y/z meters, speed m/s, entering). Fired in-tick when
  a player crosses the waterline with |vy| ≥ 1 m/s — callback must be
  render/audio only, never mutate sim (V6). Suggested wiring: play a splash
  SFX positioned at (x, y, z), volume scaled by `speed`, and emit a particle
  burst via the existing debris/particles system.
- **Underwater tint:** see §6.

## 8. Open issues (summary)

1. Global sim hash does not include water yet (§1) — CORE one-liner.
2. GPU harness dev page not built (§2) — needs render-track dev page; the
   compute class + design above are ready.
3. GPU active-region culling deferred (§2).
4. ~~Edit ops don't call `notifyVoxelChanged`~~ — resolved: game.ts wires
   `world.onVoxelChanged` → `water.notifyVoxelChanged` (ChunkStore hook).
5. No pressure/compression rule (§5).
6. Buoyancy ignores angular velocity drag (§4).
7. Underwater overlay + splash SFX wiring (§6, §7) — game/audio owners.
