/**
 * T20/T50/T51 — scene stamper: declarative layout (T19/T50) + prop voxel
 * grids (.vox via T18 or code-built placeholders) → ChunkStore writes.
 *
 * Runs once at world init, before tick 0 — world generation is the sim's
 * initial state, not a runtime mutation, so it writes through I.chunk
 * directly rather than the command stream (V1 governs post-init mutations).
 * Deterministic given (layout, propGrids): only randomness is a Prng derived
 * from layout.seed for terrain height variation, plus pure position hashes
 * (V2). Only material ids 0..255 are written (V5).
 *
 * Stamp order (fixed): terrain → roads/sidewalks → road markings → houses
 * (driveway, path, walls, garage, stairs, partitions, porch, balcony,
 * shutters, roof, chimney, patio, gardens) → rowhouse blocks → plazas →
 * towers → parking lots → pools → ponds → beaches/ocean → park paths →
 * fences → lamps → mailboxes → bins → props (cars, furniture, sheds, benches) → vegetation
 * (leaf blobs fill air only). Pool/pond water fills are returned as DATA for
 * the integrator to feed the water sim — never written here.
 */

import { ChunkStore, CHUNK, VOXEL_SIZE, WORLD_VX, WORLD_VZ } from '../../world/chunks'
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
  MAT_PLASTER,
  MAT_ROOFTILE,
  MAT_SAND,
  MAT_WOOD,
} from '../materials'
import {
  DOOR_H,
  DOOR_W,
  STAIR_RISE,
  STAIR_STEPS,
  STAIR_TREAD,
  STAIR_W,
  STORY_H,
  isCarKind,
  type Airport,
  type DesertPlot,
  type Farmhouse,
  type Trailer,
  STALL_D,
  STALL_W,
  TOWER_STAIR_RUN,
  TOWER_STAIR_STEPS,
  WALL_T,
  type Bin,
  type Beach,
  type Box,
  type FenceLine,
  type House,
  type Lamp,
  type Layout,
  type Mailbox,
  type Opening,
  type ParkingLot,
  type Partition,
  type Pond,
  type Rect,
  type Road,
  type RowBlock,
  type Shrub,
  type Side,
  type Tower,
  type Tree,
} from './layout'
import type { VoxelGrid } from '../vox/remap'

export interface WaterFillRequest {
  /** inclusive voxel box the water sim should fill (basin interior; the CA
   * skips solid voxels, so pond bounding boxes are safe) */
  box: Box
}

/** T64 — parked car props become real drivable vehicles: returned as DATA for
 * the integrator to spawnVehicle() with, never stamped as voxels. */
export interface VehicleSpawnRequest {
  archetype: string
  /** footprint center, world meters; cy = ground surface under the wheels */
  cx: number
  cy: number
  cz: number
  yaw: number
}

/** P17 — an airport plane converted to a flyable aircraft entity: returned as
 * DATA for the integrator to spawnAircraft() with, never stamped as voxels. */
export interface AircraftSpawnRequest {
  /** footprint center, world meters; cy = ground surface under the gear */
  cx: number
  cy: number
  cz: number
  yaw: number
}

export interface StampResult {
  waterFills: WaterFillRequest[]
  vehicleSpawns: VehicleSpawnRequest[]
  aircraftSpawns: AircraftSpawnRequest[]
}

const GRASS_DEPTH = 3
const ROAD_DEPTH = 3
const WALK_DEPTH = 2
const POOL_SHELL = 2
const BEACH_SAND_MAT = MAT_SAND // B32 — real sand, was plaster

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x0 <= b.x1 && a.x1 >= b.x0 && a.z0 <= b.z1 && a.z1 >= b.z0
}

/** terrain: dirt slab + grass top, slight coarse height bumps away from structures */
function stampTerrain(store: ChunkStore, layout: Layout): void {
  const g = layout.groundY
  store.fillBox(0, 0, 0, WORLD_VX - 1, g - GRASS_DEPTH - 1, WORLD_VZ - 1, MAT_DIRT)
  store.fillBox(0, g - GRASS_DEPTH, 0, WORLD_VX - 1, g - 1, WORLD_VZ - 1, MAT_GRASS)

  // keep-flat zones: roads+sidewalks, whole lots, rowhouse + commercial
  // blocks (grown 1 for seams). Park blocks keep their meadow bumps.
  const flat: Rect[] = []
  for (const r of layout.roads) flat.push(r.asphalt, ...r.sidewalks)
  for (const l of layout.lots) flat.push({ x0: l.rect.x0 - 1, z0: l.rect.z0 - 1, x1: l.rect.x1 + 1, z1: l.rect.z1 + 1 })
  for (const d of layout.districts) {
    if (d.kind === 'rowhouse' || d.kind === 'commercial') {
      flat.push({ x0: d.rect.x0 - 1, z0: d.rect.z0 - 1, x1: d.rect.x1 + 1, z1: d.rect.z1 + 1 })
    }
  }

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
 * T43/T50 — road markings, derived purely from road geometry (no randomness).
 * Residential: dashed center line (12 on / 12 off, 2 wide). Arterial: double
 * solid center line + dashed lane lines at ±20 (markings scale with the road
 * hierarchy, T50). Zebra crosswalks on all four approaches of every
 * intersection. Paint is stamped 1 voxel deep into the asphalt surface.
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
    const paintAt = (t: number, cc: number): void => {
      if (road.axis === 'x') paintIfAsphalt(store, t, y, cc)
      else paintIfAsphalt(store, cc, y, t)
    }
    if (road.kind === 'arterial') {
      // double solid center line, clear of intersections
      for (let a = 0; a < len; a++) {
        if (crossings.some((o) => a >= o.center - roadExtent(o) - 14 && a <= o.center + roadExtent(o) + 14)) continue
        paintAt(a, c - 2)
        paintAt(a, c + 1)
      }
      // dashed lane separators
      for (let a = 8; a + 12 <= len; a += 24) {
        if (crossings.some((o) => a + 11 >= o.center - roadExtent(o) - 14 && a <= o.center + roadExtent(o) + 14)) continue
        for (let t = a; t < a + 12; t++) {
          paintAt(t, c - 20)
          paintAt(t, c + 19)
        }
      }
    } else {
      for (let a = 8; a + 12 <= len; a += 24) {
        // keep the intersection + crossing-sidewalk + crosswalk zone clean
        if (crossings.some((o) => a + 11 >= o.center - roadExtent(o) - 14 && a <= o.center + roadExtent(o) + 14)) continue
        for (let t = a; t < a + 12; t++) {
          for (const cc of [c - 1, c]) paintAt(t, cc)
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

/** carve one opening through the walls of an arbitrary rect footprint */
function wallOpening(
  store: ChunkStore,
  r: Rect,
  side: Side,
  offset: number,
  w: number,
  y0: number,
  y1: number,
  mat: number,
): void {
  switch (side) {
    case 'z-':
      store.fillBox(r.x0 + offset, y0, r.z0, r.x0 + offset + w - 1, y1, r.z0 + 1, mat)
      break
    case 'z+':
      store.fillBox(r.x0 + offset, y0, r.z1 - 1, r.x0 + offset + w - 1, y1, r.z1, mat)
      break
    case 'x-':
      store.fillBox(r.x0, y0, r.z0 + offset, r.x0 + 1, y1, r.z0 + offset + w - 1, mat)
      break
    case 'x+':
      store.fillBox(r.x1 - 1, y0, r.z0 + offset, r.x1, y1, r.z0 + offset + w - 1, mat)
      break
  }
}

/** carve one wall opening of a house; door → air, window → glass pane */
function stampOpening(store: ChunkStore, h: House, o: Opening, mat: number, groundY: number): void {
  const y0 = groundY + o.floor * h.storyH + o.sill
  wallOpening(store, h.rect, o.side, o.offset, o.w, y0, y0 + o.h - 1, mat)
}

/** perimeter walls (thickness 2) over [y0..y1] for a rect */
function stampWalls(store: ChunkStore, r: Rect, y0: number, y1: number, mat: number): void {
  store.fillBox(r.x0, y0, r.z0, r.x1, y1, r.z0 + 1, mat)
  store.fillBox(r.x0, y0, r.z1 - 1, r.x1, y1, r.z1, mat)
  store.fillBox(r.x0, y0, r.z0, r.x0 + 1, y1, r.z1, mat)
  store.fillBox(r.x1 - 1, y0, r.z0, r.x1, y1, r.z1, mat)
}

/**
 * B12 — subtle paver treatment: the surface stays concrete; sparse 3×3
 * rooftile accent tiles (~1 in 8, world-aligned) suggest paving without the
 * old high-contrast per-voxel checker.
 */
function stampPavers(store: ChunkStore, r: Rect, g: number): void {
  for (let z = r.z0; z <= r.z1; z++) {
    for (let x = r.x0; x <= r.x1; x++) {
      const tx = (x / 3) | 0
      const tz = (z / 3) | 0
      if ((hash3(tx, 0, tz, 0x9a3f11d7) & 7) !== 0) continue
      if (store.getVoxel(x, g - 1, z) === MAT_CONCRETE) store.setVoxel(x, g - 1, z, MAT_ROOFTILE)
    }
  }
}

/** solid straight stair run: columns floor→tread top (connectivity-friendly) */
function stampStairRun(
  store: ChunkStore,
  rect: Rect,
  axis: 'x' | 'z',
  dir: 1 | -1,
  baseY: number,
  steps: number,
  mat: number,
): void {
  for (let i = 0; i < steps; i++) {
    const top = baseY + (i + 1) * STAIR_RISE
    const a = i * STAIR_TREAD
    if (axis === 'x') {
      const x0 = dir === 1 ? rect.x0 + a : rect.x1 - a - (STAIR_TREAD - 1)
      store.fillBox(x0, baseY + 1, rect.z0, x0 + STAIR_TREAD - 1, top, rect.z1, mat)
    } else {
      const z0 = dir === 1 ? rect.z0 + a : rect.z1 - a - (STAIR_TREAD - 1)
      store.fillBox(rect.x0, baseY + 1, z0, rect.x1, top, z0 + STAIR_TREAD - 1, mat)
    }
  }
}

/** T51 — interior partition wall (plaster, 1 thick) with a door gap */
function stampPartition(store: ChunkStore, h: House, p: Partition, g: number): void {
  const base = g + p.floor * h.storyH
  const wallTop = g + h.floors * h.storyH - 1
  const yTop = p.floor === h.floors - 1 ? wallTop : base + h.storyH - 2
  if (p.axis === 'x') {
    store.fillBox(p.a0, base + 1, p.c, p.a1, yTop, p.c, MAT_PLASTER)
    store.fillBox(p.doorAt, base + 1, p.c, p.doorAt + DOOR_W - 1, base + DOOR_H, p.c, MAT_AIR)
  } else {
    store.fillBox(p.c, base + 1, p.a0, p.c, yTop, p.a1, MAT_PLASTER)
    store.fillBox(p.c, base + 1, p.doorAt, p.c, base + DOOR_H, p.doorAt + DOOR_W - 1, MAT_AIR)
  }
}

function stampHouse(store: ChunkStore, layout: Layout, h: House): void {
  const g = layout.groundY
  const r = h.rect
  const wallTop = g + h.floors * h.storyH - 1

  // T59 — worn lawn patches first (everything else overwrites them)
  for (const wp of h.wornPatches) {
    const r2 = wp.r * wp.r
    for (let z = wp.z - wp.r; z <= wp.z + wp.r; z++) {
      for (let x = wp.x - wp.r; x <= wp.x + wp.r; x++) {
        const dx = x - wp.x
        const dz = z - wp.z
        if (dx * dx + dz * dz > r2) continue
        if ((hash3(x, 3, z, 0x5eed1) & 3) === 0) continue // ragged edge
        if (store.getVoxel(x, g - 1, z) === MAT_GRASS) store.setVoxel(x, g - 1, z, MAT_DIRT)
      }
    }
  }

  // driveway first (under any car prop later); paver variant gets subtle
  // accent tiles on the surface voxel (B12)
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
  if (h.balconyDoor) stampOpening(store, h, h.balconyDoor, MAT_AIR, g)

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
    stampStairRun(store, s.rect, 'x', s.dir, g, STAIR_STEPS, MAT_WOOD)
  }

  // T51 — interior room partitions (after stairs so nothing carves them away)
  for (const p of h.partitions) stampPartition(store, h, p, g)

  // T51 — attached garage: slab, walls, roll-door opening, side door to house
  if (h.garage) {
    const ga = h.garage
    const gTop = g + 23
    store.fillBox(ga.x0, g, ga.z0, ga.x1, g, ga.z1, MAT_CONCRETE)
    stampWalls(store, ga, g + 1, gTop, h.wallMat)
    store.fillBox(ga.x0, gTop + 1, ga.z0, ga.x1, gTop + 2, ga.z1, MAT_CONCRETE)
    const frontZneg = h.door.side === 'z-'
    // roll-door bay + metal lintel on the street face; ~half the doors are
    // down (T59 lived-in): a metal panel fills the bay instead of air
    wallOpening(store, ga, frontZneg ? 'z-' : 'z+', 4, 20, g + 1, g + 18, h.garageOpen ? MAT_AIR : MAT_METAL)
    wallOpening(store, ga, frontZneg ? 'z-' : 'z+', 4, 20, g + 19, g + 20, MAT_METAL)
    // connecting door through the shared garage/house wall pair
    const doorZ = frontZneg ? r.z0 + 6 : r.z1 - 13
    if (ga.x1 < r.x0) {
      store.fillBox(ga.x1 - 1, g + 1, doorZ, r.x0 + 1, g + 20, doorZ + 7, MAT_AIR)
    } else {
      store.fillBox(r.x1 - 1, g + 1, doorZ, ga.x0 + 1, g + 20, doorZ + 7, MAT_AIR)
    }
  }

  // roof (gable/hip material varies per house: wood or rooftile, T43/T51)
  const roofY = wallTop + 1
  if (h.roof === 'flat') {
    store.fillBox(r.x0, roofY, r.z0, r.x1, roofY + 1, r.z1, MAT_CONCRETE)
  } else if (h.roof === 'hip') {
    // slopes on all four sides, solid stepped levels
    for (let lvl = 0; r.x0 + 2 * lvl <= r.x1 - 2 * lvl && r.z0 + 2 * lvl <= r.z1 - 2 * lvl; lvl++) {
      store.fillBox(r.x0 + 2 * lvl, roofY + lvl, r.z0 + 2 * lvl, r.x1 - 2 * lvl, roofY + lvl, r.z1 - 2 * lvl, h.roofMat)
    }
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

  // T51 — brick chimney through the roof ridge
  if (h.chimney) {
    const peakSpan = h.roof === 'hip' ? Math.min(r.x1 - r.x0, r.z1 - r.z0) : h.ridgeAxis === 'x' ? r.z1 - r.z0 : r.x1 - r.x0
    const chimTop = roofY + ((peakSpan / 4) | 0) + 4
    store.fillBox(h.chimney.x, wallTop - 2, h.chimney.z, h.chimney.x + 2, chimTop, h.chimney.z + 2, MAT_BRICK)
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

  // T51 — balcony: concrete slab at floor-1 level + wood post/rail railing
  if (h.balcony) {
    const b = h.balcony
    const slabY = g + h.storyH - 1
    store.fillBox(b.x0, slabY, b.z0, b.x1, slabY + 1, b.z1, MAT_CONCRETE)
    const railBase = slabY + 2
    const outerZ = b.z1 < r.z0 ? b.z0 : b.z1 // edge away from the house
    // rail cap along the three free edges + posts every 4 voxels
    for (let x = b.x0; x <= b.x1; x++) {
      store.fillBox(x, railBase + 5, outerZ, x, railBase + 6, outerZ, MAT_WOOD)
      if ((x - b.x0) % 4 === 0) store.fillBox(x, railBase, outerZ, x, railBase + 6, outerZ, MAT_WOOD)
    }
    const innerZ0 = Math.min(b.z0, b.z1)
    const innerZ1 = Math.max(b.z0, b.z1)
    for (const bx of [b.x0, b.x1]) {
      for (let z = innerZ0; z <= innerZ1; z++) {
        store.fillBox(bx, railBase + 5, z, bx, railBase + 6, z, MAT_WOOD)
        if ((z - innerZ0) % 4 === 0) store.fillBox(bx, railBase, z, bx, railBase + 6, z, MAT_WOOD)
      }
    }
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

  // T51 — backyard patio (subtle pavers) + raised garden beds
  if (h.patio) {
    store.fillBox(h.patio.x0, g - WALK_DEPTH, h.patio.z0, h.patio.x1, g - 1, h.patio.z1, MAT_CONCRETE)
    stampPavers(store, h.patio, g)
  }
  for (const bed of h.gardens) {
    // wood border ring, dirt fill, sparse leaf crop rows
    store.fillBox(bed.x0, g, bed.z0, bed.x1, g + 1, bed.z1, MAT_WOOD)
    store.fillBox(bed.x0 + 1, g, bed.z0 + 1, bed.x1 - 1, g, bed.z1 - 1, MAT_DIRT)
    store.fillBox(bed.x0 + 1, g + 1, bed.z0 + 1, bed.x1 - 1, g + 1, bed.z1 - 1, MAT_AIR)
    for (let x = bed.x0 + 1; x <= bed.x1 - 1; x++) {
      if ((x - bed.x0) % 3 !== 1) continue
      for (let z = bed.z0 + 1; z <= bed.z1 - 1; z++) store.setVoxel(x, g + 1, z, MAT_LEAVES)
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
 * T50 — rowhouse block: party-walled units, per-unit doors/stoops/windows,
 * interior switchback stairs, stepped flat roofs with parapets. Openings and
 * stairs are derived from unit geometry (deterministic, no draws).
 */
function stampRowBlock(store: ChunkStore, layout: Layout, b: RowBlock): void {
  const g = layout.groundY
  const frontZneg = b.front === 'z-'
  for (const u of b.units) {
    const ur: Rect = { x0: u.x0, z0: b.rect.z0, x1: u.x1, z1: b.rect.z1 }
    const wallTop = g + u.floors * b.storyH - 1
    // slab + walls
    store.fillBox(ur.x0, g, ur.z0, ur.x1, g, ur.z1, MAT_WOOD)
    stampWalls(store, ur, g, wallTop, u.wallMat)
    for (let f = 1; f < u.floors; f++) {
      store.fillBox(ur.x0 + WALL_T, g + f * b.storyH - 1, ur.z0 + WALL_T, ur.x1 - WALL_T, g + f * b.storyH, ur.z1 - WALL_T, MAT_WOOD)
    }
    // flat roof + street-side parapet
    store.fillBox(ur.x0, wallTop + 1, ur.z0, ur.x1, wallTop + 2, ur.z1, MAT_CONCRETE)
    stampWalls(store, ur, wallTop + 3, wallTop + 4, u.wallMat)

    const w = ur.x1 - ur.x0 + 1
    const doorOff = (w - DOOR_W) >> 1
    // front door + concrete stoop
    wallOpening(store, ur, b.front, doorOff, DOOR_W, g + 1, g + DOOR_H, MAT_AIR)
    const stoopZ = frontZneg ? ur.z0 - 3 : ur.z1 + 1
    store.fillBox(ur.x0 + doorOff - 1, g, stoopZ, ur.x0 + doorOff + DOOR_W, g, stoopZ + 2, MAT_CONCRETE)
    // back door to the garden band
    wallOpening(store, ur, frontZneg ? 'z+' : 'z-', doorOff + 6 <= w - 12 ? doorOff + 6 : doorOff, 8, g + 1, g + 20, MAT_AIR)

    // windows: front + back walls only (party walls stay solid)
    for (let f = 0; f < u.floors; f++) {
      for (const off of [((w / 4) | 0) - 4, ((3 * w) / 4 | 0) - 4]) {
        for (const side of [b.front, frontZneg ? 'z+' : 'z-'] as Side[]) {
          if (f === 0 && side === b.front && off + 8 >= doorOff - 2 && off <= doorOff + DOOR_W + 2) continue
          wallOpening(store, ur, side, off, 8, g + f * b.storyH + 10, g + f * b.storyH + 21, MAT_GLASS)
        }
      }
    }

    // switchback stairs along the x- party wall, one run per story
    const runX: Rect = { x0: ur.x0 + WALL_T, z0: 0, x1: ur.x0 + WALL_T + STAIR_W - 1, z1: 0 }
    const iz0 = ur.z0 + WALL_T
    const iz1 = ur.z1 - WALL_T
    for (let f = 0; f < u.floors - 1; f++) {
      const dir: 1 | -1 = f % 2 === 0 ? 1 : -1
      const run: Rect =
        dir === 1
          ? { x0: runX.x0, z0: iz1 - STAIR_TREAD * STAIR_STEPS + 1, x1: runX.x1, z1: iz1 }
          : { x0: runX.x0, z0: iz0, x1: runX.x1, z1: iz0 + STAIR_TREAD * STAIR_STEPS - 1 }
      const base = g + f * b.storyH
      // carve the slab above over the run (grown 1 toward the room, 3 past the top)
      const ox0 = runX.x0
      const ox1 = Math.min(ur.x1 - WALL_T, runX.x1 + 1)
      const oz0 = Math.max(iz0, dir === 1 ? run.z0 : run.z0 - 3)
      const oz1 = Math.min(iz1, dir === 1 ? run.z1 + 3 : run.z1)
      store.fillBox(ox0, base + b.storyH - 1, oz0, ox1, base + b.storyH, oz1, MAT_AIR)
      stampStairRun(store, run, 'z', dir, base, STAIR_STEPS, MAT_WOOD)
    }
  }
}

/** deterministic integer hash (pure fn of position+seed — V2-safe) */
function hash3(x: number, y: number, z: number, seed: number): number {
  let h = (seed ^ Math.imul(x + 1, 0x9e3779b1) ^ Math.imul(y + 1, 0x85ebca6b) ^ Math.imul(z + 1, 0xc2b2ae35)) >>> 0
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d) >>> 0
  return (h ^ (h >>> 13)) >>> 0
}

/**
 * T50 — commercial tower: concrete frame (corner columns + spandrel bands),
 * glass curtain rows with metal mullions, interior slabs, flat roof with
 * parapet + HVAC boxes, entrance + canopy, and an explorable core: concrete
 * ring, switchback stair runs, and an open elevator shaft (metal guard wall
 * with per-floor door gaps — a 15-story drop for the careless).
 */
function stampTower(store: ChunkStore, layout: Layout, t: Tower): void {
  const g = layout.groundY
  const r = t.rect
  const wallTop = g + t.floors * t.storyH - 1
  const roofY = wallTop + 1

  // ground slab + full-height concrete shell, then glass bands carved in
  store.fillBox(r.x0, g, r.z0, r.x1, g, r.z1, MAT_CONCRETE)
  stampWalls(store, r, g + 1, wallTop, MAT_CONCRETE)

  for (let f = 0; f < t.floors; f++) {
    const yb = g + f * t.storyH
    const gy0 = yb + 5
    const gy1 = yb + t.storyH - 1
    if (t.style === 0) {
      // glass curtain per wall (corner columns 4 wide stay concrete)
      store.fillBox(r.x0 + 4, gy0, r.z0, r.x1 - 4, gy1, r.z0 + 1, MAT_GLASS)
      store.fillBox(r.x0 + 4, gy0, r.z1 - 1, r.x1 - 4, gy1, r.z1, MAT_GLASS)
      store.fillBox(r.x0, gy0, r.z0 + 4, r.x0 + 1, gy1, r.z1 - 4, MAT_GLASS)
      store.fillBox(r.x1 - 1, gy0, r.z0 + 4, r.x1, gy1, r.z1 - 4, MAT_GLASS)
      // metal mullions
      for (let x = r.x0 + 4 + t.mullion; x <= r.x1 - 5; x += t.mullion) {
        store.fillBox(x, gy0, r.z0, x, gy1, r.z0 + 1, MAT_METAL)
        store.fillBox(x, gy0, r.z1 - 1, x, gy1, r.z1, MAT_METAL)
      }
      for (let z = r.z0 + 4 + t.mullion; z <= r.z1 - 5; z += t.mullion) {
        store.fillBox(r.x0, gy0, z, r.x0 + 1, gy1, z, MAT_METAL)
        store.fillBox(r.x1 - 1, gy0, z, r.x1, gy1, z, MAT_METAL)
      }
    } else {
      // P23 style 1 — sleek HORIZONTAL-RIBBON tower: a continuous glass skin
      // with a METAL SPANDREL band at each floor line (strong horizontal
      // emphasis vs style 0's vertical mullions), corner columns in metal too.
      // No brick — a clean modern-corporate look distinct from the glass grid.
      store.fillBox(r.x0 + 3, gy0, r.z0, r.x1 - 3, gy1, r.z0 + 1, MAT_GLASS)
      store.fillBox(r.x0 + 3, gy0, r.z1 - 1, r.x1 - 3, gy1, r.z1, MAT_GLASS)
      store.fillBox(r.x0, gy0, r.z0 + 3, r.x0 + 1, gy1, r.z1 - 3, MAT_GLASS)
      store.fillBox(r.x1 - 1, gy0, r.z0 + 3, r.x1, gy1, r.z1 - 3, MAT_GLASS)
      // metal corner mullions (thin, run the full story) + metal spandrel band
      // capping each floor → horizontal ribbon read
      for (const yy of [gy1 - 1, gy1]) {
        store.fillBox(r.x0, yy, r.z0, r.x1, yy, r.z0 + 1, MAT_METAL)
        store.fillBox(r.x0, yy, r.z1 - 1, r.x1, yy, r.z1, MAT_METAL)
        store.fillBox(r.x0, yy, r.z0, r.x0 + 1, yy, r.z1, MAT_METAL)
        store.fillBox(r.x1 - 1, yy, r.z0, r.x1, yy, r.z1, MAT_METAL)
      }
      for (const cx of [r.x0, r.x1 - 1]) {
        store.fillBox(cx, gy0, r.z0, cx + 1, gy1, r.z0 + 1, MAT_METAL)
        store.fillBox(cx, gy0, r.z1 - 1, cx + 1, gy1, r.z1, MAT_METAL)
      }
    }
    // interior slab (floors above ground). B37 — inset 2 vox BEHIND the facade
    // (was flush at WALL_T): the slab edge reached the 2-deep glass skin at every
    // level, so the concrete poked into the window and the transparent glass
    // sort flickered a black bar. Held clear, the floor sits behind the glass.
    if (f > 0) {
      const si = WALL_T + 2
      store.fillBox(r.x0 + si, yb - 1, r.z0 + si, r.x1 - si, yb, r.z1 - si, MAT_CONCRETE)
    }
  }

  // roof: slab, parapet/crown, hashed HVAC boxes
  store.fillBox(r.x0, roofY, r.z0, r.x1, roofY + 1, r.z1, MAT_CONCRETE)
  if (t.style === 0) {
    stampWalls(store, r, roofY + 2, roofY + 4, MAT_CONCRETE)
  } else {
    // P23 style 1 — taller stepped METAL crown + glass mechanical penthouse:
    // a distinct sleek silhouette (a lit metal cap, not a brick parapet)
    stampWalls(store, r, roofY + 2, roofY + 3, MAT_METAL)
    stampWalls(store, { x0: r.x0 + 2, z0: r.z0 + 2, x1: r.x1 - 2, z1: r.z1 - 2 }, roofY + 4, roofY + 9, MAT_GLASS)
    stampWalls(store, { x0: r.x0 + 2, z0: r.z0 + 2, x1: r.x1 - 2, z1: r.z1 - 2 }, roofY + 10, roofY + 11, MAT_METAL)
  }
  const w = r.x1 - r.x0 + 1
  const d = r.z1 - r.z0 + 1
  for (let k = 0; k < 2; k++) {
    const hx = r.x0 + 10 + (hash3(t.id, k, 0, layout.seed) % Math.max(1, w - 32))
    const hz = r.z0 + 10 + (hash3(t.id, k, 1, layout.seed) % Math.max(1, d - 28))
    store.fillBox(hx, roofY + 2, hz, hx + 11, roofY + 7, hz + 7, MAT_METAL)
  }

  // entrance: double door + metal canopy on the front face
  const doorW = 14
  const frontLen = t.front === 'z-' || t.front === 'z+' ? w : d
  const doorOff = (frontLen - doorW) >> 1
  wallOpening(store, r, t.front, doorOff, doorW, g + 1, g + 24, MAT_AIR)
  const canY = g + 25
  if (t.front === 'z-') store.fillBox(r.x0 + doorOff - 2, canY, r.z0 - 4, r.x0 + doorOff + doorW + 1, canY + 1, r.z0 - 1, MAT_METAL)
  else if (t.front === 'z+') store.fillBox(r.x0 + doorOff - 2, canY, r.z1 + 1, r.x0 + doorOff + doorW + 1, canY + 1, r.z1 + 4, MAT_METAL)
  else if (t.front === 'x-') store.fillBox(r.x0 - 4, canY, r.z0 + doorOff - 2, r.x0 - 1, canY + 1, r.z0 + doorOff + doorW + 1, MAT_METAL)
  else store.fillBox(r.x1 + 1, canY, r.z0 + doorOff - 2, r.x1 + 4, canY + 1, r.z0 + doorOff + doorW + 1, MAT_METAL)

  // --- core: concrete ring + stairs + elevator shaft ------------------------
  stampWalls(store, t.core, g + 1, wallTop, MAT_CONCRETE)
  // elevator shaft: full-height void through every slab
  store.fillBox(t.shaft.x0, g + 1, t.shaft.z0, t.shaft.x1, wallTop, t.shaft.z1, MAT_AIR)
  // metal guard wall between shaft and stair/corridor space, door gap per floor
  const guardX = t.shaft.x0 - 1
  store.fillBox(guardX, g + 1, t.shaft.z0, guardX, wallTop, t.shaft.z1, MAT_METAL)
  const corrZ0 = t.coreDoor === 'z-' ? t.core.z0 + WALL_T : t.stairs.z1 + 1
  const corrZ1 = t.coreDoor === 'z-' ? t.stairs.z0 - 1 : t.core.z1 - WALL_T
  for (let f = 0; f < t.floors; f++) {
    const yb = g + f * t.storyH
    store.fillBox(guardX, yb + 1, corrZ0 + 1, guardX, yb + 21, Math.min(corrZ0 + 8, corrZ1), MAT_AIR)
    // core door into the corridor
    const doorX = ((t.core.x0 + t.core.x1) >> 1) - (DOOR_W >> 1)
    wallOpening(store, t.core, t.coreDoor, doorX - t.core.x0, DOOR_W, yb + 1, yb + DOOR_H, MAT_AIR)
  }
  // switchback stair runs (dir alternates per floor) + slab openings above
  for (let f = 0; f < t.floors - 1; f++) {
    const base = g + f * t.storyH
    const dir: 1 | -1 = f % 2 === 0 ? 1 : -1
    const towardCorr = t.coreDoor === 'z-' ? -1 : 1
    const oz0 = towardCorr === -1 ? t.stairs.z0 - 1 : t.stairs.z0
    const oz1 = towardCorr === -1 ? t.stairs.z1 : t.stairs.z1 + 1
    const ox0 = dir === 1 ? t.stairs.x0 : Math.max(t.core.x0 + WALL_T, t.stairs.x0 - 3)
    const ox1 = dir === 1 ? Math.min(guardX - 1, t.stairs.x1 + 3) : t.stairs.x1
    store.fillBox(ox0, base + t.storyH - 1, oz0, ox1, base + t.storyH, oz1, MAT_AIR)
    stampStairRun(store, t.stairs, 'x', dir, base, TOWER_STAIR_STEPS, MAT_CONCRETE)
  }
}

/** T50 — plaza apron around the towers: concrete with subtle paver accents */
function stampPlaza(store: ChunkStore, r: Rect, g: number): void {
  store.fillBox(r.x0, g - WALK_DEPTH, r.z0, r.x1, g - 1, r.z1, MAT_CONCRETE)
  stampPavers(store, r, g)
}

/** T50 — parking lot: asphalt slab + painted stall lines (asphalt-guarded) */
function stampParkingLot(store: ChunkStore, lot: ParkingLot, g: number): void {
  const r = lot.rect
  store.fillBox(r.x0, g - ROAD_DEPTH, r.z0, r.x1, g - 1, r.z1, MAT_ASPHALT)
  const y = g - 1
  const stalls = ((r.x1 - r.x0 + 1 - 8) / STALL_W) | 0
  for (let row = 0; row < 2; row++) {
    const z0 = row === 0 ? r.z0 : r.z1 - STALL_D + 1
    const z1 = row === 0 ? r.z0 + STALL_D - 1 : r.z1
    for (let i = 0; i <= stalls; i++) {
      const x = r.x0 + 4 + i * STALL_W
      for (let z = z0; z <= z1; z++) paintIfAsphalt(store, x, y, z)
    }
    // stall-row edge line along the aisle
    const edgeZ = row === 0 ? z1 : z0
    for (let x = r.x0 + 4; x <= r.x0 + 4 + stalls * STALL_W; x++) paintIfAsphalt(store, x, y, edgeZ)
  }
}

/** T50 — park path/plaza strip: surface pavers, carved clear of meadow bumps */
function stampParkPath(store: ChunkStore, r: Rect, g: number): void {
  store.fillBox(r.x0, g - WALK_DEPTH, r.z0, r.x1, g - 1, r.z1, MAT_CONCRETE)
  store.fillBox(r.x0, g, r.z0, r.x1, g + 2, r.z1, MAT_AIR)
  stampPavers(store, r, g)
}

/**
 * T50 — pond: union of elliptic lobes dug into the meadow with a smooth
 * depth profile (shores stay grass, deeper cuts expose dirt). Water arrives
 * via the returned waterFills (the CA skips the solid banks inside the box).
 */
function stampPond(store: ChunkStore, pond: Pond, g: number): void {
  const b = pond.box
  for (let z = b.z0; z <= b.z1; z++) {
    for (let x = b.x0; x <= b.x1; x++) {
      let deepest = 0
      for (const l of pond.lobes) {
        const dx = (x - l.x) / l.rx
        const dz = (z - l.z) / l.rz
        const r2 = dx * dx + dz * dz
        if (r2 >= 1) continue
        const dHere = Math.round(pond.depth * (1 - r2))
        if (dHere > deepest) deepest = dHere
      }
      if (deepest <= 0) continue
      // carve the column open (through any meadow bumps above the surface)
      store.fillBox(x, g - deepest, z, x, g + 2, z, MAT_AIR)
    }
  }
}

function stampBeach(store: ChunkStore, beach: Beach, g: number): void {
  const s = beach.sand
  store.fillBox(s.x0, g - WALK_DEPTH, s.z0, s.x1, g - 1, s.z1, BEACH_SAND_MAT)
  store.fillBox(s.x0, g, s.z0, s.x1, g + 34, s.z1, MAT_AIR) // clear tall (for dunes)

  // P7 — natural dune profile: value-noise sand hills that rise INLAND and taper
  // to flat wet sand at the waterline (so the shore reads natural, no flat slab).
  const waterZ0 = beach.ocean.z0
  const RANGE = Math.max(1, waterZ0 - s.z0)
  for (let z = s.z0; z < waterZ0; z += 2) {
    const inland = Math.min(1, (waterZ0 - z) / RANGE) // 1 far inland → 0 at shore
    const amp = inland * inland * 40 // ease-in: flat beach, hills toward the back
    for (let x = s.x0; x <= s.x1; x += 2) {
      const n = valueNoise(x, z, 42, 0x8eac13)
      const hgt = Math.floor(Math.max(0, n - 0.42) * amp)
      if (hgt > 0) store.fillBox(x, g, z, x + 1, g + hgt - 1, z + 1, BEACH_SAND_MAT)
    }
  }

  const w = beach.boardwalk
  store.fillBox(w.x0, g, w.z0, w.x1, g + 34, w.z1, MAT_AIR) // boardwalk cuts flat through dunes
  store.fillBox(w.x0, g - WALK_DEPTH, w.z0, w.x1, g - 1, w.z1, MAT_WOOD)
  for (let x = w.x0; x <= w.x1; x += 6) {
    store.fillBox(x, g - 1, w.z0, x, g - 1, w.z1, MAT_ROOFTILE)
  }

  const o = beach.ocean
  store.fillBox(o.x0, o.y0, o.z0, o.x1, g + 34, o.z1, MAT_AIR)
}

// ---------------------------------------------------------------------------
// B32 — desert trailer park + airport districts
// ---------------------------------------------------------------------------

/** deterministic value noise in [0,1] on a coarse lattice (bilinear), for
 * smooth dune/terrain height. Pure integer hashing — deterministic (V2). */
function valueNoise(x: number, z: number, cell: number, seed: number): number {
  const gx = Math.floor(x / cell)
  const gz = Math.floor(z / cell)
  const fx = x / cell - gx
  const fz = z / cell - gz
  const h = (ix: number, iz: number): number => {
    let n = (Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(seed, 2246822519)) >>> 0
    n = Math.imul(n ^ (n >>> 13), 1274126177) >>> 0
    return ((n ^ (n >>> 16)) >>> 0) / 0xffffffff
  }
  const sx = fx * fx * (3 - 2 * fx)
  const sz = fz * fz * (3 - 2 * fz)
  const a = h(gx, gz) + sx * (h(gx + 1, gz) - h(gx, gz))
  const b = h(gx, gz + 1) + sx * (h(gx + 1, gz + 1) - h(gx, gz + 1))
  return a + sz * (b - a)
}

/** stamp a single trailer: metal/plaster body on a low chassis, window band,
 * a door, a flat roof and two axle wheels. ~5.6 m × 2.8 m footprint. */
function stampTrailer(store: ChunkStore, t: Trailer, g: number): void {
  const bodyMat = [MAT_METAL, MAT_PLASTER, MAT_ROOFTILE][t.tint % 3]
  // footprint 56 (long) × 28 (wide); rot 0/2 → long along z, 1/3 → along x
  const long = 56
  const wide = 28
  const [w, d] = t.rot % 2 === 0 ? [wide, long] : [long, wide]
  const x0 = t.x
  const z0 = t.z
  const x1 = x0 + w - 1
  const z1 = z0 + d - 1
  // chassis skirt + hull (raised 2 vox off the sand on blocks). B37 — taller:
  // body 2→27 (2.5 m walls) so a 1.65 m player clears the door + windows.
  store.fillBox(x0 + 1, g, z0 + 1, x1 - 1, g + 1, z1 - 1, MAT_METAL) // skirt
  store.fillBox(x0, g + 2, z0, x1, g + 27, z1, bodyMat) // hull
  // hollow interior + window band
  store.fillBox(x0 + 1, g + 3, z0 + 1, x1 - 1, g + 26, z1 - 1, MAT_AIR)
  // window band around the sides at eye height
  store.fillBox(x0, g + 12, z0 + 3, x0, g + 17, z1 - 3, MAT_GLASS)
  store.fillBox(x1, g + 12, z0 + 3, x1, g + 17, z1 - 3, MAT_GLASS)
  // flat roof cap
  store.fillBox(x0, g + 27, z0, x1, g + 28, z1, bodyMat)
  // door on the +x long face (short side for rot%2)
  const dcx = ((x0 + x1) >> 1)
  store.fillBox(dcx - 3, g + 2, z1, dcx + 3, g + 22, z1, MAT_AIR)
  // two axle wheels tucked under the long sides
  for (const wz of [z0 + Math.floor(d * 0.25), z0 + Math.floor(d * 0.7)]) {
    store.fillBox(x0 - 1, g, wz, x0, g + 3, wz + 5, MAT_ASPHALT)
    store.fillBox(x1, g, wz, x1 + 1, g + 3, wz + 5, MAT_ASPHALT)
  }
}

/** desert district: swap the surface to sand, roll a few dunes, drop trailers */
function stampDesert(store: ChunkStore, plot: DesertPlot, g: number): void {
  const r = plot.rect
  // sand surface across the block (over the grass the terrain pass laid down)
  store.fillBox(r.x0, g - WALK_DEPTH, r.z0, r.x1, g - 1, r.z1, MAT_SAND)
  store.fillBox(r.x0, g, r.z0, r.x1, g + 40, r.z1, MAT_AIR) // clear any bumps
  // dunes: additive smooth sand height from value noise, up to ~2.4 m, only
  // in the block interior so trailers keep a flat pad-ish base near them
  for (let z = r.z0; z <= r.z1; z += 2) {
    for (let x = r.x0; x <= r.x1; x += 2) {
      const n = valueNoise(x, z, 90, plot.seed)
      const hgt = Math.floor(Math.max(0, (n - 0.45)) * 44) // 0..~24 vox
      if (hgt <= 0) continue
      store.fillBox(x, g, z, x + 1, g + hgt - 1, z + 1, MAT_SAND)
    }
  }
  // B37 — shoddy worn dirt tracks instead of tidy roads: a ragged, noise-
  // jittered cross of packed-dirt paths through the park (wandering centreline,
  // uneven width, bare dirt gouged into the sand) so it reads run-down.
  const cx = (r.x0 + r.x1) >> 1
  const cz = (r.z0 + r.z1) >> 1
  const track = (fixed: number, along: 'x' | 'z'): void => {
    const lo = along === 'x' ? r.x0 : r.z0
    const hi = along === 'x' ? r.x1 : r.z1
    for (let p = lo; p <= hi; p++) {
      const centre = fixed + Math.floor((valueNoise(p, fixed, 34, plot.seed) - 0.5) * 12)
      const halfW = 4 + Math.floor(valueNoise(p, fixed + 613, 17, plot.seed) * 4)
      for (let o = -halfW; o <= halfW; o++) {
        const x = along === 'x' ? p : centre + o
        const z = along === 'x' ? centre + o : p
        if (x < r.x0 || x > r.x1 || z < r.z0 || z > r.z1) continue
        store.fillBox(x, g, z, x, g + 40, z, MAT_AIR) // gouge through any dune
        store.fillBox(x, g - 1, z, x, g - 1, z, MAT_DIRT) // packed-dirt surface
      }
    }
  }
  track(cz, 'x')
  track(cx, 'z')
  // trailers sit on flattened sand pads (clear the dune under each first)
  for (const t of plot.trailers) {
    const [w, d] = t.rot % 2 === 0 ? [28, 56] : [56, 28]
    store.fillBox(t.x - 2, g, t.z - 2, t.x + w + 1, g + 40, t.z + d + 1, MAT_AIR)
    store.fillBox(t.x - 2, g - 1, t.z - 2, t.x + w + 1, g - 1, t.z + d + 1, MAT_SAND)
    stampTrailer(store, t, g)
  }
}

/** a parked airliner: tube fuselage, swept wings, tail fin. ~24 m long. */
/** P20 — small high-wing Cessna-style plane: ~7 m fuselage, ~9 m wingspan, fixed
 * gear. Footprint along its axis: fuselage 70 vox from origin, wings ±45.
 * rot 0/2 → fuselage +z, wings ±x; rot 1/3 → fuselage +x, wings ±z. */
function stampPlane(store: ChunkStore, px: number, pz: number, rot: number, g: number): void {
  const b = g + 3 // fuselage floats on the gear
  const along = (i: number, w: number, y0: number, y1: number, mat: number): void => {
    if (rot % 2 === 0) store.fillBox(px - w, y0, pz + i, px + w, y1, pz + i, mat)
    else store.fillBox(px + i, y0, pz - w, px + i, y1, pz + w, mat)
  }
  // fuselage tube (70 vox = 7 m), tapered nose + tail
  for (let i = 0; i < 70; i++) {
    const taper = i < 8 ? 2 + Math.floor(i / 2) : i > 58 ? 2 + Math.floor((70 - i) / 4) : 5
    along(i, taper, b, b + taper * 2, MAT_PLASTER)
  }
  // high wing across the top of the cabin (single strut-braced plane), ~9 m span
  for (let i = 18; i <= 26; i++) along(i, 45, b + 9, b + 10, MAT_METAL)
  // vertical tail fin + horizontal stabiliser at the back
  for (let i = 61; i <= 68; i++) along(i, 1, b + 5, b + 15, MAT_METAL)
  for (let i = 62; i <= 67; i++) along(i, 15, b + 4, b + 5, MAT_METAL)
  // spinner/prop at the nose + cockpit greenhouse
  along(0, 2, b + 2, b + 6, MAT_METAL)
  along(13, 3, b + 5, b + 8, MAT_GLASS)
}

/** airport: concrete apron, a marked runway, a hangar + terminal, parked planes */
function stampAirport(store: ChunkStore, a: Airport, g: number, aircraftSpawns: AircraftSpawnRequest[]): void {
  const ap = a.apron
  // apron: concrete slab surface across the whole zone (clear grass bumps)
  store.fillBox(ap.x0, g, ap.z0, ap.x1, g + 60, ap.z1, MAT_AIR)
  store.fillBox(ap.x0, g - WALK_DEPTH, ap.z0, ap.x1, g - 1, ap.z1, MAT_CONCRETE)
  // runway: darker asphalt strip with a dashed centre line + threshold bars
  const rw = a.runway
  store.fillBox(rw.x0, g - 1, rw.z0, rw.x1, g - 1, rw.z1, MAT_ASPHALT)
  const cx = (rw.x0 + rw.x1) >> 1
  for (let z = rw.z0 + 8; z < rw.z1 - 8; z += 24) {
    store.fillBox(cx - 1, g - 1, z, cx, g - 1, z + 11, MAT_PAINT) // centre dashes
  }
  for (const tz of [rw.z0 + 4, rw.z1 - 10]) {
    for (let k = -12; k <= 12; k += 4) store.fillBox(cx + k, g - 1, tz, cx + k + 1, g - 1, tz + 6, MAT_PAINT)
  }
  // hangar: tall open metal box with a big door on the runway side (+x)
  const h = a.hangar
  store.fillBox(h.x0, g, h.z0, h.x1, g + 90, h.z1, MAT_METAL)
  store.fillBox(h.x0 + 3, g, h.z0 + 3, h.x1 - 3, g + 84, h.z1 - 3, MAT_AIR) // hollow
  store.fillBox(h.x1 - 2, g, h.z0 + 8, h.x1, g + 70, h.z1 - 8, MAT_AIR) // door opening
  store.fillBox(h.x0, g + 90, h.z0, h.x1, g + 92, h.z1, MAT_METAL) // roof
  // terminal: glass-fronted concrete block
  const tm = a.terminal
  store.fillBox(tm.x0, g, tm.z0, tm.x1, g + 70, tm.z1, MAT_CONCRETE)
  store.fillBox(tm.x0 + 3, g, tm.z0 + 3, tm.x1 - 3, g + 66, tm.z1 - 3, MAT_AIR)
  store.fillBox(tm.x0, g + 8, tm.z0 + 4, tm.x0, g + 40, tm.z1 - 4, MAT_GLASS) // window wall (runway side)
  store.fillBox(tm.x0, g + 70, tm.z0, tm.x1, g + 72, tm.z1, MAT_CONCRETE) // roof
  // P17 — parked planes: the FIRST (on the runway, ready for takeoff) becomes a
  // flyable aircraft entity (returned as data, NOT stamped as voxels — same
  // pattern as parked cars → vehicles). Any others stay static voxel props.
  a.planes.forEach((p, idx) => {
    if (idx === 0) {
      // footprint center in world meters (fuselage 70 voxels long, wings
      // centered on p.x); nose points down the runway (+z) → yaw = π for rot 0.
      aircraftSpawns.push({
        cx: (p.x + 0.5) * VOXEL_SIZE,
        cy: g * VOXEL_SIZE,
        cz: (p.z + 35) * VOXEL_SIZE,
        yaw: Math.PI - p.rot * (Math.PI / 2),
      })
    } else {
      stampPlane(store, p.x, p.z, p.rot, g)
    }
  })
  // apron edge lamps
}

/**
 * P21 — rural compound: a long low farmhouse with a covered porch, a big gable
 * barn (wide door + hayloft), and an optional grain silo (round concrete column
 * with a metal dome). Distinctly bigger + rural vs the suburb houses.
 */
function stampFarmhouse(store: ChunkStore, layout: Layout, f: Farmhouse): void {
  const g = layout.groundY
  const frontZneg = f.front === 'z-'

  // clear meadow bumps across the whole compound (grass surface at g-1 stays)
  const cx0 = Math.min(f.house.x0, f.barn.x0)
  const cx1 = Math.max(f.house.x1, f.barn.x1, f.silo ? f.silo.x + f.silo.r : -Infinity)
  const cz0 = Math.min(f.house.z0, f.barn.z0, f.porch.z0)
  const cz1 = Math.max(f.house.z1, f.barn.z1, f.porch.z1)
  store.fillBox(cx0, g, cz0, cx1, g + 2, cz1, MAT_AIR)

  // --- main house: long low body, shallow gable roof, front porch -----------
  const h = f.house
  const wallTop = g + f.floors * f.storyH - 1
  store.fillBox(h.x0, g, h.z0, h.x1, g, h.z1, MAT_WOOD) // floor slab
  stampWalls(store, h, g + 1, wallTop, f.wallMat)
  for (let fl = 1; fl < f.floors; fl++) {
    store.fillBox(h.x0 + WALL_T, g + fl * f.storyH - 1, h.z0 + WALL_T, h.x1 - WALL_T, g + fl * f.storyH, h.z1 - WALL_T, MAT_WOOD)
  }
  // gable spanning the short (z) axis, stepped 1-up:2-in
  const roofY = wallTop + 1
  for (let lvl = 0; h.z0 + 2 * lvl <= h.z1 - 2 * lvl; lvl++) {
    store.fillBox(h.x0, roofY + lvl, h.z0 + 2 * lvl, h.x1, roofY + lvl, h.z1 - 2 * lvl, f.roofMat)
  }
  // door + flanking windows on the front wall, windows on the back too
  const hw = h.x1 - h.x0 + 1
  const doorOff = (hw - DOOR_W) >> 1
  wallOpening(store, h, f.front, doorOff, DOOR_W, g + 1, g + DOOR_H, MAT_AIR)
  const backSide: Side = frontZneg ? 'z+' : 'z-'
  for (let fl = 0; fl < f.floors; fl++) {
    const yb = g + fl * f.storyH
    for (const off of [12, doorOff - 20, doorOff + DOOR_W + 8, hw - 24]) {
      if (off < 6 || off + 10 > hw - 6) continue
      if (fl === 0 && off + 10 >= doorOff - 3 && off <= doorOff + DOOR_W + 3) continue
      wallOpening(store, h, f.front, off, 10, yb + 10, yb + 21, MAT_GLASS)
      wallOpening(store, h, backSide, off, 10, yb + 10, yb + 21, MAT_GLASS)
    }
  }
  // covered porch: concrete deck, corner + mid posts, wood awning
  const p = f.porch
  store.fillBox(p.x0, g, p.z0, p.x1, g, p.z1, MAT_CONCRETE)
  const awnY = g + f.storyH - 2
  const outerZ = frontZneg ? p.z0 : p.z1
  for (const px of [p.x0, p.x1, (p.x0 + p.x1) >> 1]) {
    store.fillBox(px, g + 1, outerZ, px, awnY - 1, outerZ, MAT_WOOD)
  }
  store.fillBox(p.x0, awnY, p.z0, p.x1, awnY + 1, p.z1, MAT_WOOD)

  // --- barn: tall wood box, big gable roof, wide door + hayloft -------------
  const b = f.barn
  const barnWallTop = g + 44
  store.fillBox(b.x0, g, b.z0, b.x1, g, b.z1, MAT_WOOD)
  stampWalls(store, b, g + 1, barnWallTop, MAT_WOOD)
  const barnRoofY = barnWallTop + 1
  for (let lvl = 0; b.z0 + lvl <= b.z1 - lvl; lvl++) {
    store.fillBox(b.x0, barnRoofY + lvl, b.z0 + lvl, b.x1, barnRoofY + lvl, b.z1 - lvl, f.roofMat)
  }
  const bw = b.x1 - b.x0 + 1
  wallOpening(store, b, f.front, (bw - 24) >> 1, 24, g + 1, g + 32, MAT_AIR) // sliding door
  wallOpening(store, b, 'x-', ((b.z1 - b.z0) >> 1) - 4, 8, barnWallTop - 12, barnWallTop - 4, MAT_AIR) // hayloft

  // --- silo: round concrete column with a metal dome cap --------------------
  if (f.silo) {
    const s = f.silo
    const r2 = s.r * s.r
    const inner = (s.r - 1) * (s.r - 1)
    const siloTop = g + 64
    for (let y = g; y <= siloTop; y++) {
      for (let dz = -s.r; dz <= s.r; dz++) {
        for (let dx = -s.r; dx <= s.r; dx++) {
          const d2 = dx * dx + dz * dz
          if (d2 > r2) continue
          store.setVoxel(s.x + dx, y, s.z + dz, y > g && d2 <= inner ? MAT_AIR : MAT_CONCRETE)
        }
      }
    }
    for (let dz = -s.r; dz <= s.r; dz++) {
      for (let dx = -s.r; dx <= s.r; dx++) {
        if (dx * dx + dz * dz > r2) continue
        store.setVoxel(s.x + dx, siloTop + 1, s.z + dz, MAT_METAL)
      }
    }
  }
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

function stampPool(store: ChunkStore, basin: Box, shallow?: Box): void {
  // concrete shell around and below, then dig the interior to air
  store.fillBox(
    basin.x0 - POOL_SHELL, basin.y0 - POOL_SHELL, basin.z0 - POOL_SHELL,
    basin.x1 + POOL_SHELL, basin.y1, basin.z1 + POOL_SHELL,
    MAT_CONCRETE,
  )
  store.fillBox(basin.x0, basin.y0, basin.z0, basin.x1, basin.y1, basin.z1, MAT_AIR)
  // B19 — raised shallow-end floor (villa pool)
  if (shallow) store.fillBox(shallow.x0, shallow.y0, shallow.z0, shallow.x1, shallow.y1, shallow.z1, MAT_CONCRETE)
}

/**
 * B19 — villa extras: paver pool deck + open-fronted cabana. The pool
 * (stamped after) digs through the deck overlap, leaving the apron ring.
 */
function stampVilla(store: ChunkStore, layout: Layout): void {
  const g = layout.groundY
  const v = layout.villa
  store.fillBox(v.deck.x0, g - WALK_DEPTH, v.deck.z0, v.deck.x1, g - 1, v.deck.z1, MAT_CONCRETE)
  stampPavers(store, v.deck, g)
  const c = v.cabana
  store.fillBox(c.x0, g, c.z0, c.x1, g, c.z1, MAT_CONCRETE)
  stampWalls(store, c, g + 1, g + 21, MAT_PLASTER)
  store.fillBox(c.x0, g + 22, c.z0, c.x1, g + 23, c.z1, MAT_WOOD)
  // wide opening toward the pool + a back window
  const frontLen = c.z1 - c.z0 + 1
  wallOpening(store, c, v.cabanaFront, (frontLen - 16) >> 1, 16, g + 1, g + 20, MAT_AIR)
  const backSide: Side = v.cabanaFront === 'x+' ? 'x-' : 'x+'
  wallOpening(store, c, backSide, (frontLen - 8) >> 1, 8, g + 10, g + 17, MAT_GLASS)
}

/**
 * T43 — picket fence along an axis-aligned line: posts every 16 voxels,
 * 1-wide pickets every other voxel, two rails bridging the picket gaps.
 * All wood — collapses beautifully. ~1 in 4 fences is "worn" (T59): a few
 * pickets missing, position-hashed so it never reshuffles anything.
 */
function stampFence(store: ChunkStore, f: FenceLine, g: number): void {
  const alongX = f.z0 === f.z1
  const len = (alongX ? f.x1 - f.x0 : f.z1 - f.z0) + 1
  if (len < 4) return
  const worn = (hash3(f.x0, 7, f.z0, 0x77aa77) & 3) === 0
  for (let t = 0; t < len; t++) {
    const x = alongX ? f.x0 + t : f.x0
    const z = alongX ? f.z0 : f.z0 + t
    if (t % 16 === 0 || t === len - 1) {
      store.fillBox(x, g, z, x, g + 10, z, MAT_WOOD) // post
    } else if (t % 2 === 0) {
      if (worn && hash3(x, 1, z, 0x77aa77) % 5 === 0) continue // missing picket
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

/** T43/T59 — mailbox: wood post (style 0) or brick pedestal (style 1) + metal box */
function stampMailbox(store: ChunkStore, m: Mailbox, g: number): void {
  if (m.style === 1) {
    store.fillBox(m.x - 1, g, m.z - 1, m.x + 1, g + 9, m.z + 1, MAT_BRICK)
  } else {
    store.fillBox(m.x, g, m.z, m.x, g + 9, m.z, MAT_WOOD)
  }
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
  // B37/P8 — beach/desert/airport stamp AFTER roads so the grid does NOT cut
  // through them: their surface (sand/apron) overwrites the road voxels within
  // their bounds (also kills the coplanar road/apron z-fight). Bordering roads
  // outside the district rects stay, so the districts still connect to the grid.
  for (const beach of layout.beaches) stampBeach(store, beach, layout.groundY)
  for (const d of layout.deserts) stampDesert(store, d, layout.groundY)
  const aircraftSpawns: AircraftSpawnRequest[] = []
  for (const a of layout.airports) stampAirport(store, a, layout.groundY, aircraftSpawns)
  for (const h of layout.houses) stampHouse(store, layout, h)
  stampVilla(store, layout)
  for (const b of layout.rowBlocks) stampRowBlock(store, layout, b)
  for (const p of layout.plazas) stampPlaza(store, p, layout.groundY)
  for (const t of layout.towers) stampTower(store, layout, t)
  for (const p of layout.parking) stampParkingLot(store, p, layout.groundY)
  for (const fh of layout.farmhouses) stampFarmhouse(store, layout, fh)

  const waterFills: WaterFillRequest[] = []
  for (const pool of layout.pools) {
    stampPool(store, pool.basin, pool.shallow)
    waterFills.push({ box: { ...pool.basin } })
  }
  for (const pond of layout.ponds) {
    stampPond(store, pond, layout.groundY)
    waterFills.push({ box: { ...pond.box } })
  }
  for (const beach of layout.beaches) waterFills.push({ box: { ...beach.ocean } })
  for (const p of layout.parkPaths) stampParkPath(store, p, layout.groundY)

  for (const f of layout.fences) stampFence(store, f, layout.groundY)
  for (const l of layout.lamps) stampLampPost(store, l, layout.groundY)
  for (const m of layout.mailboxes) stampMailbox(store, m, layout.groundY)
  for (const b of layout.bins) stampBin(store, b, layout.groundY)

  // car props → real drivable vehicles, but only the nearest MAX_REAL_VEHICLES
  // to the world centre (spawn). B32 — each parked car is a LIVE Jolt vehicle
  // (per-tick wheel raycasts + step listener); at the 4× world there are ~113
  // of them, enough to halve the frame rate. We cap the live set to a perf
  // budget (~the old 2× world's count) and stamp the rest as static voxel cars.
  // Deterministic: cars ranked by squared distance to centre, ties by x then z.
  const MAX_REAL_VEHICLES = 48
  const cx0 = WORLD_VX / 2
  const cz0 = WORLD_VZ / 2
  const cars: { p: (typeof layout.props)[number]; d2: number }[] = []
  for (const p of layout.props) {
    if (isCarKind(p.kind)) {
      const dx = p.x - cx0
      const dz = p.z - cz0
      cars.push({ p, d2: dx * dx + dz * dz })
      continue
    }
    stampGrid(store, propGrids[p.kind], p.x, p.y, p.z, p.rot)
  }
  cars.sort((a, b) => a.d2 - b.d2 || a.p.x - b.p.x || a.p.z - b.p.z)
  const vehicleSpawns: VehicleSpawnRequest[] = []
  for (let i = 0; i < cars.length; i++) {
    const p = cars[i].p
    if (i < MAX_REAL_VEHICLES) {
      const { sx, sz } = propGrids[p.kind]
      const [w, d] = p.rot % 2 === 0 ? [sx, sz] : [sz, sx]
      vehicleSpawns.push({
        archetype: p.kind,
        cx: (p.x + w / 2) * VOXEL_SIZE,
        cy: p.y * VOXEL_SIZE,
        cz: (p.z + d / 2) * VOXEL_SIZE,
        // stampGrid rot 1 turns local -z (grille) toward +x; spawnVehicle's
        // yaw rotation maps forward to (-sin, -cos) — so yaw = -rot·π/2
        yaw: -p.rot * (Math.PI / 2),
      })
    } else {
      stampGrid(store, propGrids[p.kind], p.x, p.y, p.z, p.rot) // static voxel car
    }
  }

  // vegetation last: leaf blobs fill AIR only, so canopies drape around
  // everything already stamped instead of overwriting it
  for (const t of layout.trees) stampTree(store, t, layout.groundY)
  for (const s of layout.shrubs) stampShrub(store, s, layout.groundY)

  return { waterFills, vehicleSpawns, aircraftSpawns }
}
