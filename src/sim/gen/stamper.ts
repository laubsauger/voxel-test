/**
 * T20 — scene stamper: declarative layout (T19) + prop voxel grids (.vox via
 * T18 or code-built placeholders) → ChunkStore writes.
 *
 * Runs once at world init, before tick 0 — world generation is the sim's
 * initial state, not a runtime mutation, so it writes through I.chunk
 * directly rather than the command stream (V1 governs post-init mutations).
 * Deterministic given (layout, propGrids): only randomness is a Prng derived
 * from layout.seed for terrain height variation (V2). Only material ids
 * 0..255 are written (V5).
 *
 * Stamp order (fixed): terrain → roads/sidewalks → driveways → houses →
 * pools → props. Pool water fills are returned as DATA for the integrator
 * to feed the water sim (water track API) — never written here.
 */

import { ChunkStore, CHUNK, WORLD_VX, WORLD_VZ } from '../../world/chunks'
import { Prng } from '../prng'
import {
  MAT_AIR,
  MAT_ASPHALT,
  MAT_CONCRETE,
  MAT_DIRT,
  MAT_GLASS,
  MAT_GRASS,
  MAT_WOOD,
} from '../materials'
import { WALL_T, type Box, type House, type Layout, type Opening, type Rect } from './layout'
import type { VoxelGrid } from '../vox/remap'

export interface WaterFillRequest {
  /** inclusive voxel box the water sim should fill (pool basin interior) */
  box: Box
}

export interface StampResult {
  waterFills: WaterFillRequest[]
}

const GRASS_DEPTH = 3
const ROAD_DEPTH = 3
const WALK_DEPTH = 2
const POOL_SHELL = 2

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x0 <= b.x1 && a.x1 >= b.x0 && a.z0 <= b.z1 && a.z1 >= b.z0
}

/** terrain: dirt slab + grass top, slight coarse height bumps away from structures */
function stampTerrain(store: ChunkStore, layout: Layout): void {
  const g = layout.groundY
  store.fillBox(0, 0, 0, WORLD_VX - 1, g - GRASS_DEPTH - 1, WORLD_VZ - 1, MAT_DIRT)
  store.fillBox(0, g - GRASS_DEPTH, 0, WORLD_VX - 1, g - 1, WORLD_VZ - 1, MAT_GRASS)

  // keep-flat zones: roads+sidewalks and whole lots (grown 1 for seams)
  const flat: Rect[] = []
  for (const r of layout.roads) flat.push(r.asphalt, ...r.sidewalks)
  for (const l of layout.lots) flat.push({ x0: l.rect.x0 - 1, z0: l.rect.z0 - 1, x1: l.rect.x1 + 1, z1: l.rect.z1 + 1 })

  const prng = new Prng((layout.seed ^ 0x9e3779b9) >>> 0)
  for (let tz = 0; tz < WORLD_VZ; tz += CHUNK) {
    for (let tx = 0; tx < WORLD_VX; tx += CHUNK) {
      const extra = prng.nextInt(3) // draw unconditionally: stream independent of flat zones
      if (extra === 0) continue
      const tile: Rect = { x0: tx, z0: tz, x1: tx + CHUNK - 1, z1: tz + CHUNK - 1 }
      if (flat.some((f) => rectsOverlap(f, tile))) continue
      store.fillBox(tx, g, tz, tx + CHUNK - 1, g + extra - 1, tz + CHUNK - 1, MAT_GRASS)
    }
  }
}

function stampRoads(store: ChunkStore, layout: Layout): void {
  const g = layout.groundY
  for (const road of layout.roads) {
    const a = road.asphalt
    store.fillBox(a.x0, g - ROAD_DEPTH, a.z0, a.x1, g - 1, a.z1, MAT_ASPHALT)
    for (const s of road.sidewalks) {
      store.fillBox(s.x0, g - WALK_DEPTH, s.z0, s.x1, g - 1, s.z1, MAT_CONCRETE)
    }
  }
}

/** carve one wall opening; door → air, window → glass pane */
function stampOpening(store: ChunkStore, h: House, o: Opening, mat: number, groundY: number): void {
  const y0 = groundY + o.floor * h.storyH + o.sill
  const y1 = y0 + o.h - 1
  const r = h.rect
  switch (o.side) {
    case 'z-':
      store.fillBox(r.x0 + o.offset, y0, r.z0, r.x0 + o.offset + o.w - 1, y1, r.z0 + 1, mat)
      break
    case 'z+':
      store.fillBox(r.x0 + o.offset, y0, r.z1 - 1, r.x0 + o.offset + o.w - 1, y1, r.z1, mat)
      break
    case 'x-':
      store.fillBox(r.x0, y0, r.z0 + o.offset, r.x0 + 1, y1, r.z0 + o.offset + o.w - 1, mat)
      break
    case 'x+':
      store.fillBox(r.x1 - 1, y0, r.z0 + o.offset, r.x1, y1, r.z0 + o.offset + o.w - 1, mat)
      break
  }
}

/** perimeter walls (thickness 2) over [y0..y1] for a rect */
function stampWalls(store: ChunkStore, r: Rect, y0: number, y1: number, mat: number): void {
  store.fillBox(r.x0, y0, r.z0, r.x1, y1, r.z0 + 1, mat)
  store.fillBox(r.x0, y0, r.z1 - 1, r.x1, y1, r.z1, mat)
  store.fillBox(r.x0, y0, r.z0, r.x0 + 1, y1, r.z1, mat)
  store.fillBox(r.x1 - 1, y0, r.z0, r.x1, y1, r.z1, mat)
}

function stampHouse(store: ChunkStore, layout: Layout, h: House): void {
  const g = layout.groundY
  const r = h.rect
  const wallTop = g + h.floors * h.storyH - 1

  // driveway first (under any car prop later)
  store.fillBox(h.driveway.x0, g - WALK_DEPTH, h.driveway.z0, h.driveway.x1, g - 1, h.driveway.z1, MAT_CONCRETE)

  // ground-floor slab, then walls (walls overwrite slab perimeter)
  store.fillBox(r.x0, g, r.z0, r.x1, g, r.z1, MAT_WOOD)
  stampWalls(store, r, g, wallTop, h.wallMat)

  // upper-story slabs (interior only)
  for (let f = 1; f < h.floors; f++) {
    store.fillBox(r.x0 + WALL_T, g + f * h.storyH - 1, r.z0 + WALL_T, r.x1 - WALL_T, g + f * h.storyH, r.z1 - WALL_T, MAT_WOOD)
  }

  // openings
  stampOpening(store, h, h.door, MAT_AIR, g)
  for (const win of h.windows) stampOpening(store, h, win, MAT_GLASS, g)

  // roof
  const roofY = wallTop + 1
  if (h.roof === 'flat') {
    store.fillBox(r.x0, roofY, r.z0, r.x1, roofY + 1, r.z1, MAT_CONCRETE)
  } else if (h.ridgeAxis === 'x') {
    // gable spanning z, slope 1 up : 2 in, solid wood levels (stepped gable + attic)
    for (let lvl = 0; r.z0 + 2 * lvl <= r.z1 - 2 * lvl; lvl++) {
      store.fillBox(r.x0, roofY + lvl, r.z0 + 2 * lvl, r.x1, roofY + lvl, r.z1 - 2 * lvl, MAT_WOOD)
    }
  } else {
    for (let lvl = 0; r.x0 + 2 * lvl <= r.x1 - 2 * lvl; lvl++) {
      store.fillBox(r.x0 + 2 * lvl, roofY + lvl, r.z0, r.x1 - 2 * lvl, roofY + lvl, r.z1, MAT_WOOD)
    }
  }

  // single-story L extension: slab + walls + flat roof
  if (h.ell) {
    const e = h.ell
    const eTop = g + h.storyH - 1
    store.fillBox(e.x0, g, e.z0, e.x1, g, e.z1, MAT_WOOD)
    stampWalls(store, e, g, eTop, h.wallMat)
    store.fillBox(e.x0, eTop + 1, e.z0, e.x1, eTop + 2, e.z1, MAT_CONCRETE)
  }
}

function stampPool(store: ChunkStore, basin: Box): void {
  // concrete shell around and below, then dig the interior to air
  store.fillBox(
    basin.x0 - POOL_SHELL, basin.y0 - POOL_SHELL, basin.z0 - POOL_SHELL,
    basin.x1 + POOL_SHELL, basin.y1, basin.z1 + POOL_SHELL,
    MAT_CONCRETE,
  )
  store.fillBox(basin.x0, basin.y0, basin.z0, basin.x1, basin.y1, basin.z1, MAT_AIR)
}

/** stamp a y-up material grid at (x,y,z) with rot quarter-turns around +y */
export function stampGrid(store: ChunkStore, grid: VoxelGrid, x: number, y: number, z: number, rot: 0 | 1 | 2 | 3): void {
  const { sx, sy, sz, mats } = grid
  for (let j = 0; j < sy; j++) {
    for (let k = 0; k < sz; k++) {
      for (let i = 0; i < sx; i++) {
        const mat = mats[i + k * sx + j * sx * sz]
        if (mat === 0) continue
        let dx = i
        let dz = k
        if (rot === 1) { dx = sz - 1 - k; dz = i }
        else if (rot === 2) { dx = sx - 1 - i; dz = sz - 1 - k }
        else if (rot === 3) { dx = k; dz = sx - 1 - i }
        store.setVoxel(x + dx, y + j, z + dz, mat)
      }
    }
  }
}

/**
 * Stamp the whole scene. propGrids must contain every Prop.kind used by the
 * layout — a missing grid throws (fail loud, no silent skips).
 */
export function stampScene(store: ChunkStore, layout: Layout, propGrids: Record<string, VoxelGrid>): StampResult {
  for (const p of layout.props) {
    if (!propGrids[p.kind]) throw new Error(`stampScene: no voxel grid for prop kind '${p.kind}'`)
  }

  stampTerrain(store, layout)
  stampRoads(store, layout)
  for (const h of layout.houses) stampHouse(store, layout, h)

  const waterFills: WaterFillRequest[] = []
  for (const pool of layout.pools) {
    stampPool(store, pool.basin)
    waterFills.push({ box: { ...pool.basin } })
  }

  for (const p of layout.props) stampGrid(store, propGrids[p.kind], p.x, p.y, p.z, p.rot)

  return { waterFills }
}
