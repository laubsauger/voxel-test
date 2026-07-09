/**
 * T98 — MINI test scene: a small hand-authored arena stamped around the spawn
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
 * interiors (destruction/collapse), a slim tower (zero-support + stress), a
 * gate (weak-neck), a pool (water heightfield: fill, breach-drain, buoyancy),
 * a road (vehicles), two cars and a plane.
 */
import { VOXEL_SIZE, WORLD_VX, WORLD_VZ, type ChunkStore } from '../../world/chunks'
import {
  MAT_ASPHALT,
  MAT_BRICK,
  MAT_CONCRETE,
  MAT_DIRT,
  MAT_GLASS,
  MAT_GRASS,
  MAT_PLASTER,
  MAT_ROOFTILE,
  MAT_WOOD,
} from '../materials'
import type { StampResult } from './stamper'

/** ground surface height (voxels) — slab top; spawn lands on it */
const GY = 8

export function stampMiniScene(world: ChunkStore): StampResult {
  const cx = WORLD_VX >> 1
  const cz = WORLD_VZ >> 1
  const x0 = cx - 80
  const z0 = cz - 80

  // ground: dirt slab with a grass skin, 160×160 voxels (~51 m square)
  world.fillBox(x0, 0, z0, x0 + 159, GY - 1, z0 + 159, MAT_DIRT)
  world.fillBox(x0, GY, z0, x0 + 159, GY, z0 + 159, MAT_GRASS)

  // road strip through the middle (east-west, south of spawn)
  world.fillBox(x0, GY, cz + 12, x0 + 159, GY, cz + 19, MAT_ASPHALT)

  const g = GY + 1 // first free voxel above ground

  // --- three simple houses (brick shell, plaster interior line, windows, roof)
  const house = (hx: number, hz: number, w: number, d: number, h: number, wall: number): void => {
    world.fillBox(hx, g, hz, hx + w - 1, g + h - 1, hz + d - 1, wall)
    world.fillBox(hx + 1, g, hz + 1, hx + w - 2, g + h - 1, hz + d - 2, 0) // hollow
    // door (south) + windows
    world.fillBox(hx + (w >> 1) - 1, g, hz, hx + (w >> 1), g + 3, hz, 0)
    world.fillBox(hx + 2, g + 2, hz, hx + 4, g + 3, hz, MAT_GLASS)
    world.fillBox(hx + w - 5, g + 2, hz, hx + w - 3, g + 3, hz, MAT_GLASS)
    world.fillBox(hx + 2, g + 2, hz + d - 1, hx + 4, g + 3, hz + d - 1, MAT_GLASS)
    // flat roof slab
    world.fillBox(hx, g + h, hz, hx + w - 1, g + h, hz + d - 1, MAT_ROOFTILE)
    // interior floor line (second storey) for collapse interest
    if (h > 8) world.fillBox(hx + 1, g + 5, hz + 1, hx + w - 2, g + 5, hz + d - 2, MAT_WOOD)
  }
  house(cx - 60, cz - 40, 14, 12, 10, MAT_BRICK)
  house(cx - 30, cz - 44, 16, 14, 12, MAT_PLASTER)
  house(cx + 24, cz - 40, 14, 12, 10, MAT_BRICK)

  // --- slim tower (zero-support / stress testing), NE of spawn
  world.fillBox(cx + 44, g, cz - 10, cx + 47, g + 44, cz - 7, MAT_CONCRETE)

  // --- gate (weak-neck): two pillars + lintel, west of spawn
  world.fillBox(cx - 52, g, cz + 2, cx - 50, g + 7, cz + 4, MAT_BRICK)
  world.fillBox(cx - 40, g, cz + 2, cx - 38, g + 7, cz + 4, MAT_BRICK)
  world.fillBox(cx - 52, g + 8, cz + 2, cx - 38, g + 9, cz + 4, MAT_CONCRETE)

  // --- pool (water: fill, breach-drain, buoyancy), east of spawn
  const px = cx + 20
  const pz = cz + 28
  world.fillBox(px - 1, GY - 4, pz - 1, px + 12, GY, pz + 8, MAT_CONCRETE) // basin shell
  world.fillBox(px, GY - 3, pz, px + 11, GY, pz + 7, 0) // interior
  const waterFills = [{ box: { x0: px, y0: GY - 3, z0: pz, x1: px + 11, y1: GY - 1, z1: pz + 7 } }]

  // --- vehicles on the road + a plane on the grass (P17/T64 test rigs)
  const m = (v: number): number => v * VOXEL_SIZE
  return {
    waterFills,
    vehicleSpawns: [
      { archetype: 'sedan0', cx: m(cx - 10), cy: m(GY + 1), cz: m(cz + 15), yaw: Math.PI / 2 },
      { archetype: 'sedan1', cx: m(cx + 6), cy: m(GY + 1), cz: m(cz + 16), yaw: -Math.PI / 2 },
    ],
    aircraftSpawns: [{ cx: m(cx - 20), cy: m(GY + 1), cz: m(cz + 40), yaw: 0 }],
  }
}
