# Render track (T6–T9, T14, T29, T30, T35, T39) — integration guide

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
  // textures: true,              // T29 triplanar PBR arrays (false = flat ramp)
  // sky: true,                   // T30 analytic sky + aerial fog (overrides scene.background)
  // ao: true,                    // T30 half-res GTAO in the post stack
  // clouds: true,                // T30 blocky drifting clouds
})
```

### T29 texture assets

`WorldRenderer` (with `textures` on) loads `public/textures/<mat>/*.jpg`
into two `DataArrayTexture`s (albedo + packed normal/rough/AO) at boot —
run `node scripts/textures/fetch-textures.mjs` once (idempotent; assets are
committed) or texture loading fails loudly (unhandled rejection). Until the
arrays finish decoding (~1s) the world renders with per-material ramp
midpoint placeholders, then re-uploads once. Untextured materials (glass,
water-solid, lamp, flesh, leaves, reserved) keep the flat color-ramp path,
selected per-fragment by the 'mat' attribute.

### T30 atmosphere

With `sky` on, `WorldRenderer` assigns `scene.backgroundNode` (analytic
gradient sky + HDR sun disc aligned with the CSM sun + moon) and
`scene.fogNode` (distance × height aerial tint sharing the sky palette) —
both take priority over `scene.background`, so main.ts's flat clear color
becomes dead code but is harmless. The post stack is
scene → GTAO (half-res) → bloom (threshold 1.0) → ACES tonemap; tone
mapping still comes from `renderer.toneMapping` and is applied exactly once
by the RenderPipeline output (`renderer.toneMappingExposure` is live —
the day cycle shifts it mildly at night).

### T58 day/night cycle

Time of day derives from **sim.tick** (deterministic, multiplayer-synced
for free; render reads the tick, never writes — V6). Default: 24 h day per
20 min real time, starting at 15:00 (golden afternoon — the exact look the
smoke gate screenshots; an unwired tick keeps the world frozen there).

**Integrator wiring (one argument):** in `src/game.ts`'s
`startLoop()` animation-loop callback, the line

```ts
this.world.update(dt) // remesh budget, debris, CSM (V7)
```

becomes

```ts
this.world.update(dt, this.sim.tick) // + T58: tick drives the day cycle
```

(currently game.ts line 254 — directly above `this.bodyMeshes.update(...)`.)

Everything else is automatic each frame: sun/moon orbit drives the one
CSM DirectionalLight (`world.sun` — the moon takes over as a dim blue
shadow caster at night; the direction swap happens while intensity ≈ 0 at
twilight so it never pops, and shadow-pass cost stays identical to the
static build), sky/fog palettes (dawn/dusk warm bands, night sky + stars),
hemisphere light, exposure, lamp emissive boost (material id 13 glows via
bloom after dark) and a pool of 3 real PointLights parked on the lamps
nearest the camera at night (castShadow off; measured free at 120 fps).

**Settings/dev hooks (I.settings owner):** plain fields on
`world.cycle` —

```ts
world.cycle.cycleLengthSec = 1200        // real seconds per 24 h day
world.cycle.timeOfDayOffsetHours = 15    // time at tick 0
world.cycle.overrideHours = 21.5         // fixed-time override (null = tick)
```

A render-side dev handle `window.__bbCycle` exists for CDP probes and
until the settings UI lands: `setOverride(h|null)`, `demo(hoursPerSec)`
(render-clock preview drift, dev only — real time comes from the tick),
`stop()`, `hours`, `state`, `info` (renderer.info), `lampCount()`,
`regionCount()`, `sun`. `scripts/cycle-shots.mjs` screenshots
noon/golden/dusk/night + a culling probe with it.

## Per-frame (inside `renderer.setAnimationLoop`)

```ts
renderer.setAnimationLoop((now: number) => {
  const dtMs = Math.min(now - last, 100)
  last = now
  driver.advance(dtMs, sim)     // sim ticks (V11) — unchanged
  cam.update(dtMs / 1000)
  world.update(dtMs / 1000, sim.tick) // dirty→schedule→dispatch/apply + T58 day cycle
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

1. **Transparency (T39, fixes B5).** The mesher emits TWO streams per chunk
   (opaque + transparent, split by the I.mat Transparent flag from the
   canonical sim table, V13): solid-vs-transparent boundaries keep the solid
   face, transparent-vs-air emits into the transparent stream, same-material
   transparent interior faces cull, different transparent materials emit
   both sides of the seam. Each region gets a second Mesh with the fresnel
   glass material (`createTransparentChunkMaterial`: alpha blend, depthWrite
   off, `castShadow=false` — glass casts no shadow v1). Sorting is
   region-level: three sorts transparent objects back-to-front by object
   position, which is enough at ≤64 regions. Dynamic bodies (BodyMeshes)
   merge both streams into their single opaque mesh — glass debris renders
   opaque, as before T39.
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
- **Per-voxel tint (B8):** the chunk materials vary color per VOXEL, never
  within one — the spatial hash floors a cell sampled half a voxel behind
  the face, with a 2e-3 voxel epsilon so f32 interpolation error across a
  merged quad's triangle diagonal can't flicker the cell id. Amplitude is
  per material (`variation` in render materials.ts): organic materials get
  the full ramp swing, plaster/concrete/metal stay near-flat. Keep both
  rules if you touch the salt.
- **GTAO (T30):** half-res, radius 0.55 m (must stay well above one voxel,
  B8 — the user does not want per-voxel occlusion noise), blended at 85%
  into the scene color before bloom. `ao: false` drops the whole gather.
- **Texture arrays (T29):** two 1K RGBA arrays × 9 layers ≈ 75 MB VRAM with
  mips; payload on disk ~11 MB jpg. Layers map by material NAME from the
  canonical table — adding a texture set = drop files in public/textures/
  and extend TEXTURED_MATS + UV_SCALE in texture-arrays.ts.
- Meshing runs in `min(4, cores-1)` module workers; padded chunk copies
  (34³ = 39 KB) transfer, results transfer back — zero structured-clone
  copies of bulk data.
- Region geometry swap disposes the old `BufferGeometry`; bounding spheres
  are set analytically from member chunk bounds (no vertex scan).
- Per-chunk job versions drop stale worker results (rapid re-edits of
  the same chunk while a job is in flight).
- Particle pool: 4096 instanced sprites, motion fully on GPU; `update()`
  writes one uniform.
