# INTEGRATION — content track (T18/T19/T20, detail T41/T42/T43, town T50/T51/T59, B12/B19)

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
// 3. hand waterFills to the water sim: each { box } is an inclusive voxel
//    box to fill via addWater (pool basins AND pond volumes — the CA skips
//    solid voxels, so pond bounding boxes and the villa shallow-end floor
//    are safe to iterate blindly).
sim.world.drainDirty() // or leave for the mesher — stamping dirties every touched chunk
```

All calls are deterministic for a given seed (V2): every feature system draws
from its own DERIVED Prng stream (`seed ^ const ^ imul(id, GOLD)`), so adding
detail never reshuffles the base town or sibling features. Same seed on every
lockstep peer ⇒ identical world.

## World shape (T50 — B11 expansion)

- Arena: 2048×2048×768 voxels = 64×64×24 chunks (~205×205×77 m). No streaming.
- Ground surface: solid fills y ∈ [0, 47], first air at y = 48 (`GROUND_Y`).
  Grass-bump tiles add up to +2 (parks keep them; built districts are flat).
- Road grid: 5×5, centers x/z ∈ {192, 608, 1024, 1440, 1856}. The central
  cross (1024) is ARTERIAL: 8 m asphalt, double solid center line + dashed
  lane lines. Others are residential: 6 m asphalt, dashed center. Zebra
  crosswalks at all 25 intersections; markings derived in the stamper from
  road geometry (MAT_PAINT, asphalt-guarded).
- **Spawn = the central arterial crossing, voxel (1024, 1024) = 102.4 m**
  (`SPAWN_VX`/`SPAWN_VZ` in layout.ts; spawnPoint in src/sim/player.ts).
- Districts (`Layout.districts`, fixed 4×4 plan, content seeded per block):

  |       | bi=0     | bi=1     | bi=2       | bi=3       |
  |-------|----------|----------|------------|------------|
  | bj=0  | rowhouse | rowhouse | commercial | commercial |
  | bj=1  | rowhouse | suburb   | suburb     | commercial |
  | bj=2  | rowhouse | suburb   | suburb     | commercial |
  | bj=3  | park     | park     | park       | suburb     |

## District content

- **Suburb** (5 blocks × 4 lots = 20 houses): the classic neighborhood.
  Houses 8-12 m, 1-2 stories, gable/hip/flat roofs, porches, shutters,
  driveways (+ cars), pools (~35% + guarantee), fences, lamps, mailboxes
  (wood post or brick pedestal), bins, yard + parkway trees, shrubs.
- **Villa (B19)**: the lot geometrically closest to spawn (same lot every
  seed) is a showcase — 10.8×6 m 2-story plastered house, hip roof, balcony,
  chimney, and an 8.4×4.0 m pool with a raised shallow end
  (`Pool.shallow` = concrete refill box), paver deck and open-fronted cabana
  (`Layout.villa`). Its pool doubles as the spawn pool guarantee (≤ ~20 m).
- **Rowhouse** (4 blocks × 2 rows, `Layout.rowBlocks`): party-walled unit
  rows facing the street; 4-5 units/row, 2-3 stories each (stepped flat
  roofs + parapets), front stoops, back doors to a shared garden band,
  switchback interior stairs (derived in the stamper, axis z, alternating
  direction per floor), divider fences + garden trees.
- **Commercial** (4 blocks, `Layout.towers`/`parking`/`plazas`): 1-2 towers
  per block (5-15 stories × 3.0 m `TOWER_STORY_H`), concrete frame + glass
  curtain rows with metal mullions (`Tower.mullion` spacing), interior slabs,
  roof parapet + HVAC. Explorable core: concrete ring, per-floor doors,
  switchback stair runs (15 steps × rise 2), and an OPEN elevator shaft
  (full-height void behind a metal guard wall with per-floor door gaps).
  Plaza apron + rear parking lot (painted stalls, `STALL_W`/`STALL_D`,
  ~45% occupied by cars, aisle lamps).
- **Park** (3 blocks, `Layout.parkPaths`/`ponds`): meadow with grass bumps,
  paver path cross + central plaza, benches, tree clusters, lamps. Ponds
  (≥1 guaranteed) are elliptic multi-lobe dug basins with smooth depth
  profiles; `Pond.box` is the water-fill volume (freeboard below surface).

## House detail (T51)

- Interiors: `House.partitions` — plaster partition walls (1 voxel) with
  door gaps, 2-4 rooms per floor, never crossing the stair run. Furniture is
  emitted as PROPS (table/chair/bed/counter/sofa — chunky wood/plaster/metal,
  destructible), placed per floor with keep-outs.
- Garages: `House.garage` attached beside the house (driveway re-routes),
  roll-door bay 2×1.8 m with metal lintel — up or down per `garageOpen`
  (T59); connecting door to the house; car sometimes parked inside.
- Balconies (`balcony` + `balconyDoor`, 2-story only), brick chimneys
  (`chimney`, pitched roofs), hip roofs (roof: 'gable'|'flat'|'hip'),
  per-house window size/rhythm variety.
- Backyards: patios (`patio`, subtle pavers), raised garden beds
  (`gardens` — wood border, dirt, leaf crop rows), sheds (`shed`, ~30%,
  stamped as a 'shed' prop, door toward the house), worn lawn patches
  (`wornPatches`, T59).
- B12: `stampPavers` = concrete base + sparse rooftile 3×3 accent tiles
  (~1 in 8, world-aligned hash) — NEVER the old brick checker.

## Props (T59)

`Prop.kind` values and footprints live in `PROP_DIMS` (layout.ts — single
authority; props.ts grids must match). Cars: 3 archetypes × 3 body colors,
kind = `sedan0..2 | pickup0..2 | van0..2` (`isCarKind()` helper; colors =
metal/rooftile-red/plaster-white via `CAR_BODY_MATS`). Real silhouettes:
dark asphalt wheels + arches, glass greenhouse, MAT_LAMP light bars, grille.
Cars appear on driveways, inside garages, in parking stalls, and curb-parked
along residential streets. Other kinds: table, chair, bed, counter, sofa,
bench (parks + cabana), shed. `stampScene` throws on any kind without a grid.

## Material id table (I.mat, `src/sim/materials.ts`)

| id | name | used for | flags |
|---|---|---|---|
| 0 | air | — | |
| 1 | dirt | ground slab, garden beds, worn lawn patches, pond bottoms | |
| 2 | grass | ground surface (top 3 voxels + bump tiles) | |
| 3 | asphalt | roads, parking lots, car wheels | |
| 4 | concrete | sidewalks, driveways, plazas, towers, pool lining, flat roofs | |
| 5 | brick | house walls, chimneys, pedestal mailboxes | |
| 6 | wood | floor slabs, gable/hip roofs, stairs, furniture, fences, sheds | flammable, floats |
| 7 | plaster | house/rowhouse walls, cabana, sofa/bed cushions, white car bodies | |
| 8 | glass | windows, curtain walls, car glazing | transparent |
| 9 | metal | car bodies, mullions, lamps, guard walls, HVAC, counters | |
| 10 | water-solid | RESERVED for water track (CA source marker) | transparent |
| 11 | leaves | tree canopies, shrubs, garden crops | flammable, floats |
| 12 | rooftile | tiled roofs, paver accents (B12), red car bodies | |
| 13 | lamp | street-lamp heads, car head/tail lights (emissive in render) | |
| 14 | flesh | player body segments | |
| 15 | paint | road markings, parking stalls, white | |

Ids 0-15 original town set; 16 = sand (B32). Never renumber existing ids (V13).

## Material id reservations (B1 discipline — reserve HERE before adding to materials.ts)

Any track adding materials claims ids in this table FIRST, then lands the
matching rows in `src/sim/materials.ts`. No id is valid until listed here.

### T99 — WP1 bombay palette (reserved 2026-07-09)

| id | name | used for | flags |
|---|---|---|---|
| 17 | salt-crust | playa surface, walkable bleached crust, scum line | |
| 18 | playa-mud | cracked-mud patches, dirt alleys, sand-drift mud | |
| 19 | rust | wrecked cars, scrap creature, drive-in hulks, corrugate streaks | |
| 20 | char | burned trailer shells, collapsed roof rubble (already burned — NOT flammable) | floats |
| 21 | bone-shell | fish-skeleton speckle band, barnacle crust | |
| 22 | cracked-asphalt | bombay streets, weathered patches vs fresh asphalt (3) | |
| 23 | galv-metal | trailer skins, roof sheet, dishes — dull vs metal (9) | |
| 24 | opera-blue | Opera House facade #3E7FBF | flammable, floats |
| 25 | art-red | art pops #E63946 (TV wall, signs) | flammable, floats |
| 26 | art-yellow | art pops #F4C430 | flammable, floats |
| 27 | art-teal | art pops #2EC4B6 | flammable, floats |
| 28 | art-pink | art pops #FF6FB5 | flammable, floats |

Next free id: 29. Palette cap headroom: P18 palette compression bails past
PALETTE_MAX=128 distinct materials per chunk (`src/world/chunks.ts`) and voxel
bytes cap the table at 256 — 29 total ids is far under both.

## Derived Prng streams (V2 bookkeeping)

Base stream `Prng(seed)`: suburb lot loop only (footprints, floors, walls,
roofs, ells, driveway side, car/pool rolls — the villa lot consumes the same
draws before overriding). Derived streams (`seed ^ const ^ imul(id+1, GOLD)`):

| const | system |
|---|---|
| 0x9e3779b9 | stamper terrain bumps |
| 0x51ab7e0d | per-lot detail (stairs side, roof mat, porch, shutters, fences, bins) |
| 0x3c6ef372 | per-lot T51/T59 (windows, garage, hip, chimney, balcony, patio, car kind, garage door, mailbox style, worn patches) |
| 0x1b873593 | per-lot interiors (partitions + furniture) |
| 0xcc9e2d51 | per-lot backyard (sheds, garden beds) |
| 0x6e624eb7 | per-lot yard trees |
| 0x27d4eb2f | per-rowhouse-block units/trees |
| 0x165667b1 | per-commercial-block towers/parking/cars |
| 0x2545f491 | per-park-block paths/ponds/trees |
| 0x7f4a7c15 | parkway street trees |
| 0x0badcafe | curb-parked cars |

Position hashes (`hash3` in stamper) handle leaf raggedness, paver accents,
worn fences, HVAC placement — pure functions of position, no stream at all.

## .vox asset workflow (real art later)

1. Author in MagicaVoxel. Multi-model files + object translations are fine;
   **rotations in the scene graph are NOT applied** (parser limitation,
   documented in `src/sim/vox/vox.ts`) — bake rotation into the model, or
   place via layout `Prop.rot` (quarter-turns around +y).
2. Load bytes → `parseVox(arrayBuffer)` → `{ models, palette, instances }`.
3. `buildRemap(palette, overrides?)` → 256-entry palette-index → material-id
   table. Keep a per-asset override table in code rather than trusting color
   match.
4. `toGrid(model, remap)` → `VoxelGrid` (y-up: world x = vox x, world y =
   vox z, world z = vox y).
5. Register under the layout's `Prop.kind` name in the grids record passed
   to `stampScene` (replacing `placeholderProps()` entries — footprints must
   match `PROP_DIMS`). `stampScene` throws on any missing kind.
6. Determinism caveat: finish ALL async loading before creating the
   Sim/stamping; asset bytes are part of the "map".

## Open issues

- World rim outside the perimeter roads (~15 m band) is plain meadow —
  candidate for a treeline/fence pass later.
- Park tree clusters thin out where keep-outs reject placements; density
  knob lives in `makeParks` (clusters, trees per cluster).
- `.vox` scene-graph rotations (`_r`) parsed past but ignored.
- `stampScene` marks ~all ground chunks dirty at init; the remesh scheduler
  treats the initial drain as a bulk job (T35 fast path).
- Pool/pond water level: fill boxes reach 1 (pools) / 2 (ponds) voxels below
  the surface; shrink `y1` at integration if more freeboard is wanted.
- Memory note (T50): the ground band straddles chunk row cy=1, so all 4096
  ground chunks there realize dense (~134 MB of the ~210 MB chunk data).
  Aligning GROUND_Y to a chunk boundary would reclaim it if it ever matters.
