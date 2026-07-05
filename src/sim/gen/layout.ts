/**
 * T19/T50 — procedural town layout. Pure function of seed (V2: Prng is the
 * only randomness source, no wall-clock). Emits a declarative, JSON-serializable
 * description — NO world writes (the stamper, T20, turns this into
 * ChunkStore edits).
 *
 * T50 (B11): the world is a 2048×2048 voxel (204.8 m) town split into
 * districts by a 5×5 road grid (arterial cross through the center, residential
 * elsewhere). The 4×4 blocks between roads carry districts:
 *
 *          x→  0..3
 *   z=0  row  row  com  com        row = rowhouse blocks (denser, 2-3 story)
 *   z=1  row  SUB  SUB  com        SUB = suburban core (spawn at the center
 *   z=2  row  SUB  SUB  com              arterial crossing, voxel 1024,1024)
 *   z=3  park park park sub        com = commercial: 5-15 story towers,
 *                                        plazas, parking lots
 *                                  park = meadows, tree clusters, paths, ponds
 *
 * Geometry: voxel coords (10 cm), footprint x,z ∈ [0,2048), ground surface
 * air starts at GROUND_Y (solid ground fills y ∈ [0, GROUND_Y-1]).
 * Rects/boxes are INCLUSIVE on both ends.
 *
 * Determinism convention (INTEGRATION-content.md): every feature system draws
 * from its own DERIVED Prng stream (seed ^ const ^ imul(id)), so adding
 * detail never reshuffles the base town or sibling features.
 */

import { Prng } from '../prng'
import { WORLD_VX, WORLD_VZ } from '../../world/chunks'
import { MAT_BRICK, MAT_PLASTER, MAT_ROOFTILE, MAT_WOOD } from '../materials'

export interface Rect {
  x0: number
  z0: number
  x1: number
  z1: number
}

export interface Box {
  x0: number
  y0: number
  z0: number
  x1: number
  y1: number
  z1: number
}

/** which wall of a footprint: face normal direction */
export type Side = 'x-' | 'x+' | 'z-' | 'z+'

export interface Road {
  /** axis the road runs along */
  axis: 'x' | 'z'
  center: number
  /** arterial roads (the central cross) are wider, different markings (T50) */
  kind: 'res' | 'arterial'
  asphalt: Rect
  sidewalks: [Rect, Rect]
}

export type DistrictKind = 'suburb' | 'rowhouse' | 'commercial' | 'park' | 'beach' | 'desert' | 'airport'

export interface District {
  bi: number
  bj: number
  kind: DistrictKind
  rect: Rect
}

export interface Lot {
  id: number
  rect: Rect
  /** side of the lot that touches its street */
  front: Side
}

export interface Opening {
  side: Side
  /** distance along the wall from its min corner (x0 or z0), voxels */
  offset: number
  /** story index, 0 = ground floor */
  floor: number
  w: number
  h: number
  /** height of the opening bottom above the story base */
  sill: number
}

/**
 * Interior straight-run stairs (T41). rect = footprint of the solid stepped
 * run; the stamper carves a matching opening in the upper-floor slab.
 * Rise/tread sized for the Jolt character step-climb (STAIR_RISE=2 voxels =
 * 0.2 m < 0.4 m default mWalkStairsStepUp). Houses use axis 'x'; rowhouse
 * units run their stairs along 'z' (T50).
 */
export interface Stairs {
  rect: Rect
  /** run axis */
  axis: 'x' | 'z'
  /** ascending direction along the axis */
  dir: 1 | -1
}

/**
 * T51 — interior partition wall (1 voxel thick, plaster) with a door gap.
 * axis = direction the wall RUNS. axis 'x': wall at z=c spanning x∈[a0,a1];
 * axis 'z': wall at x=c spanning z∈[a0,a1]. Door gap (DOOR_W wide) starts at
 * doorAt along the run axis.
 */
export interface Partition {
  floor: number
  axis: 'x' | 'z'
  c: number
  a0: number
  a1: number
  doorAt: number
}

export interface House {
  lotId: number
  rect: Rect
  /** optional single-story L extension on the back side */
  ell: Rect | null
  floors: number
  storyH: number
  wallMat: number
  roof: 'gable' | 'flat' | 'hip'
  ridgeAxis: 'x' | 'z'
  door: Opening
  windows: Opening[]
  driveway: Rect
  /** interior stairs to the upper floor; null for single-story houses */
  stairs: Stairs | null
  /** gable/hip roof material (MAT_WOOD or MAT_ROOFTILE); flat roofs stay concrete */
  roofMat: number
  /** driveway surface: plain concrete or subtle paver tiles (B12) */
  driveMat: 'concrete' | 'paver'
  /** concrete stoop in front of the door with posts + small awning */
  porch: Rect | null
  /** wood shutters flanking front-wall windows */
  shutters: boolean
  /** garden paver path: front lot edge → door (or porch) */
  path: Rect
  /** T51 — attached garage beside the house (driveway side), null if none */
  garage: Rect | null
  /** T59 — roll-door up (open, ~half) or down (metal door stamped) */
  garageOpen: boolean
  /** T59 — worn lawn patches (dirt ellipses) for a lived-in look */
  wornPatches: { x: number; z: number; r: number }[]
  /** T51 — 2nd-floor balcony over the front door (2-story houses only) */
  balcony: Rect | null
  /** balcony access: door-sized opening on floor 1 (carved to air) */
  balconyDoor: Opening | null
  /** T51 — brick chimney (3×3 column through the roof ridge), null if none */
  chimney: { x: number; z: number } | null
  /** T51 — interior room partition walls (2-4 rooms per floor) */
  partitions: Partition[]
  /** T51 — backyard paver patio against the back wall */
  patio: Rect | null
  /** T51 — raised garden beds (dirt + wood border + leaf rows) */
  gardens: Rect[]
  /** T51 — backyard shed footprint (stamped as a 'shed' prop), null if none */
  shed: Rect | null
}

export interface Pool {
  lotId: number
  /** interior basin volume (dug to air, lined with concrete around it) */
  basin: Box
  /**
   * B19 — optional shallow-end refill: this sub-volume is re-filled with
   * concrete after digging, raising the floor (villa pool shallow half)
   */
  shallow?: Box
}

/**
 * B19 — showcase villa on the spawn-closest lot: bigger 2-story house, large
 * two-depth pool, paver deck, and a cabana. First thing the player sees.
 */
export interface Villa {
  lotId: number
  /** paver pool-deck apron around the basin */
  deck: Rect
  /** pool house footprint */
  cabana: Rect
  /** open side of the cabana (faces the pool) */
  cabanaFront: Side
}

/**
 * T50 — rowhouse block: one long building of party-walled units facing the
 * street. Units vary in height (stepped rooflines) and wall material.
 */
export interface RowUnit {
  x0: number
  x1: number
  floors: number
  wallMat: number
}

export interface RowBlock {
  id: number
  /** building footprint (all units) */
  rect: Rect
  front: 'z-' | 'z+'
  storyH: number
  units: RowUnit[]
}

/**
 * T50 — commercial tower: concrete frame + glass curtain walls + metal
 * mullions, interior floor slabs, and an explorable concrete core holding a
 * switch-direction stair run and an open elevator shaft (full-height void
 * with per-floor door openings — mind the drop).
 */
export interface Tower {
  id: number
  rect: Rect
  floors: number
  storyH: number
  /** side carrying the ground-floor entrance */
  front: Side
  /** stair+elevator core outer box (concrete walls WALL_T thick) */
  core: Rect
  /** straight stair run footprint (axis x, dir alternates per floor) */
  stairs: Rect
  /** elevator shaft interior (void from ground slab to roof) */
  shaft: Rect
  /** side of the core the per-floor doors face */
  coreDoor: 'z-' | 'z+'
  /** vertical glass mullion spacing (voxels) */
  mullion: number
}

export interface ParkingLot {
  rect: Rect
}

/** T50 — park pond: union of dug ellipse lobes, filled via waterFills */
export interface Pond {
  lobes: { x: number; z: number; rx: number; rz: number }[]
  depth: number
  /** water fill volume (bounding box; solids inside are skipped by the CA) */
  box: Box
}

/** T69 — south-edge beach/ocean strip. Sand/boardwalk are stamped into world;
 * ocean is returned as a water fill so it uses the same CA/render path. */
export interface Beach {
  rect: Rect
  sand: Rect
  boardwalk: Rect
  ocean: Box
}

/**
 * T42 — vegetation. Trunk base at (x,z) (2×2 voxels), blobby leaf canopy on
 * top; per-tree seed drives canopy blob variation in the stamper. Trees are
 * plain voxels (MAT_WOOD/MAT_LEAVES) — destructible, felled by connectivity.
 */
export interface Tree {
  x: number
  z: number
  /** trunk height in voxels above ground */
  trunkH: number
  /** main canopy blob radius, voxels */
  canopyR: number
  /** per-tree seed for canopy variation (derived from world seed) */
  seed: number
}

/** small leaf clump (foundation planting) */
export interface Shrub {
  x: number
  z: number
  r: number
  seed: number
}

/**
 * T43 — street/yard detail. FenceLine is an axis-aligned 1-voxel-wide picket
 * fence segment (gate gaps at driveways/paths are pre-split by the generator).
 */
export interface FenceLine {
  x0: number
  z0: number
  x1: number
  z1: number
}

export interface Lamp {
  x: number
  z: number
  /** direction the arm + lamp head point (toward the road) */
  dir: Side
}

export interface Mailbox {
  x: number
  z: number
  /** T59 — 0 = wood post, 1 = brick pedestal */
  style: 0 | 1
}

export interface Bin {
  x: number
  z: number
}

export interface Prop {
  /** voxel-grid kinds: cars, furniture (T51), benches, sheds — see props.ts */
  kind: string
  x: number
  y: number
  z: number
  /** quarter-turns around +y */
  rot: 0 | 1 | 2 | 3
}

export interface Layout {
  seed: number
  /** first air y above the ground slab */
  groundY: number
  roads: Road[]
  districts: District[]
  lots: Lot[]
  houses: House[]
  pools: Pool[]
  villa: Villa
  rowBlocks: RowBlock[]
  towers: Tower[]
  parking: ParkingLot[]
  plazas: Rect[]
  ponds: Pond[]
  beaches: Beach[]
  parkPaths: Rect[]
  props: Prop[]
  trees: Tree[]
  shrubs: Shrub[]
  fences: FenceLine[]
  lamps: Lamp[]
  mailboxes: Mailbox[]
  bins: Bin[]
}

export const GROUND_Y = 48 // 4.8 m — within the y≈40..64 ground band
export const STORY_H = 26 // 2.6 m
export const WALL_T = 2 // 20 cm walls

/** player spawn: the central arterial crossing (T50 — world center) */
export const SPAWN_VX = WORLD_VX >> 1
export const SPAWN_VZ = WORLD_VZ >> 1

const BLOCK_PITCH = 416 // road-center spacing (unchanged from the T50 grid)
const GRID_MARGIN = 240 // nature/beach band left outside the outermost road
/** road centers, generated to fill the world centered on the spawn arterial
 * (SPAWN_VX). Odd count → the middle road is the arterial. Scales with
 * WORLD_VX automatically (B32: 5 roads @2048 → 9 roads @4096). */
function buildRoadCenters(): number[] {
  const half = Math.floor((SPAWN_VX - GRID_MARGIN) / BLOCK_PITCH)
  const c: number[] = []
  for (let i = -half; i <= half; i++) c.push(SPAWN_VX + i * BLOCK_PITCH)
  return c
}
const ROAD_CENTERS = buildRoadCenters()
/** block count per axis (blocks sit between adjacent road centers) */
const BLOCKS = ROAD_CENTERS.length - 1
const ROAD_HALF_RES = 30 // residential asphalt 6 m wide
const ROAD_HALF_ART = 40 // arterial asphalt 8 m wide (T50)
const WALK_W = 12 // 1.2 m sidewalks
const RES_EXTENT = ROAD_HALF_RES + WALK_W // 42
const ART_EXTENT = ROAD_HALF_ART + WALK_W // 52
const LOT_GAP = 4
const SIDE_SETBACK = 12
const FRONT_SETBACK = 48 // 4.8 m — driveway length

export const DOOR_W = 9
export const DOOR_H = 21
const WIN_SILL = 10
const DRIVE_W = 20
export const POOL_DEPTH = 14

// stairs (T41): riser 2 voxels (0.2 m — under Jolt's 0.4 m step-climb),
// tread 3 voxels deep, run width 9 (0.9 m > capsule diameter 0.6 m)
export const STAIR_RISE = 2
export const STAIR_TREAD = 3
export const STAIR_W = 9
export const STAIR_STEPS = STORY_H / STAIR_RISE // 13, integer by construction
export const STAIR_RUN = STAIR_STEPS * STAIR_TREAD // 39

// commercial towers (T50): 3 m stories, same riser/tread → 15-step runs
export const TOWER_STORY_H = 30
export const TOWER_STAIR_STEPS = TOWER_STORY_H / STAIR_RISE // 15
export const TOWER_STAIR_RUN = TOWER_STAIR_STEPS * STAIR_TREAD // 45

// T59 — car archetypes × 3 body colors (kind = `${arch}${color}`, props.ts)
export const CAR_ARCHS = ['sedan', 'pickup', 'van'] as const
const CAR_DIMS: Record<string, readonly [number, number]> = { sedan: [18, 40], pickup: [18, 42], van: [18, 44] }

export function isCarKind(kind: string): boolean {
  return /^(sedan|pickup|van)\d$/.test(kind)
}

// T51 — prop footprints (x × z voxels, unrotated). Single authority shared by
// layout placement, props.ts grid builders, and tests.
export const PROP_DIMS: Record<string, readonly [number, number]> = {
  table: [8, 8],
  chair: [4, 4],
  bed: [10, 18],
  counter: [16, 6],
  sofa: [14, 6],
  bench: [12, 4],
  shed: [22, 18],
  ...Object.fromEntries(CAR_ARCHS.flatMap((a) => [0, 1, 2].map((c) => [`${a}${c}`, CAR_DIMS[a]]))),
}

/** axis-aligned footprint of a prop instance (rot swaps the axes) */
export function propRect(p: Prop): Rect {
  const [sx, sz] = PROP_DIMS[p.kind]
  const [w, d] = p.rot % 2 === 0 ? [sx, sz] : [sz, sx]
  return { x0: p.x, z0: p.z, x1: p.x + w - 1, z1: p.z + d - 1 }
}

/** tree size archetypes (T42): base height/radius + variation range */
const TREE_ARCH = [
  { h0: 12, hv: 5, r0: 6, rv: 3 }, // small
  { h0: 18, hv: 6, r0: 9, rv: 3 }, // medium
  { h0: 26, hv: 7, r0: 12, rv: 3 }, // large
] as const

const GOLD = 0x9e3779b9

function growRect(r: Rect, by: number): Rect {
  return { x0: r.x0 - by, z0: r.z0 - by, x1: r.x1 + by, z1: r.z1 + by }
}

function rectsTouch(a: Rect, b: Rect): boolean {
  return a.x0 <= b.x1 && a.x1 >= b.x0 && a.z0 <= b.z1 && a.z1 >= b.z0
}

/** squared distance from a point to a rect (0 when inside) */
function rectDist2(r: Rect, x: number, z: number): number {
  const dx = x < r.x0 ? r.x0 - x : x > r.x1 ? x - r.x1 : 0
  const dz = z < r.z0 ? r.z0 - z : z > r.z1 ? z - r.z1 : 0
  return dx * dx + dz * dz
}

function roadHalfAt(i: number): number {
  return ROAD_CENTERS[i] === SPAWN_VX ? ROAD_HALF_ART : ROAD_HALF_RES
}

function roadExtentAt(i: number): number {
  return roadHalfAt(i) + WALK_W
}

function makeRoads(): Road[] {
  const roads: Road[] = []
  for (let i = 0; i < ROAD_CENTERS.length; i++) {
    const c = ROAD_CENTERS[i]
    const half = roadHalfAt(i)
    const ext = half + WALK_W
    const kind: Road['kind'] = c === SPAWN_VX ? 'arterial' : 'res'
    // runs along x at constant z
    roads.push({
      axis: 'x',
      center: c,
      kind,
      asphalt: { x0: 0, z0: c - half, x1: WORLD_VX - 1, z1: c + half },
      sidewalks: [
        { x0: 0, z0: c - ext, x1: WORLD_VX - 1, z1: c - half - 1 },
        { x0: 0, z0: c + half + 1, x1: WORLD_VX - 1, z1: c + ext },
      ],
    })
    // runs along z at constant x
    roads.push({
      axis: 'z',
      center: c,
      kind,
      asphalt: { x0: c - half, z0: 0, x1: c + half, z1: WORLD_VZ - 1 },
      sidewalks: [
        { x0: c - ext, z0: 0, x1: c - half - 1, z1: WORLD_VZ - 1 },
        { x0: c + half + 1, z0: 0, x1: c + ext, z1: WORLD_VZ - 1 },
      ],
    })
  }
  return roads
}

/** T50 downtown core — the 4×4 plan, kept centered on the spawn arterial (B32) */
const CORE_MAP: DistrictKind[][] = [
  ['rowhouse', 'rowhouse', 'commercial', 'commercial'],
  ['rowhouse', 'suburb', 'suburb', 'commercial'],
  ['rowhouse', 'suburb', 'suburb', 'commercial'],
  ['park', 'park', 'park', 'suburb'],
]

function blockRect(bi: number, bj: number): Rect {
  return {
    x0: ROAD_CENTERS[bi] + roadExtentAt(bi) + 1,
    x1: ROAD_CENTERS[bi + 1] - roadExtentAt(bi + 1) - 1,
    z0: ROAD_CENTERS[bj] + roadExtentAt(bj) + 1,
    z1: ROAD_CENTERS[bj + 1] - roadExtentAt(bj + 1) - 1,
  }
}

/** first block index of the central 4×4 core (per axis) */
const CORE_LO = (BLOCKS >> 1) - 2

/**
 * District kind for block (bi,bj). The CORE_MAP fills the central 4×4 downtown;
 * the surrounding ring is parkland/nature by default. Named outer districts
 * (desert trailer park, airport) are carved out by corner/edge rules (B32);
 * the coast (beach) is the south margin strip, added in makeDistricts.
 */
function districtKindAt(bi: number, bj: number): DistrictKind {
  const hi = CORE_LO + 3
  if (bi >= CORE_LO && bi <= hi && bj >= CORE_LO && bj <= hi) {
    return CORE_MAP[bj - CORE_LO][bi - CORE_LO]
  }
  const last = BLOCKS - 1
  // desert trailer park — north-east corner (2×2)
  if (bi >= last - 1 && bj <= 1) return 'desert'
  // airport — a long flat apron on the west edge (1 block wide × 3 tall)
  if (bi === 0 && bj >= CORE_LO && bj <= CORE_LO + 2) return 'airport'
  return 'park'
}

function makeDistricts(): District[] {
  const out: District[] = []
  for (let bj = 0; bj < BLOCKS; bj++) {
    for (let bi = 0; bi < BLOCKS; bi++) {
      out.push({ bi, bj, kind: districtKindAt(bi, bj), rect: blockRect(bi, bj) })
    }
  }
  const li = ROAD_CENTERS.length - 1
  out.push({
    bi: -1,
    bj: BLOCKS,
    kind: 'beach',
    rect: {
      x0: 0,
      z0: ROAD_CENTERS[li] + roadExtentAt(li) + 1,
      x1: WORLD_VX - 1,
      z1: WORLD_VZ - 1,
    },
  })
  return out
}

/** suburb blocks split into 2×2 lots, fronts facing their nearest x-road */
function makeLots(districts: District[]): Lot[] {
  const lots: Lot[] = []
  let id = 0
  for (const d of districts) {
    if (d.kind !== 'suburb') continue
    const { x0: bx0, z0: bz0, x1: bx1, z1: bz1 } = d.rect
    const mx = (bx0 + bx1) >> 1
    const mz = (bz0 + bz1) >> 1
    const halves: [Rect, Side][] = [
      [{ x0: bx0 + LOT_GAP, z0: bz0 + LOT_GAP, x1: mx - LOT_GAP, z1: mz - LOT_GAP }, 'z-'],
      [{ x0: mx + LOT_GAP, z0: bz0 + LOT_GAP, x1: bx1 - LOT_GAP, z1: mz - LOT_GAP }, 'z-'],
      [{ x0: bx0 + LOT_GAP, z0: mz + LOT_GAP, x1: mx - LOT_GAP, z1: bz1 - LOT_GAP }, 'z+'],
      [{ x0: mx + LOT_GAP, z0: mz + LOT_GAP, x1: bx1 - LOT_GAP, z1: bz1 - LOT_GAP }, 'z+'],
    ]
    for (const [rect, front] of halves) lots.push({ id: id++, rect, front })
  }
  return lots
}

/** windows along one wall: every ~spacing voxels, ≥14 from ends, skipping the door span on the front */
function wallWindows(
  side: Side,
  wallLen: number,
  floors: number,
  door: Opening | null,
  winW: number,
  winH: number,
  sill: number,
  spacing: number,
): Opening[] {
  const out: Opening[] = []
  for (let floor = 0; floor < floors; floor++) {
    for (let off = 14; off + winW <= wallLen - 14; off += spacing) {
      if (door && floor === 0 && side === door.side && off + winW >= door.offset - 3 && off <= door.offset + door.w + 3) {
        continue
      }
      out.push({ side, offset: off, floor, w: winW, h: winH, sill })
    }
  }
  return out
}

/**
 * Deterministic forced pool for the pool guarantee: behind the house with a
 * shrinking size ladder; if the backyard is blocked (deep L extension/patio),
 * a small plunge pool in the front-yard corner opposite the driveway — that
 * region is fixed geometry (48-voxel setback) so SOME basin always fits.
 * biasX shifts the basin toward that world x (spawn side) instead of
 * centering, which keeps the spawn-lot pool close to the road crossing.
 */
function forcePoolBasin(lot: Lot, h: House, biasX?: number): Box {
  const frontZneg = lot.front === 'z-'
  const lotW = lot.rect.x1 - lot.rect.x0 + 1
  const poolX0 = (pw: number): number => {
    if (biasX === undefined) return lot.rect.x0 + ((lotW - pw) >> 1)
    return biasX > lot.rect.x0 + (lotW >> 1) ? lot.rect.x1 - 8 - pw + 1 : lot.rect.x0 + 8
  }
  for (const [pw, pd] of [
    [40, 24],
    [32, 20],
    [24, 16],
  ] as const) {
    const backEdge = frontZneg
      ? Math.max(h.rect.z1, h.ell ? h.ell.z1 : 0, h.patio ? h.patio.z1 : 0) + 8
      : Math.min(h.rect.z0, h.ell ? h.ell.z0 : WORLD_VZ, h.patio ? h.patio.z0 : WORLD_VZ) - 8
    const px0 = poolX0(pw)
    if (frontZneg && backEdge + pd - 1 <= lot.rect.z1 - 8) {
      return { x0: px0, y0: GROUND_Y - POOL_DEPTH, z0: backEdge, x1: px0 + pw - 1, y1: GROUND_Y - 1, z1: backEdge + pd - 1 }
    }
    if (!frontZneg && backEdge - pd + 1 >= lot.rect.z0 + 8) {
      return { x0: px0, y0: GROUND_Y - POOL_DEPTH, z0: backEdge - pd + 1, x1: px0 + pw - 1, y1: GROUND_Y - 1, z1: backEdge }
    }
  }
  // front-yard plunge pool, on the side of the path away from the driveway
  const pw = 24
  const pd = 14
  const driveRight = h.driveway.x0 > h.path.x1
  const px0 = driveRight ? lot.rect.x0 + 8 : lot.rect.x1 - 8 - pw + 1
  const pz0 = frontZneg ? lot.rect.z0 + 8 : lot.rect.z1 - 8 - pd + 1
  return { x0: px0, y0: GROUND_Y - POOL_DEPTH, z0: pz0, x1: px0 + pw - 1, y1: GROUND_Y - 1, z1: pz0 + pd - 1 }
}

/**
 * T51 — interior partitions: one cross wall (axis x) splitting front/back,
 * plus 0-2 walls (axis z) splitting front and/or back halves → 2-4 rooms per
 * floor. All walls dodge the stair run and keep DOOR_W gaps.
 */
function makePartitions(h: { rect: Rect; floors: number; stairs: Stairs | null }, front: Side, it: Prng): Partition[] {
  const out: Partition[] = []
  const r = h.rect
  const ix0 = r.x0 + WALL_T
  const ix1 = r.x1 - WALL_T
  const iz0 = r.z0 + WALL_T
  const iz1 = r.z1 - WALL_T
  const wI = ix1 - ix0 + 1
  const dI = iz1 - iz0 + 1
  if (wI < 30 || dI < 30) return out
  const s = h.stairs
  for (let floor = 0; floor < h.floors; floor++) {
    // cross wall in the middle third of the depth (stairs hug the back wall)
    const third = Math.max(1, (dI / 3) | 0)
    const c = iz0 + third + it.nextInt(third)
    const doorAt = ix0 + 4 + it.nextInt(Math.max(1, wI - 8 - DOOR_W))
    out.push({ floor, axis: 'x', c, a0: ix0, a1: ix1, doorAt })
    // splitting walls: pick sides via one unconditional draw (stream stability)
    const mode = it.nextInt(10)
    const cB = ix0 + (wI >> 1) + 4 + it.nextInt(Math.max(1, (wI >> 2) - 6))
    const doorB = it.nextInt(1 << 30)
    const stairsBlock = (x: number): boolean => (s ? x >= s.rect.x0 - 2 && x <= s.rect.x1 + 2 : false)
    const backA0 = front === 'z-' ? c + 1 : iz0
    const backA1 = front === 'z-' ? iz1 : c - 1
    const frontA0 = front === 'z-' ? iz0 : c + 1
    const frontA1 = front === 'z-' ? c - 1 : iz1
    // stairs sit against the back wall — a back-half splitter must dodge them;
    // pick the half opposite the stair run when they collide
    let cSafe = cB
    if (stairsBlock(cSafe) && s) {
      cSafe = s.dir === 1 ? Math.min(ix1 - 6, s.rect.x1 + 4) : Math.max(ix0 + 6, s.rect.x0 - 4)
      if (stairsBlock(cSafe)) cSafe = -1
    }
    if (mode < 4 && cSafe > 0 && backA1 - backA0 >= 14) {
      out.push({ floor, axis: 'z', c: cSafe, a0: backA0, a1: backA1, doorAt: backA0 + 2 + (doorB % Math.max(1, backA1 - backA0 - 2 - DOOR_W)) })
    } else if (mode < 8 && frontA1 - frontA0 >= 14) {
      out.push({ floor, axis: 'z', c: cB, a0: frontA0, a1: frontA1, doorAt: frontA0 + 2 + (doorB % Math.max(1, frontA1 - frontA0 - 2 - DOOR_W)) })
    }
  }
  return out
}

/** partition wall footprint as a rect (for furniture keep-out) */
function partitionRect(p: Partition): Rect {
  return p.axis === 'x' ? { x0: p.a0, z0: p.c, x1: p.a1, z1: p.c } : { x0: p.c, z0: p.a0, x1: p.c, z1: p.a1 }
}

/**
 * T51 — voxel furniture as props: try-place items per floor with keep-outs
 * (stairs, partitions, door approach, other furniture). Deterministic
 * attempt loop on the per-lot interior stream.
 */
function placeFurniture(
  h: { rect: Rect; floors: number; storyH: number; stairs: Stairs | null; partitions: Partition[]; door: Opening },
  front: Side,
  it: Prng,
  props: Prop[],
): void {
  const r = h.rect
  const ix0 = r.x0 + WALL_T
  const ix1 = r.x1 - WALL_T
  const iz0 = r.z0 + WALL_T
  const iz1 = r.z1 - WALL_T
  const doorCx = r.x0 + h.door.offset + (h.door.w >> 1)
  for (let floor = 0; floor < h.floors; floor++) {
    const keep: Rect[] = []
    if (h.stairs) keep.push(growRect(h.stairs.rect, 2))
    for (const p of h.partitions) if (p.floor === floor) keep.push(growRect(partitionRect(p), 1))
    if (floor === 0) {
      // clear approach inside the front door
      keep.push(
        front === 'z-'
          ? { x0: doorCx - 6, z0: iz0, x1: doorCx + 6, z1: iz0 + 11 }
          : { x0: doorCx - 6, z0: iz1 - 11, x1: doorCx + 6, z1: iz1 },
      )
    }
    const wish: { kind: string; rot: 0 | 1 | 2 | 3 }[] =
      floor === 0
        ? [
            { kind: 'counter', rot: 0 },
            { kind: 'table', rot: 0 },
            { kind: 'chair', rot: it.nextInt(4) as 0 | 1 | 2 | 3 },
            { kind: 'chair', rot: it.nextInt(4) as 0 | 1 | 2 | 3 },
            { kind: 'sofa', rot: front === 'z-' ? 0 : 2 },
          ]
        : [
            { kind: 'bed', rot: front === 'z-' ? 2 : 0 },
            { kind: 'bed', rot: front === 'z-' ? 2 : 0 },
            { kind: 'chair', rot: it.nextInt(4) as 0 | 1 | 2 | 3 },
          ]
    const y = GROUND_Y + floor * h.storyH + 1
    for (const w of wish) {
      const [sx, sz] = PROP_DIMS[w.kind]
      const [fw, fd] = w.rot % 2 === 0 ? [sx, sz] : [sz, sx]
      for (let attempt = 0; attempt < 6; attempt++) {
        const px = ix0 + 1 + it.nextInt(Math.max(1, ix1 - ix0 - fw - 1))
        const pz = iz0 + 1 + it.nextInt(Math.max(1, iz1 - iz0 - fd - 1))
        const rect: Rect = { x0: px, z0: pz, x1: px + fw - 1, z1: pz + fd - 1 }
        if (keep.some((k) => rectsTouch(rect, k))) continue
        props.push({ kind: w.kind, x: px, y, z: pz, rot: w.rot })
        keep.push(growRect(rect, 1))
        break
      }
    }
  }
}

/** T50 — rowhouse blocks: two unit rows per block facing z- / z+ streets */
function makeRowBlocks(seed: number, districts: District[], fences: FenceLine[], trees: Tree[]): RowBlock[] {
  const blocks: RowBlock[] = []
  let id = 0
  for (const d of districts) {
    if (d.kind !== 'rowhouse') continue
    const rp = new Prng((seed ^ 0x27d4eb2f ^ Math.imul(d.bi * 4 + d.bj + 1, GOLD)) >>> 0)
    const rowRects: Rect[] = []
    for (const front of ['z-', 'z+'] as const) {
      const depth = 84 + rp.nextInt(17)
      const setback = 16 + rp.nextInt(9)
      const rect: Rect =
        front === 'z-'
          ? { x0: d.rect.x0 + 10, z0: d.rect.z0 + setback, x1: d.rect.x1 - 10, z1: d.rect.z0 + setback + depth - 1 }
          : { x0: d.rect.x0 + 10, z0: d.rect.z1 - setback - depth + 1, x1: d.rect.x1 - 10, z1: d.rect.z1 - setback }
      const rowW = rect.x1 - rect.x0 + 1
      const n = 4 + rp.nextInt(2)
      const base = (rowW / n) | 0
      const units: RowUnit[] = []
      let x = rect.x0
      for (let u = 0; u < n; u++) {
        const w = u === n - 1 ? rect.x1 - x + 1 : base
        units.push({
          x0: x,
          x1: x + w - 1,
          floors: 2 + (rp.nextInt(10) < 4 ? 1 : 0),
          wallMat: rp.nextInt(2) === 0 ? MAT_BRICK : MAT_PLASTER,
        })
        x += w
      }
      blocks.push({ id: id++, rect, front, storyH: STORY_H, units })
      rowRects.push(rect)
      // backyard divider fences at unit boundaries (toward the mid gap)
      for (let u = 1; u < n; u++) {
        const fx = units[u].x0
        if (front === 'z-') fences.push({ x0: fx, z0: rect.z1 + 1, x1: fx, z1: rect.z1 + 20 })
        else fences.push({ x0: fx, z0: rect.z0 - 20, x1: fx, z1: rect.z0 - 1 })
      }
    }
    // a few trees in the mid-block garden band
    const gz0 = rowRects[0].z1 + 24
    const gz1 = rowRects[1].z0 - 24
    if (gz1 > gz0) {
      const want = 2 + rp.nextInt(3)
      for (let t = 0; t < want; t++) {
        const arch = TREE_ARCH[rp.nextInt(2)]
        trees.push({
          x: d.rect.x0 + 20 + rp.nextInt(d.rect.x1 - d.rect.x0 - 40),
          z: gz0 + rp.nextInt(Math.max(1, gz1 - gz0)),
          trunkH: arch.h0 + rp.nextInt(arch.hv),
          canopyR: arch.r0 + rp.nextInt(arch.rv),
          seed: rp.nextU32(),
        })
      }
    }
  }
  return blocks
}

/** front side for a commercial block: face an arterial when adjacent */
function commercialFront(d: District): Side {
  if (d.bi === 1) return 'x+'
  if (d.bi === 2) return 'x-'
  if (d.bj === 1) return 'z+'
  if (d.bj === 2) return 'z-'
  return d.bj < 2 ? 'z+' : 'z-'
}

/** stall geometry shared by layout (car placement) and stamper (paint lines) */
export const STALL_W = 26
export const STALL_D = 48

function makeTower(id: number, rect: Rect, floors: number, front: Side): Tower {
  // core against the wall opposite the block front (or z+ default for x fronts)
  const coreAtZ1 = front !== 'z+'
  const coreDoor: 'z-' | 'z+' = coreAtZ1 ? 'z-' : 'z+'
  // core inner: stair run 45×9 + corridor 7 deep + shaft 14 wide at the x+ end
  const innerW = TOWER_STAIR_RUN + 4 + 14 // 63
  const innerD = STAIR_W + 7 // 16
  const cx0 = rect.x0 + (((rect.x1 - rect.x0 + 1 - innerW - 2 * WALL_T) >> 1) + WALL_T)
  const core: Rect = coreAtZ1
    ? { x0: cx0 - WALL_T, z0: rect.z1 - WALL_T - innerD - WALL_T * 2 + 1, x1: cx0 + innerW + WALL_T - 1, z1: rect.z1 - WALL_T }
    : { x0: cx0 - WALL_T, z0: rect.z0 + WALL_T, x1: cx0 + innerW + WALL_T - 1, z1: rect.z0 + WALL_T + innerD + WALL_T * 2 - 1 }
  const iz0 = core.z0 + WALL_T
  const iz1 = core.z1 - WALL_T
  // stairs band hugs the core wall away from the door; corridor on the door side
  const stairs: Rect = coreAtZ1
    ? { x0: cx0, z0: iz1 - STAIR_W + 1, x1: cx0 + TOWER_STAIR_RUN - 1, z1: iz1 }
    : { x0: cx0, z0: iz0, x1: cx0 + TOWER_STAIR_RUN - 1, z1: iz0 + STAIR_W - 1 }
  const shaft: Rect = { x0: cx0 + TOWER_STAIR_RUN + 4, z0: iz0, x1: cx0 + innerW - 1, z1: iz1 }
  return { id, rect, floors, storyH: TOWER_STORY_H, front, core, stairs, shaft, coreDoor, mullion: 0 }
}

interface CommercialOut {
  towers: Tower[]
  parking: ParkingLot[]
  plazas: Rect[]
  props: Prop[]
  lamps: Lamp[]
}

/** T50 — commercial blocks: 1-2 towers on the front side + rear parking lot */
function makeCommercial(seed: number, districts: District[]): CommercialOut {
  const out: CommercialOut = { towers: [], parking: [], plazas: [], props: [], lamps: [] }
  let id = 0
  for (const d of districts) {
    if (d.kind !== 'commercial') continue
    const cp = new Prng((seed ^ 0x165667b1 ^ Math.imul(d.bi * 4 + d.bj + 1, GOLD)) >>> 0)
    const front = commercialFront(d)
    const bw = d.rect.x1 - d.rect.x0 + 1
    const bd = d.rect.z1 - d.rect.z0 + 1
    const tw = 110 + cp.nextInt(51)
    const td = 110 + cp.nextInt(41)
    const floors = 5 + cp.nextInt(11)
    const mullion = 10 + cp.nextInt(5) // 10-14
    // towers sit on the z- half; parking fills the z+ remainder (front side
    // only flips which z edge if the block fronts z+)
    const frontZplus = front === 'z+'
    const tz0 = frontZplus ? d.rect.z1 - 16 - td + 1 : d.rect.z0 + 16
    const tx0 = d.rect.x0 + 16 + cp.nextInt(Math.max(1, bw - tw - 32))
    const t1 = makeTower(id++, { x0: tx0, z0: tz0, x1: tx0 + tw - 1, z1: tz0 + td - 1 }, floors, front)
    t1.mullion = mullion
    out.towers.push(t1)
    // optional twin tower at the opposite x end of the front row
    const twin = cp.nextInt(10) < 4
    const w2 = 95 + cp.nextInt(16)
    const d2 = 100 + cp.nextInt(31)
    const f2 = 5 + cp.nextInt(4)
    if (twin) {
      const leftRoom = tx0 - d.rect.x0 - 16
      const rightRoom = d.rect.x1 - (tx0 + tw - 1) - 16
      const putLeft = leftRoom >= rightRoom
      const room = Math.max(leftRoom, rightRoom)
      if (room >= w2 + 12) {
        const x2 = putLeft ? tx0 - 12 - w2 : tx0 + tw + 12
        const z2 = frontZplus ? d.rect.z1 - 16 - d2 + 1 : d.rect.z0 + 16
        const t2 = makeTower(id++, { x0: x2, z0: z2, x1: x2 + w2 - 1, z1: z2 + d2 - 1 }, f2, front)
        t2.mullion = mullion
        out.towers.push(t2)
      }
    }
    // plaza apron: concrete surface across the tower row
    const rowZ1 = frontZplus ? d.rect.z1 - 8 : tz0 + Math.max(td, twin ? d2 : 0) + 10
    const rowZ0 = frontZplus ? Math.min(tz0, twin ? d.rect.z1 - 16 - d2 + 1 : tz0) - 10 : d.rect.z0 + 8
    out.plazas.push({ x0: d.rect.x0 + 8, z0: rowZ0, x1: d.rect.x1 - 8, z1: rowZ1 })
    // parking lot on the remaining band
    const pz0 = frontZplus ? d.rect.z0 + 8 : rowZ1 + 6
    const pz1 = frontZplus ? rowZ0 - 6 : d.rect.z1 - 8
    if (pz1 - pz0 + 1 >= 2 * STALL_D + 24) {
      const lot: Rect = { x0: d.rect.x0 + 10, z0: pz0, x1: d.rect.x1 - 10, z1: pz1 }
      out.parking.push({ rect: lot })
      // parked cars in ~45% of stalls, both rows, facing the aisle
      const stalls = ((lot.x1 - lot.x0 + 1 - 8) / STALL_W) | 0
      for (let row = 0; row < 2; row++) {
        for (let i = 0; i < stalls; i++) {
          const roll = cp.nextInt(100)
          const kind = `${CAR_ARCHS[cp.nextInt(3)]}${cp.nextInt(3)}` // T59 variety
          if (roll >= 45) continue
          const x = lot.x0 + 4 + i * STALL_W + 4
          const z = row === 0 ? lot.z0 + 4 : lot.z1 - 4 - PROP_DIMS[kind][1] + 1
          out.props.push({ kind, x, y: GROUND_Y, z, rot: row === 0 ? 2 : 0 })
        }
      }
      // lot lighting along the center aisle
      const midZ = (lot.z0 + lot.z1) >> 1
      for (let k = 0; k < 3; k++) {
        out.lamps.push({ x: lot.x0 + 30 + k * (((lot.x1 - lot.x0 - 60) / 2) | 0), z: midZ, dir: k % 2 === 0 ? 'z-' : 'z+' })
      }
    }
  }
  return out
}

interface ParkOut {
  ponds: Pond[]
  parkPaths: Rect[]
  props: Prop[]
  trees: Tree[]
  lamps: Lamp[]
}

function makeBeaches(): Beach[] {
  const d = makeDistricts().find((d) => d.kind === 'beach')
  if (!d) return []
  const boardwalkZ0 = d.rect.z0 + 16
  const boardwalkZ1 = boardwalkZ0 + 15
  const waterZ0 = d.rect.z0 + 76
  return [{
    rect: d.rect,
    sand: d.rect,
    boardwalk: { x0: d.rect.x0, z0: boardwalkZ0, x1: d.rect.x1, z1: boardwalkZ1 },
    ocean: { x0: d.rect.x0, y0: GROUND_Y - 7, z0: waterZ0, x1: d.rect.x1, y1: GROUND_Y - 2, z1: d.rect.z1 },
  }]
}

/** T50 — park blocks: path cross + plaza, ponds, tree clusters, benches */
function makeParks(seed: number, districts: District[]): ParkOut {
  const out: ParkOut = { ponds: [], parkPaths: [], props: [], trees: [], lamps: [] }
  let parkIdx = 0
  for (const d of districts) {
    if (d.kind !== 'park') continue
    const pp = new Prng((seed ^ 0x2545f491 ^ Math.imul(d.bi * 4 + d.bj + 1, GOLD)) >>> 0)
    const cx = (d.rect.x0 + d.rect.x1) >> 1
    const cz = (d.rect.z0 + d.rect.z1) >> 1
    // path cross through the block + central plaza
    const vPath: Rect = { x0: cx - 3, z0: d.rect.z0, x1: cx + 2, z1: d.rect.z1 }
    const hPath: Rect = { x0: d.rect.x0, z0: cz - 3, x1: d.rect.x1, z1: cz + 2 }
    const plaza: Rect = { x0: cx - 10, z0: cz - 10, x1: cx + 9, z1: cz + 9 }
    out.parkPaths.push(vPath, hPath, plaza)
    // pond: guaranteed in the first park block, 50% for the rest — in a
    // random quadrant, kept clear of the paths
    const pondRoll = pp.nextInt(100)
    const quad = pp.nextInt(4)
    const rx = 26 + pp.nextInt(19)
    const rz = 20 + pp.nextInt(15)
    const depth = 10 + pp.nextInt(5)
    if (parkIdx === 0 || pondRoll < 50) {
      const qx = quad % 2 === 0 ? (d.rect.x0 + cx) >> 1 : (cx + d.rect.x1) >> 1
      const qz = quad < 2 ? (d.rect.z0 + cz) >> 1 : (cz + d.rect.z1) >> 1
      // clamp the full lobe extent inside the quadrant, 8 clear of paths/edges
      const px = Math.max(d.rect.x0 + rx + 12, Math.min(d.rect.x1 - rx - 12, qx))
      const pz = Math.max(d.rect.z0 + rz + 12, Math.min(d.rect.z1 - rz - 12, qz))
      const lobes = [
        { x: px, z: pz, rx, rz },
        { x: px + (pp.nextInt(rx) - (rx >> 1)), z: pz + (pp.nextInt(rz) - (rz >> 1)), rx: (rx * 2) / 3 | 0, rz: (rz * 2) / 3 | 0 },
      ]
      let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity
      for (const l of lobes) {
        bx0 = Math.min(bx0, l.x - l.rx)
        bz0 = Math.min(bz0, l.z - l.rz)
        bx1 = Math.max(bx1, l.x + l.rx)
        bz1 = Math.max(bz1, l.z + l.rz)
      }
      out.ponds.push({
        lobes,
        depth,
        box: { x0: bx0, y0: GROUND_Y - depth, z0: bz0, x1: bx1, y1: GROUND_Y - 2, z1: bz1 },
      })
    }
    const pondKeep: Rect[] = out.ponds.length
      ? [growRect({ x0: out.ponds[out.ponds.length - 1].box.x0, z0: out.ponds[out.ponds.length - 1].box.z0, x1: out.ponds[out.ponds.length - 1].box.x1, z1: out.ponds[out.ponds.length - 1].box.z1 }, 8)]
      : []
    const keep: Rect[] = [growRect(vPath, 5), growRect(hPath, 5), growRect(plaza, 5), ...(parkIdx === 0 || pondRoll < 50 ? pondKeep : [])]
    // tree clusters
    const clusters = 4 + pp.nextInt(4)
    for (let c = 0; c < clusters; c++) {
      const ccx = d.rect.x0 + 14 + pp.nextInt(d.rect.x1 - d.rect.x0 - 28)
      const ccz = d.rect.z0 + 14 + pp.nextInt(d.rect.z1 - d.rect.z0 - 28)
      const nTrees = 2 + pp.nextInt(4)
      for (let t = 0; t < nTrees; t++) {
        const arch = TREE_ARCH[pp.nextInt(3)]
        const trunkH = arch.h0 + pp.nextInt(arch.hv)
        const canopyR = arch.r0 + pp.nextInt(arch.rv)
        const tx = ccx + pp.nextInt(33) - 16
        const tz = ccz + pp.nextInt(33) - 16
        const tSeed = pp.nextU32()
        const canopy: Rect = { x0: tx - canopyR, z0: tz - canopyR, x1: tx + 1 + canopyR, z1: tz + 1 + canopyR }
        if (tx - canopyR < d.rect.x0 + 4 || tx + canopyR > d.rect.x1 - 4) continue
        if (tz - canopyR < d.rect.z0 + 4 || tz + canopyR > d.rect.z1 - 4) continue
        if (keep.some((k) => rectsTouch(canopy, k))) continue
        out.trees.push({ x: tx, z: tz, trunkH, canopyR, seed: tSeed })
      }
    }
    // benches around the plaza + lamps at its corners
    out.props.push(
      { kind: 'bench', x: plaza.x0 + 4, y: GROUND_Y, z: plaza.z0 - 5, rot: 0 },
      { kind: 'bench', x: plaza.x0 + 4, y: GROUND_Y, z: plaza.z1 + 2, rot: 2 },
      { kind: 'bench', x: plaza.x0 - 5, y: GROUND_Y, z: plaza.z0 + 4, rot: 1 },
      { kind: 'bench', x: plaza.x1 + 2, y: GROUND_Y, z: plaza.z0 + 4, rot: 3 },
    )
    out.lamps.push(
      { x: plaza.x0 - 2, z: plaza.z0 - 2, dir: 'x+' },
      { x: plaza.x1 + 2, z: plaza.z1 + 2, dir: 'x-' },
    )
    parkIdx++
  }
  return out
}

export function generateLayout(seed: number): Layout {
  const prng = new Prng(seed)
  const roads = makeRoads()
  const districts = makeDistricts()
  const lots = makeLots(districts)
  const houses: House[] = []
  const pools: Pool[] = []
  const props: Prop[] = []
  const trees: Tree[] = []
  const shrubs: Shrub[] = []
  const fences: FenceLine[] = []
  const lamps: Lamp[] = []
  const mailboxes: Mailbox[] = []
  const bins: Bin[] = []

  // B19 — the lot geometrically closest to spawn is the showcase villa lot.
  // Pure geometry (lots are seed-independent), so it is the same lot for
  // every seed; tie-break on id keeps it deterministic.
  const villaLotId = [...lots].sort((a, b) => {
    const da = rectDist2(a.rect, SPAWN_VX, SPAWN_VZ)
    const db = rectDist2(b.rect, SPAWN_VX, SPAWN_VZ)
    return da - db || a.id - b.id
  })[0].id
  let villa: Villa | null = null

  for (const lot of lots) {
    const isVilla = lot.id === villaLotId
    const lotW = lot.rect.x1 - lot.rect.x0 + 1
    const frontZneg = lot.front === 'z-'
    // detail features (T41-T43) draw from a per-lot derived stream so adding
    // them never reshuffles the base suburb (houses/pools/cars stay put)
    const detail = new Prng((seed ^ 0x51ab7e0d ^ Math.imul(lot.id + 1, 0x9e3779b9)) >>> 0)
    // T51 house/lot detail: own derived stream (same convention)
    const t51 = new Prng((seed ^ 0x3c6ef372 ^ Math.imul(lot.id + 1, 0x9e3779b9)) >>> 0)

    // footprint — base draws are consumed unconditionally so the villa lot
    // (B19) never reshuffles its neighbors' streams
    let w = 80 + prng.nextInt(41) // 8–12 m
    let d = 60 + prng.nextInt(21) // 6–8 m
    const jitter = prng.nextInt(21) - 10
    let floors = prng.nextInt(10) < 4 ? 2 : 1
    let wallMat = prng.nextInt(2) === 0 ? MAT_BRICK : MAT_PLASTER
    let roofBase: 'gable' | 'flat' = prng.nextInt(10) < 6 ? 'gable' : 'flat'
    const setback = isVilla ? 24 : FRONT_SETBACK
    if (isVilla) {
      w = 108
      d = 60
      floors = 2
      wallMat = MAT_PLASTER
      roofBase = 'gable' // upgraded to hip below
    }
    const xMin = lot.rect.x0 + SIDE_SETBACK
    const xMax = lot.rect.x1 - SIDE_SETBACK - w + 1
    const hx0 = Math.min(xMax, Math.max(xMin, lot.rect.x0 + ((lotW - w) >> 1) + (isVilla ? 0 : jitter)))
    const hz0 = frontZneg ? lot.rect.z0 + setback : lot.rect.z1 - setback - d + 1
    const rect: Rect = { x0: hx0, z0: hz0, x1: hx0 + w - 1, z1: hz0 + d - 1 }
    const ridgeAxis = w >= d ? 'x' : 'z'

    // optional single-story L extension into the backyard
    let ell: Rect | null = null
    if (prng.nextInt(10) < 4 && !isVilla) {
      const ew = 40 + prng.nextInt(21)
      const ed = 24 + prng.nextInt(13)
      const left = prng.nextInt(2) === 0
      const ex0 = left ? rect.x0 : rect.x1 - ew + 1
      const candidate: Rect = frontZneg
        ? { x0: ex0, z0: rect.z1 + 1, x1: ex0 + ew - 1, z1: rect.z1 + ed }
        : { x0: ex0, z0: rect.z0 - ed, x1: ex0 + ew - 1, z1: rect.z0 - 1 }
      const fits = frontZneg ? candidate.z1 <= lot.rect.z1 - 8 : candidate.z0 >= lot.rect.z0 + 8
      if (fits) ell = candidate
    }

    // T51 — window variety (per-house size + rhythm); villa gets tall glazing
    const winW = isVilla ? 12 : 8 + 2 * t51.nextInt(4) // 8-14
    const winH = isVilla ? 14 : 10 + 2 * t51.nextInt(3) // 10-14
    const winSill = winH >= 14 ? 8 : WIN_SILL
    const winSpacing = isVilla ? 28 : 30 + 4 * t51.nextInt(4) // 28-42

    // door centered on the front wall
    const door: Opening = {
      side: lot.front,
      offset: (w - DOOR_W) >> 1,
      floor: 0,
      w: DOOR_W,
      h: DOOR_H,
      sill: 1,
    }
    const windows: Opening[] = [
      ...wallWindows(lot.front, w, floors, door, winW, winH, winSill, winSpacing),
      ...wallWindows(frontZneg ? 'z+' : 'z-', w, floors, null, winW, winH, winSill, winSpacing),
      ...wallWindows('x-', d, floors, null, winW, winH, winSill, winSpacing),
      ...wallWindows('x+', d, floors, null, winW, winH, winSill, winSpacing),
    ]

    // interior stairs against the back wall (opposite the door — never blocks it)
    let stairs: Stairs | null = null
    if (floors > 1) {
      const fromLeft = detail.nextInt(2) === 0
      const sx0 = fromLeft ? rect.x0 + WALL_T : rect.x1 - WALL_T - STAIR_RUN + 1
      const srect: Rect = frontZneg
        ? { x0: sx0, z0: rect.z1 - WALL_T - STAIR_W + 1, x1: sx0 + STAIR_RUN - 1, z1: rect.z1 - WALL_T }
        : { x0: sx0, z0: rect.z0 + WALL_T, x1: sx0 + STAIR_RUN - 1, z1: rect.z0 + WALL_T + STAIR_W - 1 }
      stairs = { rect: srect, axis: 'x', dir: fromLeft ? 1 : -1 }
    }

    // driveway: strip from the street-side lot edge to the front wall
    const driveLeft = prng.nextInt(2) === 0
    let dvx0 = driveLeft ? rect.x0 + 4 : rect.x1 - 4 - DRIVE_W + 1
    let driveway: Rect = frontZneg
      ? { x0: dvx0, z0: lot.rect.z0 - LOT_GAP, x1: dvx0 + DRIVE_W - 1, z1: rect.z0 - 1 }
      : { x0: dvx0, z0: rect.z1 + 1, x1: dvx0 + DRIVE_W - 1, z1: lot.rect.z1 + LOT_GAP }

    // T51 — attached garage on the driveway side (space permitting)
    const garageRoll = t51.nextInt(100) < 35
    let garage: Rect | null = null
    if (garageRoll && !isVilla) {
      const gw = 28
      const gd = Math.min(d, 48) // deep enough for the longest car + walls
      const room = driveLeft ? rect.x0 - lot.rect.x0 - 4 : lot.rect.x1 - rect.x1 - 4
      if (room >= gw + 2) {
        const gx0 = driveLeft ? rect.x0 - gw : rect.x1 + 1
        const gz0 = frontZneg ? rect.z0 : rect.z1 - gd + 1
        garage = { x0: gx0, z0: gz0, x1: gx0 + gw - 1, z1: gz0 + gd - 1 }
        // driveway re-routes to the garage door
        dvx0 = gx0 + 4
        driveway = frontZneg
          ? { x0: dvx0, z0: lot.rect.z0 - LOT_GAP, x1: dvx0 + DRIVE_W - 1, z1: gz0 - 1 }
          : { x0: dvx0, z0: gz0 + gd, x1: dvx0 + DRIVE_W - 1, z1: lot.rect.z1 + LOT_GAP }
      }
    }

    // T43 — variation: roof material, driveway pavers, porch, shutters, garden path
    const roofMat = roofBase === 'gable' && detail.nextInt(10) < 6 ? MAT_ROOFTILE : MAT_WOOD
    const driveMat = detail.nextInt(10) < 4 ? ('paver' as const) : ('concrete' as const)
    const shutters = detail.nextInt(10) < 5
    const doorCx = rect.x0 + door.offset + (DOOR_W >> 1)
    let porch: Rect | null = null
    if (detail.nextInt(10) < 4) {
      const pw = DOOR_W + 10
      const px0 = doorCx - (pw >> 1)
      porch = frontZneg
        ? { x0: px0, z0: rect.z0 - 8, x1: px0 + pw - 1, z1: rect.z0 - 1 }
        : { x0: px0, z0: rect.z1 + 1, x1: px0 + pw - 1, z1: rect.z1 + 8 }
    }
    const path: Rect = frontZneg
      ? { x0: doorCx - 2, z0: lot.rect.z0 - LOT_GAP, x1: doorCx + 2, z1: (porch ? porch.z0 : rect.z0) - 1 }
      : { x0: doorCx - 2, z0: (porch ? porch.z1 : rect.z1) + 1, x1: doorCx + 2, z1: lot.rect.z1 + LOT_GAP }

    // T51 — roofline variety: some gables become hips (base stream untouched)
    const hipRoll = t51.nextInt(100) < 35
    const roof: House['roof'] = isVilla ? 'hip' : roofBase === 'gable' && hipRoll ? 'hip' : roofBase

    // T51 — chimney on ~45% of pitched roofs (3×3 brick through the ridge)
    const chimRoll = t51.nextInt(100)
    const chimOff = t51.nextInt(1 << 30)
    let chimney: { x: number; z: number } | null = null
    if (roof !== 'flat' && (chimRoll < 45 || isVilla)) {
      chimney =
        ridgeAxis === 'x'
          ? { x: rect.x0 + 10 + (chimOff % Math.max(1, w - 23)), z: ((rect.z0 + rect.z1) >> 1) - 1 }
          : { x: ((rect.x0 + rect.x1) >> 1) - 1, z: rect.z0 + 10 + (chimOff % Math.max(1, d - 23)) }
    }

    // T51 — balcony over the front door on 2-story houses (~45%)
    const balcRoll = t51.nextInt(100)
    let balcony: Rect | null = null
    let balconyDoor: Opening | null = null
    if (floors === 2 && (balcRoll < 45 || isVilla)) {
      const bw = 20
      const bx0 = doorCx - (bw >> 1)
      balcony = frontZneg
        ? { x0: bx0, z0: rect.z0 - 8, x1: bx0 + bw - 1, z1: rect.z0 - 1 }
        : { x0: bx0, z0: rect.z1 + 1, x1: bx0 + bw - 1, z1: rect.z1 + 8 }
      balconyDoor = { side: lot.front, offset: doorCx - rect.x0 - (DOOR_W >> 1), floor: 1, w: DOOR_W, h: DOOR_H, sill: 1 }
    }

    // T51 — backyard patio against the back wall (~40%, space permitting)
    const patioRoll = t51.nextInt(100)
    const patioW = 24 + 2 * t51.nextInt(5)
    let patio: Rect | null = null
    if (patioRoll < 40 && !isVilla) {
      const backZ = frontZneg ? Math.max(rect.z1, ell ? ell.z1 : 0) : Math.min(rect.z0, ell ? ell.z0 : WORLD_VZ)
      const pd = 16
      const px0 = Math.max(lot.rect.x0 + 2, Math.min(lot.rect.x1 - 1 - patioW, doorCx - (patioW >> 1)))
      const cand: Rect = frontZneg
        ? { x0: px0, z0: backZ + 1, x1: px0 + patioW - 1, z1: backZ + pd }
        : { x0: px0, z0: backZ - pd, x1: px0 + patioW - 1, z1: backZ - 1 }
      const fits = frontZneg ? cand.z1 <= lot.rect.z1 - 4 : cand.z0 >= lot.rect.z0 + 4
      if (fits && !(garage && rectsTouch(cand, garage))) patio = cand
    }

    // T59 — lived-in touches: garage door state, mailbox style, worn lawn
    // patches (draws unconditional for stream stability)
    const garageOpen = t51.nextInt(2) === 0
    const mailStyle: 0 | 1 = t51.nextInt(4) === 0 ? 1 : 0
    const wornPatches: { x: number; z: number; r: number }[] = []
    const nPatches = t51.nextInt(3)
    for (let i = 0; i < 2; i++) {
      const px = lot.rect.x0 + 8 + t51.nextInt(Math.max(1, lotW - 16))
      const pz = frontZneg
        ? lot.rect.z0 + 8 + t51.nextInt(Math.max(1, rect.z0 - lot.rect.z0 - 14))
        : rect.z1 + 6 + t51.nextInt(Math.max(1, lot.rect.z1 - rect.z1 - 14))
      const pr = 3 + t51.nextInt(4)
      if (i >= nPatches || isVilla) continue // villa lawn stays manicured
      const prect: Rect = { x0: px - pr, z0: pz - pr, x1: px + pr, z1: pz + pr }
      if (rectsTouch(prect, driveway) || rectsTouch(prect, path)) continue
      if (porch && rectsTouch(prect, porch)) continue
      if (garage && rectsTouch(prect, garage)) continue
      wornPatches.push({ x: px, z: pz, r: pr })
    }

    const house: House = {
      lotId: lot.id, rect, ell, floors, storyH: STORY_H, wallMat, roof, ridgeAxis,
      door, windows, driveway, stairs, roofMat, driveMat, porch, shutters, path,
      garage, garageOpen, wornPatches, balcony, balconyDoor, chimney,
      partitions: [], patio, gardens: [], shed: null,
    }
    // T51 — interior rooms + furniture from a dedicated stream
    const interior = new Prng((seed ^ 0x1b873593 ^ Math.imul(lot.id + 1, 0x9e3779b9)) >>> 0)
    house.partitions = makePartitions(house, lot.front, interior)
    placeFurniture(house, lot.front, interior, props)
    houses.push(house)

    // parked car on ~half the driveways (garage lots park inside sometimes).
    // Base stream still burns its two historical draws; archetype + color
    // come from the T51 stream (T59 car variety).
    const carRoll = prng.nextInt(2) === 0
    prng.nextInt(2) // legacy kind draw, superseded by T59
    const inGarage = t51.nextInt(2) === 0
    const carKind = `${CAR_ARCHS[t51.nextInt(3)]}${t51.nextInt(3)}`
    if (carRoll) {
      if (garage && inGarage) {
        props.push({
          kind: carKind,
          x: garage.x0 + 5,
          y: GROUND_Y,
          z: frontZneg ? garage.z0 + 3 : garage.z1 - 3 - PROP_DIMS[carKind][1] + 1,
          rot: frontZneg ? 0 : 2,
        })
      } else {
        props.push({
          kind: carKind,
          x: dvx0 + 1,
          y: GROUND_Y,
          z: frontZneg ? lot.rect.z0 + 4 : lot.rect.z1 - 4 - 40 + 1,
          rot: frontZneg ? 0 : 2,
        })
      }
    }

    // B19 — villa lot: large two-depth pool + paver deck + cabana, biased
    // toward the spawn crossing so it is the first thing the player sees
    if (isVilla) {
      const pw = 84 // 8.4 m
      const pd = 40 // 4.0 m
      const spawnRight = SPAWN_VX > lot.rect.x0 + (lotW >> 1)
      const px0 = spawnRight ? lot.rect.x1 - 8 - pw + 1 : lot.rect.x0 + 8
      const pz0 = frontZneg ? rect.z1 + 10 : rect.z0 - 10 - pd + 1
      const basin: Box = { x0: px0, y0: GROUND_Y - POOL_DEPTH, z0: pz0, x1: px0 + pw - 1, y1: GROUND_Y - 1, z1: pz0 + pd - 1 }
      // shallow end: the house-side half floor is raised to 0.8 m depth
      const shallow: Box = frontZneg
        ? { x0: basin.x0, y0: basin.y0, z0: basin.z0, x1: basin.x1, y1: GROUND_Y - 9, z1: basin.z0 + (pd >> 1) - 1 }
        : { x0: basin.x0, y0: basin.y0, z0: basin.z1 - (pd >> 1) + 1, x1: basin.x1, y1: GROUND_Y - 9, z1: basin.z1 }
      pools.push({ lotId: lot.id, basin, shallow })
      const deck: Rect = {
        x0: Math.max(lot.rect.x0 + 2, basin.x0 - 6),
        z0: Math.max(lot.rect.z0 + 2, basin.z0 - 6),
        x1: Math.min(lot.rect.x1 - 2, basin.x1 + 6),
        z1: Math.min(lot.rect.z1 - 2, basin.z1 + 6),
      }
      const cw = 30
      const cd = 22
      const cx0 = spawnRight ? basin.x0 - 8 - cw : basin.x1 + 9
      const cz0 = ((basin.z0 + basin.z1) >> 1) - (cd >> 1)
      villa = {
        lotId: lot.id,
        deck,
        cabana: { x0: cx0, z0: cz0, x1: cx0 + cw - 1, z1: cz0 + cd - 1 },
        cabanaFront: spawnRight ? 'x+' : 'x-',
      }
      // cabana bench for the poolside lounge
      props.push({ kind: 'bench', x: cx0 + 9, y: GROUND_Y, z: cz0 + 8, rot: 0 })
    }

    // backyard pool on ~35% of lots, only if it fits behind the house/L/patio
    if (prng.nextInt(100) < 35 && !isVilla) {
      const pw = 40 + prng.nextInt(25)
      const pd = 24 + prng.nextInt(9)
      const backEdge = frontZneg
        ? Math.max(rect.z1, ell ? ell.z1 : 0, patio ? patio.z1 : 0) + 8
        : Math.min(rect.z0, ell ? ell.z0 : WORLD_VZ, patio ? patio.z0 : WORLD_VZ) - 8
      const px0 = lot.rect.x0 + ((lotW - pw) >> 1)
      const basin: Box | null = frontZneg
        ? backEdge + pd - 1 <= lot.rect.z1 - 8
          ? { x0: px0, y0: GROUND_Y - POOL_DEPTH, z0: backEdge, x1: px0 + pw - 1, y1: GROUND_Y - 1, z1: backEdge + pd - 1 }
          : null
        : backEdge - pd + 1 >= lot.rect.z0 + 8
          ? { x0: px0, y0: GROUND_Y - POOL_DEPTH, z0: backEdge - pd + 1, x1: px0 + pw - 1, y1: GROUND_Y - 1, z1: backEdge }
          : null
      if (basin) pools.push({ lotId: lot.id, basin })
    }

    // T42 — foundation shrubs along the front wall, clear of door/porch and driveway
    const shrubZ = frontZneg ? rect.z0 - 4 : rect.z1 + 3
    const nShrubs = 2 + detail.nextInt(3)
    for (let i = 0; i < nShrubs; i++) {
      const sx = rect.x0 + 3 + detail.nextInt(Math.max(1, w - 6))
      const sr = 2 + detail.nextInt(2)
      const sSeed = detail.nextU32()
      if (Math.abs(sx - doorCx) < 13) continue
      const srect: Rect = { x0: sx - sr, z0: shrubZ - sr, x1: sx + sr, z1: shrubZ + sr }
      if (rectsTouch(srect, driveway)) continue
      if (garage && rectsTouch(srect, garage)) continue
      shrubs.push({ x: sx, z: shrubZ, r: sr, seed: sSeed })
    }

    // T43 — picket fences: sides + back on ~55% of lots, front (with gate
    // gaps at driveway and path) on ~40% of those
    const frontZ = frontZneg ? lot.rect.z0 : lot.rect.z1
    const backZ = frontZneg ? lot.rect.z1 : lot.rect.z0
    if (detail.nextInt(100) < 55) {
      fences.push({ x0: lot.rect.x0, z0: lot.rect.z0, x1: lot.rect.x0, z1: lot.rect.z1 })
      fences.push({ x0: lot.rect.x1, z0: lot.rect.z0, x1: lot.rect.x1, z1: lot.rect.z1 })
      fences.push({ x0: lot.rect.x0 + 1, z0: backZ, x1: lot.rect.x1 - 1, z1: backZ })
      if (detail.nextInt(100) < 40) {
        const gaps = (
          [
            [driveway.x0 - 2, driveway.x1 + 2],
            [path.x0 - 2, path.x1 + 2],
          ] as [number, number][]
        ).sort((a, b) => a[0] - b[0])
        let cur = lot.rect.x0 + 1
        for (const [g0, g1] of gaps) {
          if (g0 - 1 >= cur + 3) fences.push({ x0: cur, z0: frontZ, x1: g0 - 1, z1: frontZ })
          cur = Math.max(cur, g1 + 1)
        }
        if (lot.rect.x1 - 1 >= cur + 3) fences.push({ x0: cur, z0: frontZ, x1: lot.rect.x1 - 1, z1: frontZ })
      }
    }

    // T43 — mailbox on the street side of every driveway, in the grass strip
    const mbx = driveLeft ? driveway.x0 - 3 : driveway.x1 + 3
    const mbz = frontZneg ? lot.rect.z0 - 3 : lot.rect.z1 + 3
    mailboxes.push({ x: mbx, z: mbz, style: mailStyle })

    // T43 — trash bin beside ~40% of driveways, near the house corner
    if (detail.nextInt(10) < 4) {
      const bx = driveLeft ? driveway.x1 + 2 : driveway.x0 - 6
      const bz = frontZneg ? rect.z0 - 11 : rect.z1 + 7
      const brect: Rect = { x0: bx, z0: bz, x1: bx + 3, z1: bz + 3 }
      if (!rectsTouch(brect, path) && !(porch && rectsTouch(brect, porch)) && !rectsTouch(brect, driveway) && !(garage && rectsTouch(brect, garage))) {
        bins.push({ x: bx, z: bz })
      }
    }
  }

  // Pool guarantee (B19): the spawn-closest lot is the villa and ALWAYS
  // carries its large pool (pushed in the loop above — capping spawn→pool
  // distance for every seed). Top up to ≥2 pools total, nearest lots first.
  const byDistToSpawn = [...lots].sort((a, b) => {
    const da = rectDist2(a.rect, SPAWN_VX, SPAWN_VZ)
    const db = rectDist2(b.rect, SPAWN_VX, SPAWN_VZ)
    return da - db || a.id - b.id
  })
  for (const lot of byDistToSpawn) {
    if (pools.length >= 2) break
    if (pools.some((p) => p.lotId === lot.id)) continue
    pools.push({ lotId: lot.id, basin: forcePoolBasin(lot, houses[lot.id]) })
  }

  // T51 — backyard sheds (~30%) + garden beds, placed after the pool
  // guarantee so they always dodge every basin. Own derived stream.
  for (const lot of lots) {
    const h = houses[lot.id]
    const yard = new Prng((seed ^ 0xcc9e2d51 ^ Math.imul(lot.id + 1, 0x9e3779b9)) >>> 0)
    const frontZneg = lot.front === 'z-'
    const keep: Rect[] = [growRect(h.rect, 2), growRect(h.driveway, 2)]
    if (h.ell) keep.push(growRect(h.ell, 2))
    if (h.patio) keep.push(growRect(h.patio, 2))
    if (h.garage) keep.push(growRect(h.garage, 2))
    if (villa && villa.lotId === lot.id) keep.push(growRect(villa.deck, 2), growRect(villa.cabana, 2))
    for (const p of pools.filter((p) => p.lotId === lot.id)) {
      keep.push({ x0: p.basin.x0 - 5, z0: p.basin.z0 - 5, x1: p.basin.x1 + 5, z1: p.basin.z1 + 5 })
    }
    // shed in a back corner (~30%; never on the villa lot — cabana instead)
    const shedRoll = yard.nextInt(100)
    const shedLeft = yard.nextInt(2) === 0
    if (shedRoll < 30 && lot.id !== villaLotId) {
      const [sw, sd] = PROP_DIMS.shed
      const sx0 = shedLeft ? lot.rect.x0 + 4 : lot.rect.x1 - 4 - sw + 1
      const sz0 = frontZneg ? lot.rect.z1 - 4 - sd + 1 : lot.rect.z0 + 4
      const cand: Rect = { x0: sx0, z0: sz0, x1: sx0 + sw - 1, z1: sz0 + sd - 1 }
      if (!keep.some((k) => rectsTouch(cand, k))) {
        h.shed = cand
        keep.push(growRect(cand, 2))
        props.push({ kind: 'shed', x: sx0, y: GROUND_Y, z: sz0, rot: frontZneg ? 0 : 2 })
      }
    }
    // B19 — villa landscaping: paired garden beds flanking the entry path
    if (villa && villa.lotId === lot.id) {
      const frontY = frontZneg ? lot.rect.z0 + 8 : lot.rect.z1 - 14
      for (const bx0 of [h.path.x0 - 24, h.path.x1 + 5]) {
        const cand: Rect = { x0: bx0, z0: frontY, x1: bx0 + 19, z1: frontY + 6 }
        if (keep.some((k) => rectsTouch(cand, k))) continue
        h.gardens.push(cand)
        keep.push(growRect(cand, 1))
      }
    }
    // 0-2 raised garden beds along the back fence
    const nBeds = yard.nextInt(3)
    for (let b = 0; b < nBeds; b++) {
      const bw = 14 + 2 * yard.nextInt(5)
      const bx0 = lot.rect.x0 + 6 + yard.nextInt(Math.max(1, lot.rect.x1 - lot.rect.x0 - bw - 12))
      const bz0 = frontZneg ? lot.rect.z1 - 12 : lot.rect.z0 + 6
      const cand: Rect = { x0: bx0, z0: bz0, x1: bx0 + bw - 1, z1: bz0 + 6 }
      if (keep.some((k) => rectsTouch(cand, k))) continue
      h.gardens.push(cand)
      keep.push(growRect(cand, 1))
    }
  }

  // T42 — yard trees: 1-3 per lot, canopy fully clear of house/ell/garage/
  // driveway/path/porch/patio/shed/garden/pool deck. Own derived stream.
  for (const lot of lots) {
    const h = houses[lot.id]
    const veg = new Prng((seed ^ 0x6e624eb7 ^ Math.imul(lot.id + 1, 0x9e3779b9)) >>> 0)
    const lotW = lot.rect.x1 - lot.rect.x0 + 1
    const lotD = lot.rect.z1 - lot.rect.z0 + 1
    const keepOut: Rect[] = [growRect(h.rect, 2), growRect(h.driveway, 2), growRect(h.path, 2)]
    if (h.ell) keepOut.push(growRect(h.ell, 2))
    if (h.porch) keepOut.push(growRect(h.porch, 2))
    if (h.garage) keepOut.push(growRect(h.garage, 2))
    if (h.patio) keepOut.push(growRect(h.patio, 2))
    if (h.balcony) keepOut.push(growRect(h.balcony, 2))
    if (h.shed) keepOut.push(growRect(h.shed, 2))
    if (villa && villa.lotId === lot.id) keepOut.push(growRect(villa.deck, 2), growRect(villa.cabana, 2))
    for (const g of h.gardens) keepOut.push(growRect(g, 1))
    for (const p of pools.filter((p) => p.lotId === lot.id)) {
      keepOut.push({ x0: p.basin.x0 - 7, z0: p.basin.z0 - 7, x1: p.basin.x1 + 7, z1: p.basin.z1 + 7 })
    }
    const wantTrees = 1 + veg.nextInt(3)
    let placedTrees = 0
    for (let attempt = 0; attempt < 12 && placedTrees < wantTrees; attempt++) {
      const arch = TREE_ARCH[veg.nextInt(3)]
      const trunkH = arch.h0 + veg.nextInt(arch.hv)
      const canopyR = arch.r0 + veg.nextInt(arch.rv)
      const tx = lot.rect.x0 + 4 + veg.nextInt(lotW - 9)
      const tz = lot.rect.z0 + 4 + veg.nextInt(lotD - 9)
      const canopy: Rect = { x0: tx - canopyR, z0: tz - canopyR, x1: tx + 1 + canopyR, z1: tz + 1 + canopyR }
      const treeSeed = veg.nextU32()
      if (keepOut.some((k) => rectsTouch(canopy, k))) continue
      trees.push({ x: tx, z: tz, trunkH, canopyR, seed: treeSeed })
      placedTrees++
    }
  }

  // T50 — rowhouse, commercial and park districts (own streams per block)
  const rowBlocks = makeRowBlocks(seed, districts, fences, trees)
  const com = makeCommercial(seed, districts)
  const park = makeParks(seed, districts)
  const beaches = makeBeaches()
  props.push(...com.props)
  lamps.push(...com.lamps)
  trees.push(...park.trees)
  props.push(...park.props)
  lamps.push(...park.lamps)

  // structures the street trees must keep clear of
  const structureKeep: Rect[] = [
    ...rowBlocks.map((b) => growRect(b.rect, 4)),
    ...com.towers.map((t) => growRect(t.rect, 6)),
    ...com.parking.map((p) => growRect(p.rect, 2)),
  ]

  // T42 — parkway street trees: alternating road sides every ~9.6 m, clear of
  // intersections, driveways and district structures
  const street = new Prng((seed ^ 0x7f4a7c15) >>> 0)
  for (const road of roads) {
    const c = road.center
    let k = 0
    for (let along = 48; along < WORLD_VX - 48; along += 96, k++) {
      const jitter = street.nextInt(13) - 6
      const arch = TREE_ARCH[street.nextInt(2)]
      const trunkH = arch.h0 + street.nextInt(arch.hv)
      const canopyR = arch.r0 + street.nextInt(arch.rv)
      const treeSeed = street.nextU32()
      const a = along + jitter
      if (ROAD_CENTERS.some((c2) => Math.abs(a - c2) < ART_EXTENT + 12)) continue
      const ext = road.kind === 'arterial' ? ART_EXTENT : RES_EXTENT
      const perp = c + (k % 2 === 0 ? -(ext + 3) : ext + 2)
      const tx = road.axis === 'x' ? a : perp
      const tz = road.axis === 'x' ? perp : a
      const canopy: Rect = { x0: tx - canopyR, z0: tz - canopyR, x1: tx + 1 + canopyR, z1: tz + 1 + canopyR }
      const trunkR: Rect = { x0: tx - 1, z0: tz - 1, x1: tx + 2, z1: tz + 2 }
      if (houses.some((h) => rectsTouch(canopy, growRect(h.driveway, 4)) || rectsTouch(canopy, h.rect))) continue
      // trunks never sprout through parkway path strips or mailboxes
      if (houses.some((h) => rectsTouch(trunkR, growRect(h.path, 2)))) continue
      if (mailboxes.some((m) => rectsTouch(trunkR, { x0: m.x - 2, z0: m.z - 2, x1: m.x + 2, z1: m.z + 2 }))) continue
      if (structureKeep.some((s) => rectsTouch(canopy, s))) continue
      trees.push({ x: tx, z: tz, trunkH, canopyR, seed: treeSeed })
    }
  }

  // T43 — lamp posts: every ~12.8 m along each road on the outer sidewalk
  // edge, alternating sides, clear of intersections. Purely derived (no prng
  // needed — spacing is the aesthetic).
  for (const road of roads) {
    const c = road.center
    const ext = road.kind === 'arterial' ? ART_EXTENT : RES_EXTENT
    let k = 0
    for (let along = 64; along < WORLD_VX - 32; along += 128, k++) {
      if (ROAD_CENTERS.some((c2) => Math.abs(along - c2) < ART_EXTENT + 10)) continue
      const side = k % 2 === 0 ? 1 : -1
      const perp = c + side * (ext - 2)
      const dir: Side = road.axis === 'x' ? (side === 1 ? 'z-' : 'z+') : (side === 1 ? 'x-' : 'x+')
      lamps.push({
        x: road.axis === 'x' ? along : perp,
        z: road.axis === 'x' ? perp : along,
        dir,
      })
    }
  }

  // T59 — curb-parked cars along residential streets (~1 in 4 slots), tucked
  // against the asphalt edge, clear of intersections. Own derived stream.
  const curb = new Prng((seed ^ 0x0badcafe) >>> 0)
  for (const road of roads) {
    if (road.kind !== 'res') continue
    const c = road.center
    for (let along = 80; along < WORLD_VX - 130; along += 160) {
      const roll = curb.nextInt(100)
      const side = curb.nextInt(2) === 0 ? 1 : -1
      const kind = `${CAR_ARCHS[curb.nextInt(3)]}${curb.nextInt(3)}`
      const jitter = curb.nextInt(41)
      if (roll >= 25) continue
      const a = along + jitter
      const len = PROP_DIMS[kind][1]
      if (ROAD_CENTERS.some((c2) => a + len >= c2 - ART_EXTENT - 16 && a <= c2 + ART_EXTENT + 16)) continue
      const perp = c + side * (ROAD_HALF_RES - 12) - 9 // 18-wide body hugs the curb
      if (road.axis === 'x') props.push({ kind, x: a, y: GROUND_Y, z: perp, rot: 1 })
      else props.push({ kind, x: perp, y: GROUND_Y, z: a, rot: 0 })
    }
  }

  if (!villa) throw new Error('generateLayout: villa lot was never generated (B19)')
  return {
    seed, groundY: GROUND_Y, roads, districts, lots, houses, pools, villa,
    rowBlocks, towers: com.towers, parking: com.parking, plazas: com.plazas,
    ponds: park.ponds, beaches, parkPaths: park.parkPaths,
    props, trees, shrubs, fences, lamps, mailboxes, bins,
  }
}
