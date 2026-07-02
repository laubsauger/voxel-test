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
import { MAT_BRICK, MAT_PLASTER } from '../materials'

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
}

export interface Pool {
  lotId: number
  /** interior basin volume (dug to air, lined with concrete around it) */
  basin: Box
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

    houses.push({ lotId: lot.id, rect, ell, floors, storyH: STORY_H, wallMat, roof, ridgeAxis, door, windows, driveway, stairs })

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
  }

  return { seed, groundY: GROUND_Y, roads, lots, houses, pools, props }
}
