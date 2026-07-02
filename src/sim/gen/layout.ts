/**
 * T19 — procedural suburb layout. Pure function of seed (V2: Prng is the
 * only randomness source, no wall-clock). Emits a declarative, JSON-serializable
 * description — NO world writes (the stamper, T20, turns this into
 * ChunkStore edits).
 *
 * Geometry: voxel coords (10 cm), footprint x,z ∈ [0,1024), ground surface
 * air starts at GROUND_Y (solid ground fills y ∈ [0, GROUND_Y-1]).
 * Rects/boxes are INCLUSIVE on both ends.
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
  asphalt: Rect
  sidewalks: [Rect, Rect]
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
 * run against the back wall; the stamper carves a matching opening in the
 * upper-floor slab. Rise/tread sized for the Jolt character step-climb
 * (STAIR_RISE=2 voxels = 0.2 m < 0.4 m default mWalkStairsStepUp).
 */
export interface Stairs {
  rect: Rect
  /** run axis (along the house width) */
  axis: 'x'
  /** ascending direction along the axis */
  dir: 1 | -1
}

export interface House {
  lotId: number
  rect: Rect
  /** optional single-story L extension on the back side */
  ell: Rect | null
  floors: number
  storyH: number
  wallMat: number
  roof: 'gable' | 'flat'
  ridgeAxis: 'x' | 'z'
  door: Opening
  windows: Opening[]
  driveway: Rect
  /** interior stairs to the upper floor; null for single-story houses */
  stairs: Stairs | null
  /** gable roof material (MAT_WOOD or MAT_ROOFTILE); flat roofs stay concrete */
  roofMat: number
  /** driveway surface: plain concrete or brick/concrete paver checker */
  driveMat: 'concrete' | 'paver'
  /** concrete stoop in front of the door with posts + small awning */
  porch: Rect | null
  /** wood shutters flanking front-wall windows */
  shutters: boolean
  /** garden paver path: front lot edge → door (or porch) */
  path: Rect
}

export interface Pool {
  lotId: number
  /** interior basin volume (dug to air, lined with concrete around it) */
  basin: Box
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
}

export interface Bin {
  x: number
  z: number
}

export interface Prop {
  /** placeholder car kinds 'car0'|'car1' now; .vox prop names later */
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
  lots: Lot[]
  houses: House[]
  pools: Pool[]
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

const ROAD_CENTERS = [96, 512, 928]
const ROAD_HALF = 30 // asphalt 6 m wide
const WALK_W = 12 // 1.2 m sidewalks
const ROAD_EXTENT = ROAD_HALF + WALK_W // 42
const LOT_GAP = 4
const SIDE_SETBACK = 12
const FRONT_SETBACK = 48 // 4.8 m — driveway length

const DOOR_W = 9
const DOOR_H = 21
const WIN_W = 10
const WIN_H = 12
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

/** tree size archetypes (T42): base height/radius + variation range */
const TREE_ARCH = [
  { h0: 12, hv: 5, r0: 6, rv: 3 }, // small
  { h0: 18, hv: 6, r0: 9, rv: 3 }, // medium
  { h0: 26, hv: 7, r0: 12, rv: 3 }, // large
] as const

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

/**
 * Deterministic forced pool for the pool guarantee: behind the house with a
 * shrinking size ladder; if the backyard is blocked (deep L extension), a
 * small plunge pool in the front-yard corner opposite the driveway — that
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
      ? Math.max(h.rect.z1, h.ell ? h.ell.z1 : 0) + 8
      : Math.min(h.rect.z0, h.ell ? h.ell.z0 : WORLD_VZ) - 8
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

function makeRoads(): Road[] {
  const roads: Road[] = []
  for (const c of ROAD_CENTERS) {
    // runs along x at constant z
    roads.push({
      axis: 'x',
      center: c,
      asphalt: { x0: 0, z0: c - ROAD_HALF, x1: WORLD_VX - 1, z1: c + ROAD_HALF },
      sidewalks: [
        { x0: 0, z0: c - ROAD_EXTENT, x1: WORLD_VX - 1, z1: c - ROAD_HALF - 1 },
        { x0: 0, z0: c + ROAD_HALF + 1, x1: WORLD_VX - 1, z1: c + ROAD_EXTENT },
      ],
    })
    // runs along z at constant x
    roads.push({
      axis: 'z',
      center: c,
      asphalt: { x0: c - ROAD_HALF, z0: 0, x1: c + ROAD_HALF, z1: WORLD_VZ - 1 },
      sidewalks: [
        { x0: c - ROAD_EXTENT, z0: 0, x1: c - ROAD_HALF - 1, z1: WORLD_VZ - 1 },
        { x0: c + ROAD_HALF + 1, z0: 0, x1: c + ROAD_EXTENT, z1: WORLD_VZ - 1 },
      ],
    })
  }
  return roads
}

function makeLots(): Lot[] {
  const lots: Lot[] = []
  let id = 0
  for (let bi = 0; bi < ROAD_CENTERS.length - 1; bi++) {
    for (let bj = 0; bj < ROAD_CENTERS.length - 1; bj++) {
      const bx0 = ROAD_CENTERS[bi] + ROAD_EXTENT + 1
      const bx1 = ROAD_CENTERS[bi + 1] - ROAD_EXTENT - 1
      const bz0 = ROAD_CENTERS[bj] + ROAD_EXTENT + 1
      const bz1 = ROAD_CENTERS[bj + 1] - ROAD_EXTENT - 1
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
  }
  return lots
}

/** windows along one wall: every ~36 voxels, ≥14 from ends, skipping the door span on the front */
function wallWindows(side: Side, wallLen: number, floors: number, door: Opening | null): Opening[] {
  const out: Opening[] = []
  for (let floor = 0; floor < floors; floor++) {
    for (let off = 14; off + WIN_W <= wallLen - 14; off += 36) {
      if (door && floor === 0 && side === door.side && off + WIN_W >= door.offset - 3 && off <= door.offset + door.w + 3) {
        continue
      }
      out.push({ side, offset: off, floor, w: WIN_W, h: WIN_H, sill: WIN_SILL })
    }
  }
  return out
}

export function generateLayout(seed: number): Layout {
  const prng = new Prng(seed)
  const roads = makeRoads()
  const lots = makeLots()
  const houses: House[] = []
  const pools: Pool[] = []
  const props: Prop[] = []
  const trees: Tree[] = []
  const shrubs: Shrub[] = []
  const fences: FenceLine[] = []
  const lamps: Lamp[] = []
  const mailboxes: Mailbox[] = []
  const bins: Bin[] = []

  for (const lot of lots) {
    const lotW = lot.rect.x1 - lot.rect.x0 + 1
    const frontZneg = lot.front === 'z-'
    // detail features (T41-T43) draw from a per-lot derived stream so adding
    // them never reshuffles the base suburb (houses/pools/cars stay put)
    const detail = new Prng((seed ^ 0x51ab7e0d ^ Math.imul(lot.id + 1, 0x9e3779b9)) >>> 0)

    // footprint
    const w = 80 + prng.nextInt(41) // 8–12 m
    const d = 60 + prng.nextInt(21) // 6–8 m
    const xMin = lot.rect.x0 + SIDE_SETBACK
    const xMax = lot.rect.x1 - SIDE_SETBACK - w + 1
    const jitter = prng.nextInt(21) - 10
    const hx0 = Math.min(xMax, Math.max(xMin, lot.rect.x0 + ((lotW - w) >> 1) + jitter))
    const hz0 = frontZneg ? lot.rect.z0 + FRONT_SETBACK : lot.rect.z1 - FRONT_SETBACK - d + 1
    const rect: Rect = { x0: hx0, z0: hz0, x1: hx0 + w - 1, z1: hz0 + d - 1 }

    const floors = prng.nextInt(10) < 4 ? 2 : 1
    const wallMat = prng.nextInt(2) === 0 ? MAT_BRICK : MAT_PLASTER
    const roof = prng.nextInt(10) < 6 ? 'gable' : 'flat'
    const ridgeAxis = w >= d ? 'x' : 'z'

    // optional single-story L extension into the backyard
    let ell: Rect | null = null
    if (prng.nextInt(10) < 4) {
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
      ...wallWindows(lot.front, w, floors, door),
      ...wallWindows(frontZneg ? 'z+' : 'z-', w, floors, null),
      ...wallWindows('x-', d, floors, null),
      ...wallWindows('x+', d, floors, null),
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
    const dvx0 = driveLeft ? rect.x0 + 4 : rect.x1 - 4 - DRIVE_W + 1
    const driveway: Rect = frontZneg
      ? { x0: dvx0, z0: lot.rect.z0 - LOT_GAP, x1: dvx0 + DRIVE_W - 1, z1: rect.z0 - 1 }
      : { x0: dvx0, z0: rect.z1 + 1, x1: dvx0 + DRIVE_W - 1, z1: lot.rect.z1 + LOT_GAP }

    // T43 — variation: roof material, driveway pavers, porch, shutters, garden path
    const roofMat = roof === 'gable' && detail.nextInt(10) < 6 ? MAT_ROOFTILE : MAT_WOOD
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

    houses.push({
      lotId: lot.id, rect, ell, floors, storyH: STORY_H, wallMat, roof, ridgeAxis,
      door, windows, driveway, stairs, roofMat, driveMat, porch, shutters, path,
    })

    // parked car on ~half the driveways (placeholder .vox prop spot)
    if (prng.nextInt(2) === 0) {
      const kind = `car${prng.nextInt(2)}`
      props.push({
        kind,
        x: dvx0 + 1,
        y: GROUND_Y,
        z: frontZneg ? lot.rect.z0 + 4 : lot.rect.z1 - 4 - 40 + 1,
        rot: frontZneg ? 0 : 2,
      })
    }

    // backyard pool on ~35% of lots, only if it fits behind the house/L
    if (prng.nextInt(100) < 35) {
      const pw = 40 + prng.nextInt(25)
      const pd = 24 + prng.nextInt(9)
      const backEdge = frontZneg
        ? Math.max(rect.z1, ell ? ell.z1 : 0) + 8
        : Math.min(rect.z0, ell ? ell.z0 : WORLD_VZ) - 8
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
    mailboxes.push({ x: mbx, z: mbz })

    // T43 — trash bin beside ~40% of driveways, near the house corner
    if (detail.nextInt(10) < 4) {
      const bx = driveLeft ? driveway.x1 + 2 : driveway.x0 - 6
      const bz = frontZneg ? rect.z0 - 11 : rect.z1 + 7
      const brect: Rect = { x0: bx, z0: bz, x1: bx + 3, z1: bz + 3 }
      if (!rectsTouch(brect, path) && !(porch && rectsTouch(brect, porch)) && !rectsTouch(brect, driveway)) {
        bins.push({ x: bx, z: bz })
      }
    }
  }

  // Pool guarantee: ≥2 pools total AND one on the lot closest to the player
  // spawn (world center, voxel 512,512 — the central road crossing). Pure
  // geometry, runs before tree placement so trees respect forced pools (V2).
  const byDistToSpawn = [...lots].sort((a, b) => {
    const da = rectDist2(a.rect, 512, 512)
    const db = rectDist2(b.rect, 512, 512)
    return da - db || a.id - b.id
  })
  // 1) the closest lot ALWAYS gets a spawn-biased pool (replacing any rolled
  //    basin there), capping spawn→pool distance at ~19 m for every seed
  const spawnLot = byDistToSpawn[0]
  const spawnBasin = forcePoolBasin(spawnLot, houses[spawnLot.id], 512)
  const rolled = pools.findIndex((p) => p.lotId === spawnLot.id)
  if (rolled >= 0) pools.splice(rolled, 1)
  pools.push({ lotId: spawnLot.id, basin: spawnBasin })
  // 2) top up to at least 2 pools, nearest lots first
  for (const lot of byDistToSpawn) {
    if (pools.length >= 2) break
    if (pools.some((p) => p.lotId === lot.id)) continue
    pools.push({ lotId: lot.id, basin: forcePoolBasin(lot, houses[lot.id]) })
  }

  // T42 — yard trees: 1-3 per lot, canopy fully clear of house/ell/driveway/
  // path/porch/pool deck. Runs after the pool guarantee; own derived stream.
  for (const lot of lots) {
    const h = houses[lot.id]
    const veg = new Prng((seed ^ 0x6e624eb7 ^ Math.imul(lot.id + 1, 0x9e3779b9)) >>> 0)
    const lotW = lot.rect.x1 - lot.rect.x0 + 1
    const lotD = lot.rect.z1 - lot.rect.z0 + 1
    const keepOut: Rect[] = [growRect(h.rect, 2), growRect(h.driveway, 2), growRect(h.path, 2)]
    if (h.ell) keepOut.push(growRect(h.ell, 2))
    if (h.porch) keepOut.push(growRect(h.porch, 2))
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

  // T42 — parkway street trees: alternating road sides every ~9.6 m, clear of
  // intersections and driveways (small/medium archetypes only near lamps)
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
      if (ROAD_CENTERS.some((c2) => Math.abs(a - c2) < ROAD_EXTENT + 12)) continue
      const perp = c + (k % 2 === 0 ? -(ROAD_EXTENT + 3) : ROAD_EXTENT + 2)
      const tx = road.axis === 'x' ? a : perp
      const tz = road.axis === 'x' ? perp : a
      const canopy: Rect = { x0: tx - canopyR, z0: tz - canopyR, x1: tx + 1 + canopyR, z1: tz + 1 + canopyR }
      if (houses.some((h) => rectsTouch(canopy, growRect(h.driveway, 4)) || rectsTouch(canopy, h.rect))) continue
      trees.push({ x: tx, z: tz, trunkH, canopyR, seed: treeSeed })
    }
  }

  // T43 — lamp posts: every ~12.8 m along each road on the outer sidewalk
  // edge, alternating sides, clear of intersections. Purely derived (no prng
  // needed — spacing is the aesthetic).
  for (const road of roads) {
    const c = road.center
    let k = 0
    for (let along = 64; along < WORLD_VX - 32; along += 128, k++) {
      if (ROAD_CENTERS.some((c2) => Math.abs(along - c2) < ROAD_EXTENT + 10)) continue
      const side = k % 2 === 0 ? 1 : -1
      const perp = c + side * (ROAD_EXTENT - 2)
      const dir: Side = road.axis === 'x' ? (side === 1 ? 'z-' : 'z+') : (side === 1 ? 'x-' : 'x+')
      lamps.push({
        x: road.axis === 'x' ? along : perp,
        z: road.axis === 'x' ? perp : along,
        dir,
      })
    }
  }

  return { seed, groundY: GROUND_Y, roads, lots, houses, pools, props, trees, shrubs, fences, lamps, mailboxes, bins }
}
