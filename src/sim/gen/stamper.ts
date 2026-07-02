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
 * Stamp order (fixed): terrain → roads/sidewalks → road markings → houses
 * (driveway, path, walls, stairs, porch, shutters, roof) → pools → fences →
 * lamps → mailboxes → bins → props → vegetation (leaf blobs fill air only).
 * Pool water fills are returned as DATA for the integrator to feed the
 * water sim (water track API) — never written here.
 */

import { ChunkStore, CHUNK, WORLD_VX, WORLD_VZ } from '../../world/chunks'
import { Prng } from '../prng'
import {
  MAT_AIR,
  MAT_ASPHALT,
  MAT_BRICK,
  MAT_CONCRETE,
  MAT_DIRT,
  MAT_GLASS,
  MAT_GRASS,
  MAT_LAMP,
  MAT_LEAVES,
  MAT_METAL,
  MAT_PAINT,
  MAT_WOOD,
} from '../materials'
import {
  STAIR_RISE,
  STAIR_STEPS,
  STAIR_TREAD,
  WALL_T,
  type Bin,
  type Box,
  type FenceLine,
  type House,
  type Lamp,
  type Layout,
  type Mailbox,
  type Opening,
  type Rect,
  type Road,
  type Shrub,
  type Tree,
} from './layout'
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

/** paint the road-surface voxel, but ONLY where it is asphalt (markings never leak) */
function paintIfAsphalt(store: ChunkStore, x: number, y: number, z: number): void {
  if (store.getVoxel(x, y, z) === MAT_ASPHALT) store.setVoxel(x, y, z, MAT_PAINT)
}

function roadHalf(road: Road): number {
  return road.axis === 'x' ? (road.asphalt.z1 - road.asphalt.z0) >> 1 : (road.asphalt.x1 - road.asphalt.x0) >> 1
}

/** half-width including sidewalks (sidewalk strips cross the other road at intersections) */
function roadExtent(road: Road): number {
  const s = road.sidewalks[1]
  return road.axis === 'x' ? s.z1 - road.center : s.x1 - road.center
}

/**
 * T43 — road markings, derived purely from road geometry (no randomness):
 * dashed center line (12 on / 12 off, 2 wide) kept clear of intersections,
 * zebra crosswalks on all four approaches of every intersection. Paint is
 * stamped 1 voxel deep into the asphalt surface (y = groundY-1).
 */
function stampMarkings(store: ChunkStore, layout: Layout): void {
  const g = layout.groundY
  const y = g - 1
  const xRoads = layout.roads.filter((r) => r.axis === 'x')
  const zRoads = layout.roads.filter((r) => r.axis === 'z')

  for (const road of layout.roads) {
    const c = road.center
    const crossings = road.axis === 'x' ? zRoads : xRoads
    const len = road.axis === 'x' ? WORLD_VX : WORLD_VZ
    for (let a = 8; a + 12 <= len; a += 24) {
      // keep the intersection + crossing-sidewalk + crosswalk zone clean
      if (crossings.some((o) => a + 11 >= o.center - roadExtent(o) - 14 && a <= o.center + roadExtent(o) + 14)) continue
      for (let t = a; t < a + 12; t++) {
        for (const cc of [c - 1, c]) {
          if (road.axis === 'x') paintIfAsphalt(store, t, y, cc)
          else paintIfAsphalt(store, cc, y, t)
        }
      }
    }
  }

  for (const xr of xRoads) {
    for (const zr of zRoads) {
      const cx = zr.center
      const cz = xr.center
      const hx = roadHalf(zr)
      const hz = roadHalf(xr)
      const ex = roadExtent(zr) // clears the z-road's sidewalks crossing the x-road
      const ez = roadExtent(xr)
      // bands across the x-road (west/east approaches): stripes stacked along z
      for (const [b0, b1] of [
        [cx - ex - 9, cx - ex - 2],
        [cx + ex + 2, cx + ex + 9],
      ]) {
        for (let z = cz - hz + 2; z <= cz + hz - 2; z++) {
          if ((z - (cz - hz)) % 7 >= 4) continue
          for (let x = b0; x <= b1; x++) paintIfAsphalt(store, x, y, z)
        }
      }
      // bands across the z-road (north/south approaches): stripes stacked along x
      for (const [b0, b1] of [
        [cz - ez - 9, cz - ez - 2],
        [cz + ez + 2, cz + ez + 9],
      ]) {
        for (let x = cx - hx + 2; x <= cx + hx - 2; x++) {
          if ((x - (cx - hx)) % 7 >= 4) continue
          for (let z = b0; z <= b1; z++) paintIfAsphalt(store, x, y, z)
        }
      }
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

/** brick/concrete checker (2×2 cells) on the surface voxel of a rect */
function stampPavers(store: ChunkStore, r: Rect, g: number): void {
  for (let z = r.z0; z <= r.z1; z++) {
    for (let x = r.x0; x <= r.x1; x++) {
      if ((((x >> 1) + (z >> 1)) & 1) === 0) store.setVoxel(x, g - 1, z, MAT_BRICK)
    }
  }
}

function stampHouse(store: ChunkStore, layout: Layout, h: House): void {
  const g = layout.groundY
  const r = h.rect
  const wallTop = g + h.floors * h.storyH - 1

  // driveway first (under any car prop later); paver variant gets a
  // brick/concrete checker on the surface voxel
  store.fillBox(h.driveway.x0, g - WALK_DEPTH, h.driveway.z0, h.driveway.x1, g - 1, h.driveway.z1, MAT_CONCRETE)
  if (h.driveMat === 'paver') stampPavers(store, h.driveway, g)

  // garden path: paver strip from the front lot edge to the door/porch
  store.fillBox(h.path.x0, g - WALK_DEPTH, h.path.z0, h.path.x1, g - 1, h.path.z1, MAT_CONCRETE)
  stampPavers(store, h.path, g)

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

  // interior stairs (T41): solid stepped run + matching opening in the upper slab
  if (h.stairs) {
    const s = h.stairs
    // carve the slab over the whole run so a climbing capsule never bonks:
    // grown 1 laterally toward the room interior and 3 past the top end (landing)
    const nearBackZplus = s.rect.z1 === r.z1 - WALL_T
    const oz0 = nearBackZplus ? s.rect.z0 - 1 : s.rect.z0
    const oz1 = nearBackZplus ? s.rect.z1 : s.rect.z1 + 1
    const ox0 = Math.max(r.x0 + WALL_T, s.dir === 1 ? s.rect.x0 : s.rect.x0 - 3)
    const ox1 = Math.min(r.x1 - WALL_T, s.dir === 1 ? s.rect.x1 + 3 : s.rect.x1)
    const slabY = g + h.storyH // first upper slab; stairs reach floor 1 only
    store.fillBox(ox0, slabY - 1, oz0, ox1, slabY, oz1, MAT_AIR)
    // steps: solid wood columns floor→tread top (structurally sound, connectivity-friendly)
    for (let i = 0; i < STAIR_STEPS; i++) {
      const top = g + (i + 1) * STAIR_RISE
      const a = i * STAIR_TREAD
      const x0 = s.dir === 1 ? s.rect.x0 + a : s.rect.x1 - a - (STAIR_TREAD - 1)
      store.fillBox(x0, g + 1, s.rect.z0, x0 + STAIR_TREAD - 1, top, s.rect.z1, MAT_WOOD)
    }
  }

  // roof (gable material varies per house: wood or rooftile, T43)
  const roofY = wallTop + 1
  if (h.roof === 'flat') {
    store.fillBox(r.x0, roofY, r.z0, r.x1, roofY + 1, r.z1, MAT_CONCRETE)
  } else if (h.ridgeAxis === 'x') {
    // gable spanning z, slope 1 up : 2 in, solid levels (stepped gable + attic)
    for (let lvl = 0; r.z0 + 2 * lvl <= r.z1 - 2 * lvl; lvl++) {
      store.fillBox(r.x0, roofY + lvl, r.z0 + 2 * lvl, r.x1, roofY + lvl, r.z1 - 2 * lvl, h.roofMat)
    }
  } else {
    for (let lvl = 0; r.x0 + 2 * lvl <= r.x1 - 2 * lvl; lvl++) {
      store.fillBox(r.x0 + 2 * lvl, roofY + lvl, r.z0, r.x1 - 2 * lvl, roofY + lvl, r.z1, h.roofMat)
    }
  }

  // porch (T43): concrete stoop + wood corner posts + small wood awning
  if (h.porch) {
    const p = h.porch
    store.fillBox(p.x0, g, p.z0, p.x1, g, p.z1, MAT_CONCRETE)
    const outerZ = p.z0 < r.z0 ? p.z0 : p.z1 // porch edge away from the house
    const awnY = g + 23
    for (const px of [p.x0, p.x1]) {
      store.fillBox(px, g + 1, outerZ, px, awnY - 1, outerZ, MAT_WOOD)
    }
    store.fillBox(p.x0, awnY, p.z0, p.x1, awnY + 1, p.z1, MAT_WOOD)
  }

  // window shutters (T43): wood panels flanking front-wall windows
  if (h.shutters) {
    const outZ = h.door.side === 'z-' ? r.z0 - 1 : r.z1 + 1
    for (const win of h.windows) {
      if (win.side !== h.door.side) continue
      const y0 = g + win.floor * h.storyH + win.sill
      const y1 = y0 + win.h - 1
      store.fillBox(r.x0 + win.offset - 3, y0, outZ, r.x0 + win.offset - 2, y1, outZ, MAT_WOOD)
      store.fillBox(r.x0 + win.offset + win.w + 1, y0, outZ, r.x0 + win.offset + win.w + 2, y1, outZ, MAT_WOOD)
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

/**
 * T42 — vegetation. Deterministic integer hash for ragged canopy edges
 * (pure fn of position+seed — no stream to get out of order, V2-safe).
 */
function hash3(x: number, y: number, z: number, seed: number): number {
  let h = (seed ^ Math.imul(x + 1, 0x9e3779b1) ^ Math.imul(y + 1, 0x85ebca6b) ^ Math.imul(z + 1, 0xc2b2ae35)) >>> 0
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d) >>> 0
  return (h ^ (h >>> 13)) >>> 0
}

/** slightly-oblate leaf blob; fills AIR only so it never eats structures */
function fillLeafBlob(store: ChunkStore, cx: number, cy: number, cz: number, r: number, seed: number): void {
  const r2 = r * r
  const shell = (r - 1) * (r - 1)
  for (let y = cy - r; y <= cy + r; y++) {
    for (let z = cz - r; z <= cz + r; z++) {
      for (let x = cx - r; x <= cx + r; x++) {
        const dx = x - cx
        const dy = y - cy
        const dz = z - cz
        const d2 = dx * dx + dy * dy + ((dy * dy) >> 1) + dz * dz
        if (d2 > r2) continue
        // ragged edge: drop ~37% of the outer shell
        if (d2 > shell && (hash3(x, y, z, seed) & 7) < 3) continue
        if (store.getVoxel(x, y, z) === MAT_AIR) store.setVoxel(x, y, z, MAT_LEAVES)
      }
    }
  }
}

function stampTree(store: ChunkStore, t: Tree, g: number): void {
  const p = new Prng(t.seed)
  // trunk 2×2, rooted 2 into the ground (grass bumps reach +2)
  store.fillBox(t.x, g - 2, t.z, t.x + 1, g + t.trunkH - 1, t.z + 1, MAT_WOOD)
  // canopy: main blob over the trunk top + 2-4 offset sub-blobs
  const cy = g + t.trunkH + (t.canopyR >> 1) - 1
  fillLeafBlob(store, t.x, cy, t.z, t.canopyR, t.seed)
  const blobs = 2 + p.nextInt(3)
  for (let i = 0; i < blobs; i++) {
    const r = Math.max(3, t.canopyR - 2 - p.nextInt(3))
    const ox = p.nextInt(t.canopyR + 1) - (t.canopyR >> 1)
    const oy = p.nextInt((t.canopyR >> 1) + 1) - (t.canopyR >> 2)
    const oz = p.nextInt(t.canopyR + 1) - (t.canopyR >> 1)
    fillLeafBlob(store, t.x + ox, cy + oy, t.z + oz, r, (t.seed + i + 1) >>> 0)
  }
}

function stampShrub(store: ChunkStore, s: Shrub, g: number): void {
  // half-buried blob → leafy mound sitting on the grass
  fillLeafBlob(store, s.x, g + 1, s.z, s.r, s.seed)
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

/**
 * T43 — picket fence along an axis-aligned line: posts every 16 voxels,
 * 1-wide pickets every other voxel, two rails bridging the picket gaps.
 * All wood — collapses beautifully.
 */
function stampFence(store: ChunkStore, f: FenceLine, g: number): void {
  const alongX = f.z0 === f.z1
  const len = (alongX ? f.x1 - f.x0 : f.z1 - f.z0) + 1
  if (len < 4) return
  for (let t = 0; t < len; t++) {
    const x = alongX ? f.x0 + t : f.x0
    const z = alongX ? f.z0 : f.z0 + t
    if (t % 16 === 0 || t === len - 1) {
      store.fillBox(x, g, z, x, g + 10, z, MAT_WOOD) // post
    } else if (t % 2 === 0) {
      store.fillBox(x, g, z, x, g + 8, z, MAT_WOOD) // picket
    } else {
      store.setVoxel(x, g + 3, z, MAT_WOOD) // lower rail
      store.setVoxel(x, g + 7, z, MAT_WOOD) // upper rail
    }
  }
}

/** T43 — street lamp: metal pole + arm toward the road, emissive MAT_LAMP head */
function stampLampPost(store: ChunkStore, l: Lamp, g: number): void {
  store.fillBox(l.x, g, l.z, l.x, g + 23, l.z, MAT_METAL)
  const dx = l.dir === 'x-' ? -1 : l.dir === 'x+' ? 1 : 0
  const dz = l.dir === 'z-' ? -1 : l.dir === 'z+' ? 1 : 0
  for (let i = 1; i <= 3; i++) store.setVoxel(l.x + dx * i, g + 23, l.z + dz * i, MAT_METAL)
  const hx = l.x + dx * 3
  const hz = l.z + dz * 3
  store.fillBox(Math.min(hx, hx + dx), g + 21, Math.min(hz, hz + dz), Math.max(hx, hx + dx), g + 22, Math.max(hz, hz + dz), MAT_LAMP)
}

/** T43 — mailbox: wood post + metal box */
function stampMailbox(store: ChunkStore, m: Mailbox, g: number): void {
  store.fillBox(m.x, g, m.z, m.x, g + 9, m.z, MAT_WOOD)
  store.fillBox(m.x - 1, g + 10, m.z - 1, m.x + 1, g + 12, m.z + 1, MAT_METAL)
}

/** T43 — trash bin: squat metal block */
function stampBin(store: ChunkStore, b: Bin, g: number): void {
  store.fillBox(b.x, g, b.z, b.x + 3, g + 8, b.z + 3, MAT_METAL)
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
  stampMarkings(store, layout)
  for (const h of layout.houses) stampHouse(store, layout, h)

  const waterFills: WaterFillRequest[] = []
  for (const pool of layout.pools) {
    stampPool(store, pool.basin)
    waterFills.push({ box: { ...pool.basin } })
  }

  for (const f of layout.fences) stampFence(store, f, layout.groundY)
  for (const l of layout.lamps) stampLampPost(store, l, layout.groundY)
  for (const m of layout.mailboxes) stampMailbox(store, m, layout.groundY)
  for (const b of layout.bins) stampBin(store, b, layout.groundY)

  for (const p of layout.props) stampGrid(store, propGrids[p.kind], p.x, p.y, p.z, p.rot)

  // vegetation last: leaf blobs fill AIR only, so canopies drape around
  // everything already stamped instead of overwriting it
  for (const t of layout.trees) stampTree(store, t, layout.groundY)
  for (const s of layout.shrubs) stampShrub(store, s, layout.groundY)

  return { waterFills }
}
