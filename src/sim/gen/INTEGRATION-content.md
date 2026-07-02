# INTEGRATION — content track (T18/T19/T20 + detail pass T41/T42/T43)

For the integrator wiring main.ts and for the render/physics/water tracks.

## main.ts wiring (load order)

World generation runs ONCE at world init, before tick 0. It is the sim's
initial state — not a runtime mutation — so it writes through I.chunk
directly. Everything after tick 0 must go through I.cmd (V1).

```ts
import { generateLayout } from './sim/gen/layout'
import { stampScene } from './sim/gen/stamper'
import { placeholderProps } from './sim/gen/props'

const sim = new Sim(seed)
const layout = generateLayout(seed)                       // 1. pure data, no writes
const { waterFills } = stampScene(sim.world, layout, placeholderProps()) // 2. ChunkStore writes
// 3. hand waterFills to the water track once T15 lands:
//    each { box } is an inclusive voxel box (a pool basin interior) the
//    water sim should fill via its source API. Until then: ignore them.
sim.world.drainDirty() // or leave for the mesher — stamping dirties every touched chunk
```

All three calls are deterministic for a given seed (V2): layout uses `Prng(seed)`,
the stamper uses `Prng(seed ^ 0x9e3779b9)` for terrain variation only. Same seed
on every lockstep peer ⇒ identical world (map sync comes free).

Geometry facts the other tracks may rely on:

- Ground surface: solid fills y ∈ [0, 47], first air at y = 48 (`GROUND_Y`,
  exported from `src/sim/gen/layout.ts`). Grass-bump tiles add up to +2.
- Suburb: 3×3 road grid (centers x/z ∈ {96, 512, 928}), 4 blocks, 16 lots,
  one house each, ~35% pools, ~50% driveway cars.
- Pool guarantee: every seed has ≥2 pools, and the lot closest to spawn
  (voxel 512,512, the central crossing) always carries a spawn-biased pool
  ≤ ~19 m from the crossing (`forcePoolBasin` in layout.ts).
- Pool basins are empty (air) with 2-voxel concrete lining; water arrives
  only via the returned `waterFills` data.
- Multi-story houses (floors=2) have interior straight-run stairs (T41):
  `House.stairs` (rect/axis/dir), 13 steps × rise 2 / tread 3 voxels against
  the back wall; the upper slab is carved over the run (capsule head-safe).
- Vegetation (T42): `Layout.trees` (2×2 MAT_WOOD trunk + blobby MAT_LEAVES
  canopy, 3 archetypes, per-tree seed) and `Layout.shrubs` (leaf mounds at
  house fronts). Yard trees keep canopy clear of house/driveway/path/porch/
  pool deck; parkway trees line the roads. Leaf blobs fill AIR only.
- Street detail (T43): `Layout.fences` (picket segments, gate gaps pre-split
  at driveway/path), `Layout.lamps` (metal pole + emissive MAT_LAMP head,
  arm dir toward road), `Layout.mailboxes`, `Layout.bins`. Road markings
  (center dashes + zebra crosswalks) are derived in the stamper from road
  geometry — MAT_PAINT (id 15) 1 voxel deep, asphalt-guarded.
- House variation (T43): `roofMat` (wood|rooftile gables), `driveMat`
  (concrete|paver checker), `porch` (stoop + posts + awning), `shutters`,
  `path` (paver walk from front lot edge to door).

## Material id table (I.mat, `src/sim/materials.ts`)

| id | name | used for | flags |
|---|---|---|---|
| 0 | air | — | |
| 1 | dirt | ground slab | |
| 2 | grass | ground surface (top 3 voxels + bump tiles) | |
| 3 | asphalt | road surface (top 3 voxels) | |
| 4 | concrete | sidewalks, driveways, pool lining, flat roofs | |
| 5 | brick | house walls (~half of houses) | |
| 6 | wood | floor slabs, gable roofs, some props | flammable, floats |
| 7 | plaster | house walls (other half) | |
| 8 | glass | windows, car glazing | transparent |
| 9 | metal | car bodies/wheels | |
| 10 | water-solid | RESERVED for water track (marker for CA source volumes) | transparent |
| 11 | leaves | tree canopies, shrubs | flammable, floats |
| 12 | rooftile | some gable roofs | |
| 13 | lamp | street-lamp heads (emissive in render) | |
| 14 | flesh | player body segments | |
| 15 | paint | road markings (dashes, crosswalks), white | |

`colorRamp` = two 0xRRGGBB endpoints for per-voxel variation (render track,
T8). `strength`/`density` are first-pass values — physics track (T12/T13)
should tune, but keep ids stable; ids are baked into stamped worlds and tests.
The table is now FULL (0–15). Never renumber existing ids (V13); growing past
16 entries needs coordination here first.

## .vox asset workflow (real art later)

1. Author in MagicaVoxel. Multi-model files + object translations are fine;
   **rotations in the scene graph are NOT applied** (parser limitation,
   documented in `src/sim/vox/vox.ts`) — bake rotation into the model, or
   place via layout `Prop.rot` (quarter-turns around +y).
2. Load bytes → `parseVox(arrayBuffer)` → `{ models, palette, instances }`.
3. `buildRemap(palette, overrides?)` → 256-entry palette-index → material-id
   table. Explicit overrides win; the rest falls back to nearest color vs the
   material `colorRamp` midpoints. Keep a per-asset override table in code
   (e.g. `{ 1: MAT_METAL, 2: MAT_GLASS }`) rather than trusting color match.
4. `toGrid(model, remap)` → `VoxelGrid` (y-up: world x = vox x, world y =
   vox z, world z = vox y).
5. Register under the layout's `Prop.kind` name in the grids record passed to
   `stampScene` (replacing `placeholderProps()` entries, same keys `car0`,
   `car1`). `stampScene` throws on any prop kind without a grid — no silent
   skips.
6. Determinism caveat: fetching .vox files is async I/O — finish ALL loading
   before creating the Sim/stamping; asset bytes are part of the "map" and
   must be identical on every peer (hash the buffers into the join snapshot
   if .vox assets ever become user-supplied).

## Open issues

- `.vox` scene-graph rotations (`_r`) parsed past but ignored; fine for
  single-prop assets, revisit if we import whole multi-object scenes.
- MagicaVoxel default palette not bundled: files saved WITHOUT an RGBA chunk
  get a flat gray palette → everything remaps to the same material. Real
  exports always contain RGBA, so low priority.
- `stampScene` marks ~all ground chunks dirty at init; the remesh scheduler
  (T9) should treat the initial drain as a bulk job, not a per-edit storm.
- Pool water level: `waterFills` boxes are the full basin interior (top at
  y = GROUND_Y - 1). If the water track wants freeboard, shrink y1 by 1-2 at
  integration.
- Houses have no interior walls/furniture; L-extensions have no door between
  main house and extension. Cosmetic, post-M1.
- Material table is full (id 15 = paint claimed by T43). No free slots left
  in the 16-entry table.
- Lamp heads are MAT_LAMP voxels; the glow comes from the render material's
  emissive param (id 13) — nothing to wire for content.
- Detail features draw from per-lot/per-system DERIVED Prng streams
  (`seed ^ const ^ imul(lotId)`), so adding more detail later never
  reshuffles the base suburb or other features.
