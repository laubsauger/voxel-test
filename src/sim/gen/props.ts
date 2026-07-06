/**
 * T20/T51 — placeholder prop voxel models, built in code so the town works
 * before real MagicaVoxel art lands. Same VoxelGrid shape the .vox pipeline
 * (src/sim/vox/remap.ts toGrid) produces, so swapping in real .vox assets
 * is a data change only. Pure constants (V2).
 *
 * Footprints (x×z) must match PROP_DIMS in layout.ts — that table is the
 * single authority the layout placement and tests use.
 */

import type { VoxelGrid } from '../vox/remap'
import { MAT_ASPHALT, MAT_GLASS, MAT_LAMP, MAT_METAL, MAT_PLASTER, MAT_ROOFTILE, MAT_WOOD } from '../materials'

function makeGrid(sx: number, sy: number, sz: number): VoxelGrid {
  return { sx, sy, sz, mats: new Uint8Array(sx * sy * sz) }
}

function fill(g: VoxelGrid, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, mat: number): void {
  for (let y = y0; y <= y1; y++)
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) g.mats[x + z * g.sx + y * g.sx * g.sz] = mat
}

// ---- T59 cars: real silhouettes — dark wheels + arches, glass, body color
// variants (metal/rooftile-red/plaster-white), MAT_LAMP light accents -------

/** body paint options; index = kind suffix (sedan0, pickup2, …) */
export const CAR_BODY_MATS = [MAT_METAL, MAT_ROOFTILE, MAT_PLASTER] as const

/** dark wheel cylinders (asphalt) + a metal hub stripe */
function wheels(g: VoxelGrid, zws: number[], span = 6): void {
  for (const zw of zws) {
    for (const [x0, x1] of [[0, 2], [15, 17]] as const) {
      fill(g, x0, 0, zw, x1, 4, zw + span - 1, MAT_ASPHALT)
      // rounded silhouette: trim the bottom corners
      fill(g, x0, 0, zw, x1, 0, zw, 0)
      fill(g, x0, 0, zw + span - 1, x1, 0, zw + span - 1, 0)
      fill(g, x0, 2, zw + 2, x1, 2, zw + span - 3, MAT_METAL) // hub
    }
  }
}

/** front/rear light bar accents (emissive MAT_LAMP) */
function lights(g: VoxelGrid, y: number, zFront: number, zRear: number): void {
  for (const z of [zFront, zRear]) {
    fill(g, 2, y, z, 4, y + 1, z, MAT_LAMP)
    fill(g, 13, y, z, 15, y + 1, z, MAT_LAMP)
  }
}

/** wheel arches: notch the body corners above each wheel */
function arches(g: VoxelGrid, yBody: number, zws: number[], span = 6): void {
  for (const zw of zws) {
    for (const [x0, x1] of [[1, 2], [15, 16]] as const) {
      fill(g, x0, yBody, zw, x1, yBody + 1, zw + span - 1, 0)
    }
  }
}

/** sedan: 1.8 m wide × 4.0 m long, 1.6 m tall — hood, glass cabin, trunk.
 * B31 — cabin raised (roof y13→15) so a seated 1.65 m driver clears the roof. */
function buildSedan(body: number): VoxelGrid {
  const g = makeGrid(18, 16, 40)
  fill(g, 1, 4, 1, 16, 8, 38, body)
  arches(g, 4, [5, 29])
  wheels(g, [5, 29])
  // cabin: glass greenhouse with body pillars + roof
  fill(g, 2, 9, 12, 15, 14, 31, MAT_GLASS)
  fill(g, 2, 9, 12, 15, 14, 13, body) // A pillars
  fill(g, 2, 9, 30, 15, 14, 31, body) // C pillars
  fill(g, 2, 15, 12, 15, 15, 31, body) // roof
  fill(g, 5, 5, 0, 12, 6, 0, MAT_METAL) // grille
  lights(g, 6, 0, 39)
  return g
}

/** pickup: cab up front, open bed with side walls + tailgate.
 * B31 — cab raised (roof y13→15) so a seated driver fits. */
function buildPickup(body: number): VoxelGrid {
  const g = makeGrid(18, 16, 42)
  fill(g, 1, 4, 1, 16, 7, 40, body) // chassis
  arches(g, 4, [5, 31])
  wheels(g, [5, 31])
  fill(g, 2, 8, 1, 15, 8, 9, body) // hood
  // cab
  fill(g, 2, 8, 10, 15, 14, 22, MAT_GLASS)
  fill(g, 2, 8, 10, 15, 14, 11, body)
  fill(g, 2, 8, 21, 15, 14, 22, body)
  fill(g, 2, 15, 10, 15, 15, 22, body)
  // bed walls + tailgate (interior stays open)
  fill(g, 1, 8, 23, 2, 9, 41, body)
  fill(g, 15, 8, 23, 16, 9, 41, body)
  fill(g, 1, 8, 40, 16, 9, 41, body)
  fill(g, 5, 5, 0, 12, 6, 0, MAT_METAL)
  lights(g, 6, 0, 41)
  return g
}

/** van: tall box, big windshield, side window band */
function buildVan(body: number): VoxelGrid {
  const g = makeGrid(18, 16, 44)
  fill(g, 1, 4, 1, 16, 14, 42, body)
  arches(g, 4, [6, 33])
  wheels(g, [6, 33])
  fill(g, 3, 9, 1, 14, 13, 1, MAT_GLASS) // windshield
  // side window band with pillars every 8 voxels
  for (const x of [1, 16]) {
    fill(g, x, 9, 10, x, 12, 40, MAT_GLASS)
    for (let z = 10; z <= 40; z += 8) fill(g, x, 9, z, x, 12, z, body)
  }
  fill(g, 2, 15, 4, 15, 15, 40, body) // roof cap
  fill(g, 5, 5, 0, 12, 6, 0, MAT_METAL)
  lights(g, 6, 0, 43)
  return g
}

const CAR_BUILDERS: Record<string, (body: number) => VoxelGrid> = {
  sedan: buildSedan,
  pickup: buildPickup,
  van: buildVan,
}

// ---- T51 furniture: chunky 10 cm-voxel pieces, wood/plaster/metal ---------

/** dining table 0.8×0.8 m: 4 legs + top at 0.5 m */
function buildTable(): VoxelGrid {
  const g = makeGrid(8, 6, 8)
  for (const [lx, lz] of [[0, 0], [7, 0], [0, 7], [7, 7]] as const) {
    fill(g, lx, 0, lz, lx, 3, lz, MAT_WOOD)
  }
  fill(g, 0, 4, 0, 7, 5, 7, MAT_WOOD)
  return g
}

/** chair: solid seat + backrest on the -z edge */
function buildChair(): VoxelGrid {
  const g = makeGrid(4, 10, 4)
  fill(g, 0, 0, 0, 3, 2, 3, MAT_WOOD) // seat block
  fill(g, 0, 3, 0, 3, 9, 0, MAT_WOOD) // backrest
  return g
}

/** bed 1.0×1.8 m: wood frame, plaster mattress, headboard at -z */
function buildBed(): VoxelGrid {
  const g = makeGrid(10, 9, 18)
  fill(g, 0, 0, 0, 9, 2, 17, MAT_WOOD) // frame
  fill(g, 0, 3, 1, 9, 4, 17, MAT_PLASTER) // mattress
  fill(g, 0, 3, 0, 9, 8, 0, MAT_WOOD) // headboard
  return g
}

/** kitchen counter 1.6×0.6 m: wood body, metal worktop */
function buildCounter(): VoxelGrid {
  const g = makeGrid(16, 9, 6)
  fill(g, 0, 0, 0, 15, 7, 5, MAT_WOOD)
  fill(g, 0, 8, 0, 15, 8, 5, MAT_METAL)
  return g
}

/** sofa 1.4×0.6 m: plaster cushions, back along -z, stub arms */
function buildSofa(): VoxelGrid {
  const g = makeGrid(14, 10, 6)
  fill(g, 0, 0, 0, 13, 4, 5, MAT_PLASTER) // base
  fill(g, 0, 5, 0, 13, 9, 1, MAT_PLASTER) // backrest
  fill(g, 0, 5, 2, 0, 7, 5, MAT_PLASTER) // arm left
  fill(g, 13, 5, 2, 13, 7, 5, MAT_PLASTER) // arm right
  return g
}

/** park bench 1.2 m: metal legs, wood seat + backrest along +z edge */
function buildBench(): VoxelGrid {
  const g = makeGrid(12, 9, 4)
  for (const lx of [1, 10]) fill(g, lx, 0, 0, lx, 2, 3, MAT_METAL)
  fill(g, 0, 3, 0, 11, 4, 2, MAT_WOOD) // seat
  fill(g, 0, 5, 3, 11, 8, 3, MAT_WOOD) // backrest
  return g
}

// ---- P14 two-wheelers: authored voxel frames for the ridable bicycle +
// delivery scooter props (physics wheels are added by vehicle.ts; the frame
// carries no wheel voxels). Footprints must match PROP_DIMS bicycle/scooter.
// vehicle.ts resolveArchetype reads THESE grids so the chassis and the parked
// prop are one model (single source of truth). --------------------------------

/** bicycle: thin metal frame, saddle + handlebar (0.4 × 1.3 × 1.8 m) */
export function buildBicycle(): VoxelGrid {
  const g = makeGrid(4, 13, 18)
  fill(g, 1, 4, 2, 2, 8, 3, MAT_METAL) // head tube / fork column
  fill(g, 1, 8, 2, 2, 9, 4, MAT_METAL) // stem
  fill(g, 0, 9, 2, 3, 9, 3, MAT_ASPHALT) // handlebar grips
  fill(g, 1, 4, 4, 2, 5, 14, MAT_METAL) // top/down tube spine
  fill(g, 1, 6, 12, 2, 8, 13, MAT_METAL) // seat post
  fill(g, 0, 9, 12, 3, 9, 14, MAT_ASPHALT) // saddle
  fill(g, 1, 4, 14, 2, 6, 15, MAT_METAL) // rear stay
  return g
}

/** delivery scooter: step-through frame + big rear topbox (0.6 × 1.4 × 2.0 m) */
export function buildScooter(): VoxelGrid {
  const g = makeGrid(6, 14, 20)
  const body = MAT_ROOFTILE // moped red
  fill(g, 1, 3, 1, 4, 4, 18, MAT_METAL) // floorboard / spine
  fill(g, 1, 4, 1, 4, 10, 3, body) // front apron
  fill(g, 2, 6, 1, 3, 6, 1, MAT_LAMP) // headlight
  fill(g, 0, 10, 1, 5, 10, 3, MAT_ASPHALT) // handlebar
  fill(g, 1, 5, 9, 4, 7, 14, body) // seat base
  fill(g, 0, 7, 9, 5, 8, 14, MAT_ASPHALT) // saddle
  fill(g, 0, 4, 15, 5, 9, 19, MAT_PLASTER) // delivery topbox
  return g
}

/** garden shed 2.2×1.8 m, 2 m tall: wood walls, flat roof, door on -z */
function buildShed(): VoxelGrid {
  const g = makeGrid(22, 20, 18)
  // walls (hollow interior)
  fill(g, 0, 0, 0, 21, 17, 17, MAT_WOOD)
  fill(g, 2, 0, 2, 19, 17, 15, 0)
  // flat roof cap with slight overhang implied by full cover
  fill(g, 0, 18, 0, 21, 19, 17, MAT_WOOD)
  // door opening on the -z face
  fill(g, 7, 0, 0, 14, 15, 1, 0)
  // tiny window on the +z face
  fill(g, 8, 8, 16, 13, 12, 17, MAT_GLASS)
  return g
}

/** kind → grid; keys match Prop.kind emitted by the layout generator */
export function placeholderProps(): Record<string, VoxelGrid> {
  const out: Record<string, VoxelGrid> = {
    table: buildTable(),
    chair: buildChair(),
    bed: buildBed(),
    counter: buildCounter(),
    sofa: buildSofa(),
    bench: buildBench(),
    shed: buildShed(),
    bicycle: buildBicycle(), // P14 — ridable two-wheelers
    scooter: buildScooter(),
  }
  for (const [arch, build] of Object.entries(CAR_BUILDERS)) {
    for (let c = 0; c < CAR_BODY_MATS.length; c++) {
      out[`${arch}${c}`] = build(CAR_BODY_MATS[c])
    }
  }
  return out
}
