# Render track (T6–T9, T14, T35) — integration guide

Wiring the render pipeline into `src/main.ts`. The render layer never
mutates sim state (V6); its only sim input is `ChunkStore` reads +
`drainDirty()` consumption, which `WorldRenderer` performs internally.

## Imports

```ts
import { Sim, FixedStepDriver } from './sim/loop'
import { registerEditOps } from './sim/edit-ops'
import { WorldRenderer } from './render/world-renderer'
```

## Construction order

1. Create `renderer` (WebGPURenderer) with `renderer.shadowMap.enabled = true`
   (already the case in main.ts). Tone mapping stays as-is.
2. Create `scene` and `cam` (FlyCam) as today.
3. **Remove the placeholder ground plane, sun and ambient light** —
   `WorldRenderer` adds its own sun (with CSM cascades) and hemisphere
   light. Keeping both double-lights the scene.
4. Create the sim and generate the world (fills mark chunks dirty):

```ts
const sim = new Sim(seed)
registerEditOps(sim)
sim.world.fillBox(0, 0, 0, 1023, 63, 1023, 1) // e.g. flat dirt ground
const driver = new FixedStepDriver()
```

5. Create the world renderer (either order relative to step 4 works —
   it calls `enqueueAll()` to catch chunks written before construction):

```ts
const world = new WorldRenderer({
  renderer,
  scene,
  world: sim.world,
  camera: cam.camera,
  // optional knobs:
  // workerCount: 4,              // default min(4, cores-1)
  // maxDispatchPerFrame: 12,     // V7 budget: worker jobs started per frame
  // maxApplyPerFrame: 12,        // V7 budget: chunk mesh-data applies per frame
  // maxRegionBuildsPerFrame: 8,  // V7 budget: region geometry rebuilds per frame (T35)
  // bloom: true,
  // debris: true,
})
```

## Per-frame (inside `renderer.setAnimationLoop`)

```ts
renderer.setAnimationLoop((now: number) => {
  const dtMs = Math.min(now - last, 100)
  last = now
  driver.advance(dtMs, sim)     // sim ticks (V11) — unchanged
  cam.update(dtMs / 1000)
  world.update(dtMs / 1000)     // drain dirty → schedule → dispatch/apply
  world.render()                // replaces renderer.render(scene, camera)
})
```

`world.render()` renders through the bloom pipeline (`RenderPipeline`).
Do **not** also call `renderer.render(...)` — that would render twice.

## Resize

```ts
addEventListener('resize', () => {
  cam.camera.aspect = innerWidth / innerHeight
  cam.camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
  world.resize()                // recompute CSM cascade frustums
})
```

## Debris bursts (T14)

Automatic: `ChunkMeshManager.onEdit` fires with dirty-chunk centers and
`WorldRenderer` bursts dust there (attached after the first `update()` so
initial world gen doesn't detonate). For nicer placement the integrator
can additionally burst at the actual edit point when issuing commands:

```ts
world.particles.burst({ x, y, z }, 40) // world meters, render-only
```

## HUD / debugging

- `world.chunks.pendingCount` — chunks awaiting remesh (drains over frames
  after big edits; that's the V7 budget working, not a bug).
- `world.chunks.chunkMeshCount` — chunks with live mesh data (drawn merged
  into region meshes since T35, not one Mesh per chunk).
- `world.chunks.regionMeshCount` — merged region meshes in the scene =
  world draw calls per pass (T35).

## Open issues / limitations

1. **Transparent materials render opaque.** Glass/water voxels mesh into
   the same opaque chunk material; faces between solid and transparent
   voxels are culled like solid-solid. Proper handling needs a second
   mesh pass per chunk (transparent quads, `transparent: true` material,
   no face-cull against transparent neighbors). Water gets its own
   surface extraction in T16 anyway; glass is cosmetic until then.
2. **Diagonal-chunk AO staleness.** An edit re-meshes the dirty chunk +
   6 face neighbors. AO of a vertex exactly on a chunk edge can also
   depend on diagonal neighbor chunks; those aren't re-enqueued, so a
   rare 1-voxel AO seam can persist until that chunk is next dirtied.
   Cheap fix if it bothers: enqueue all 26 neighbors (≈4× remesh cost on
   small edits).
3. **Scheduler sort cost.** `RemeshScheduler.take()` sorts the whole
   pending set each call. Fine for ≤ ~16k chunks (initial world build,
   ~1 ms); switch to partial selection if world gen ever spikes frames.
4. **Worker `onerror` throws** (fail loud, V10 spirit). If you want a
   softer failure mode (e.g. HUD banner), catch there.
5. **Initial build time.** A fully solid 100×100×6.4 m ground is ~2k
   non-empty chunks; at 12 dispatches/frame it fully meshes in ~3 s,
   near-camera first. Bump `maxDispatchPerFrame`/`maxApplyPerFrame` if
   that feels slow — meshing is off-thread, budgets only gate GPU upload
   (V7 protects the frame either way).
6. **`three/addons` imports** (`BloomNode`, `CSMShadowNode`) — resolved
   via the `three` package `exports` map; no vite config needed.
7. **Not yet drawn:** dynamic island bodies (T12) will need their own
   mesher instance — `meshChunk`/`buildPaddedChunk` are pure and reusable
   for body-local grids of any origin.

## Perf notes

- **Region batching (T35, B2 fix):** chunks are drawn as merged 4×4×4-chunk
  region meshes, not one Mesh per chunk. The settled suburb is ~2437
  non-empty chunks; per-chunk meshes meant ~10k draws/frame across main +
  3 CSM cascade passes (23fps). Merged regions cut that to ~60 draws per
  pass (~240 total) → 120fps settled in the CDP smoke. Worker output per
  chunk is cached CPU-side; a dirty chunk marks its region and regions
  rebuild by typed-array concatenation (positions offset, indices rebased),
  budgeted by `maxRegionBuildsPerFrame` (V7). Edit latency: dirty chunk →
  worker remesh → region rebuild, still a few frames end to end.
- **Initial-load burst (B3):** until the remesh pipeline first drains
  completely, dispatch/apply/region budgets and worker queue depth run at
  burst values (24/64/32, depth 4), then drop to the steady-state options
  above. All still bounded per frame (V7). Steady state keeps each worker
  fed with up to 2 queued jobs.
- **Movement-aware remesh priority (B3):** `WorldRenderer.update` leads the
  scheduler focus along the camera velocity (0.5 s, clamped to one region),
  so chunks ahead of a fast-moving camera mesh first.
- **Shadow config (B4):** the chunk material renders **front faces** into
  the shadow map (`shadowSide = FrontSide`) — voxel walls are 10 cm thin,
  and back-face depth let light leak through wall/roof/floor joins into
  interiors. The sun's `normalBias` is scaled per CSM cascade after the
  first render (CSMShadowNode only scales `bias`). If you add another
  world-geometry material, set `shadowSide = FrontSide` on it too or
  interiors will leak again.
- Meshing runs in `min(4, cores-1)` module workers; padded chunk copies
  (34³ = 39 KB) transfer, results transfer back — zero structured-clone
  copies of bulk data.
- Region geometry swap disposes the old `BufferGeometry`; bounding spheres
  are set analytically from member chunk bounds (no vertex scan).
- Per-chunk job versions drop stale worker results (rapid re-edits of
  the same chunk while a job is in flight).
- Particle pool: 4096 instanced sprites, motion fully on GPU; `update()`
  writes one uniform.
