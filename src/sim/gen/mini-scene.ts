/**
 * T98 — MINI test arena: a small hand-authored scene stamped around the spawn
 * column instead of the full procedural city. Dev iteration boots in seconds
 * (the full stamp + mesh + compact cycle is ~10s+ and climbing with content).
 * Selected by ?world=mini; the dev server defaults to it (main.ts), production
 * builds default to the full world — publishing mode is unchanged.
 *
 * Deterministic (V2): pure fillBox recipes, no PRNG — bit-identical on every
 * peer, so MP lockstep sessions (and the mp-e2e harness, which boots it for
 * speed) work on it exactly like the full world.
 *
 * Contents exercise every system the sandbox needs at dev time: houses with
 * interior floors (destruction/collapse), a slim and a fat tower (zero-support
 * + weak-neck stress), a gate and a pillar row (test shapes), pool + pond
 * (water heightfield: fill, breach-drain, buoyancy), a road cross (vehicles),
 * trees (welded canopies), and a perimeter wall that keeps debris in view.
 */
import { VOXEL_SIZE, WORLD_VX, WORLD_VZ, type ChunkStore } from '../../world/chunks'
import {
  MAT_ASPHALT,
  MAT_BRICK,
  MAT_CONCRETE,
  MAT_DIRT,
  MAT_GLASS,
  MAT_GRASS,
  MAT_LEAVES,
  MAT_PLASTER,
  MAT_ROOFTILE,
  MAT_WOOD,
} from '../materials'
import type { StampResult } from './stamper'

/** ground surface height (voxels) — slab top; spawn lands on it. 32 =
 *  chunk-aligned (whole bottom chunk row flips Uniform — free) and thick
 *  enough for swim-depth basins (lake 2.4m, pool 1.5m) */
const GY = 32
/** arena half-extent (voxels) — 512 ⇒ 1024×1024 voxels ≈ 102×102 m:
 *  enough for a plane takeoff run down the runway strip */
const HALF = 512

export function stampMiniScene(world: ChunkStore): StampResult {
  const cx = WORLD_VX >> 1
  const cz = WORLD_VZ >> 1
  const x0 = cx - HALF
  const z0 = cz - HALF
  const x1 = cx + HALF - 1
  const z1 = cz + HALF - 1

  // ground: dirt slab with a grass skin
  world.fillBox(x0, 0, z0, x1, GY - 1, z1, MAT_DIRT)
  world.fillBox(x0, GY, z0, x1, GY, z1, MAT_GRASS)

  const g = GY + 1 // first free voxel above ground

  // perimeter wall (debris containment, like the spike arena): brick, 3 thick
  world.fillBox(x0, g, z0, x1, g + 11, z0 + 2, MAT_BRICK)
  world.fillBox(x0, g, z1 - 2, x1, g + 11, z1, MAT_BRICK)
  world.fillBox(x0, g, z0, x0 + 2, g + 11, z1, MAT_BRICK)
  world.fillBox(x1 - 2, g, z0, x1, g + 11, z1, MAT_BRICK)

  // road cross: east-west + north-south asphalt strips through the middle
  world.fillBox(x0 + 3, GY, cz + 30, x1 - 3, GY, cz + 49, MAT_ASPHALT)
  world.fillBox(cx - 40, GY, z0 + 3, cx - 21, GY, z1 - 3, MAT_ASPHALT)
  // RUNWAY: full-width strip along the south edge (~100m takeoff run, concrete
  // center-line dashes), clear of every structure
  world.fillBox(x0 + 6, GY, cz + 150, x1 - 6, GY, cz + 189, MAT_ASPHALT)
  for (let dx = x0 + 20; dx < x1 - 20; dx += 24) world.fillBox(dx, GY, cz + 168, dx + 11, GY, cz + 171, MAT_CONCRETE)

  // --- houses (brick/plaster shells, windows, doors, interior floors, roofs)
  const house = (hx: number, hz: number, w: number, d: number, h: number, wall: number, stories: number): void => {
    world.fillBox(hx, g, hz, hx + w - 1, g + h - 1, hz + d - 1, wall)
    world.fillBox(hx + 1, g, hz + 1, hx + w - 2, g + h - 1, hz + d - 2, 0) // hollow
    world.fillBox(hx + (w >> 1) - 2, g, hz, hx + (w >> 1) + 1, g + 7, hz, 0) // door (south)
    for (let s = 0; s < stories; s++) {
      const wy = g + 4 + s * 10
      // window bands on all four sides
      world.fillBox(hx + 4, wy, hz, hx + w - 5, wy + 3, hz, MAT_GLASS)
      world.fillBox(hx + 4, wy, hz + d - 1, hx + w - 5, wy + 3, hz + d - 1, MAT_GLASS)
      world.fillBox(hx, wy, hz + 4, hx, wy + 3, hz + d - 5, MAT_GLASS)
      world.fillBox(hx + w - 1, wy, hz + 4, hx + w - 1, wy + 3, hz + d - 5, MAT_GLASS)
      // interior floor above each storey (collapse interest)
      if (s + 1 < stories) world.fillBox(hx + 1, g + (s + 1) * 10 - 1, hz + 1, hx + w - 2, g + (s + 1) * 10 - 1, hz + d - 2, MAT_WOOD)
    }
    world.fillBox(hx, g + h, hz, hx + w - 1, g + h + 1, hz + d - 1, MAT_ROOFTILE)
  }
  house(cx - 180, cz - 120, 50, 40, 20, MAT_BRICK, 2) // two-storey brick, NW
  house(cx - 100, cz - 140, 40, 36, 10, MAT_PLASTER, 1) // bungalow
  house(cx + 40, cz - 130, 56, 44, 30, MAT_PLASTER, 3) // three-storey block, NE
  house(cx + 130, cz - 100, 40, 36, 10, MAT_BRICK, 1) // bungalow, E
  house(cx - 190, cz + 80, 44, 40, 20, MAT_PLASTER, 2) // two-storey, SW

  // --- towers (collapse showpieces), east side
  world.fillBox(cx + 150, g, cz - 20, cx + 157, g + 99, cz - 13, MAT_CONCRETE) // fat 10m tower
  world.fillBox(cx + 152, g, cz - 18, cx + 155, g + 99, cz - 15, 0) // hollow core
  world.fillBox(cx + 120, g, cz + 6, cx + 123, g + 59, cz + 9, MAT_CONCRETE) // slim tower

  // --- gate + pillar row (test shapes), west side
  world.fillBox(cx - 220, g, cz - 10, cx - 216, g + 13, cz - 6, MAT_BRICK)
  world.fillBox(cx - 196, g, cz - 10, cx - 192, g + 13, cz - 6, MAT_BRICK)
  world.fillBox(cx - 220, g + 14, cz - 10, cx - 192, g + 17, cz - 6, MAT_CONCRETE) // lintel
  for (let i = 0; i < 5; i++) {
    const px = cx - 220 + i * 12
    world.fillBox(px, g, cz + 60, px + 2 + i, g + 9 + i * 6, cz + 62 + i, MAT_CONCRETE) // growing pillars
  }

  // --- trees (trunk + welded canopy) on the green quads
  const tree = (tx: number, tz: number, h: number): void => {
    world.fillBox(tx, g, tz, tx + 1, g + h - 1, tz + 1, MAT_WOOD)
    world.fillBox(tx - 4, g + h - 4, tz - 4, tx + 5, g + h + 4, tz + 5, MAT_LEAVES)
    world.fillBox(tx - 2, g + h + 5, tz - 2, tx + 3, g + h + 7, tz + 3, MAT_LEAVES)
  }
  tree(cx - 140, cz + 120, 16)
  tree(cx + 80, cz + 120, 20)
  tree(cx - 300, cz - 200, 14)
  tree(cx - 60, cz - 40, 18)

  // --- pool (breach-drain testing) SE of spawn
  const px = cx + 30
  const pz = cz + 90
  world.fillBox(px - 2, GY - 16, pz - 2, px + 33, GY, pz + 21, MAT_CONCRETE) // basin shell
  world.fillBox(px, GY - 15, pz, px + 31, GY, pz + 19, 0) // interior (1.5m deep)

  // --- LAKE (the "reasonably sized" fluid test body): 20×14 m, 2.4 m deep,
  // dirt banks, NE quadrant — big enough for waves of debris, swimming,
  // buoyancy rafts, and multi-column drain behaviour
  const lx = cx + 180
  const lz = cz - 60
  world.fillBox(lx - 3, GY - 25, lz - 3, lx + 202, GY, lz + 142, MAT_DIRT) // basin
  world.fillBox(lx, GY - 24, lz, lx + 199, GY, lz + 139, 0) // interior (2.4m deep)
  const waterFills = [
    { box: { x0: px, y0: GY - 15, z0: pz, x1: px + 31, y1: GY - 1, z1: pz + 19 } },
    { box: { x0: lx, y0: GY - 24, z0: lz, x1: lx + 199, y1: GY - 1, z1: lz + 139 } },
  ]

  // --- vehicles: spaced >60 voxels apart along the roads (a sedan is ~40 long)
  const m = (v: number): number => v * VOXEL_SIZE
  return {
    waterFills,
    vehicleSpawns: [
      { archetype: 'sedan0', cx: m(cx - 160), cy: m(g), cz: m(cz + 40), yaw: Math.PI / 2 },
      { archetype: 'pickup0', cx: m(cx - 60), cy: m(g), cz: m(cz + 38), yaw: Math.PI / 2 },
      { archetype: 'sedan1', cx: m(cx + 60), cy: m(g), cz: m(cz + 42), yaw: -Math.PI / 2 },
      { archetype: 'van0', cx: m(cx - 30), cy: m(g), cz: m(cz - 120), yaw: 0 },
    ],
    // west end of the runway, nose pointing east down the full ~100m strip
    aircraftSpawns: [{ cx: m(cx - 440), cy: m(g), cz: m(cz + 169), yaw: -Math.PI / 2 }],
  }
}
