/**
 * T20 — placeholder prop voxel models, built in code so the suburb works
 * before real MagicaVoxel art lands. Same VoxelGrid shape the .vox pipeline
 * (src/sim/vox/remap.ts toGrid) produces, so swapping in real .vox assets
 * is a data change only. Pure constants (V2).
 */

import type { VoxelGrid } from '../vox/remap'
import { MAT_GLASS, MAT_METAL } from '../materials'

function makeGrid(sx: number, sy: number, sz: number): VoxelGrid {
  return { sx, sy, sz, mats: new Uint8Array(sx * sy * sz) }
}

function fill(g: VoxelGrid, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, mat: number): void {
  for (let y = y0; y <= y1; y++)
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) g.mats[x + z * g.sx + y * g.sx * g.sz] = mat
}

/** sedan: 1.8 m wide × 1.5 m tall × 4.0 m long (length along +z) */
function buildCar0(): VoxelGrid {
  const g = makeGrid(18, 15, 40)
  // wheels (4 boxes)
  for (const zw of [5, 29]) {
    fill(g, 0, 0, zw, 3, 3, zw + 5, MAT_METAL)
    fill(g, 14, 0, zw, 17, 3, zw + 5, MAT_METAL)
  }
  // body
  fill(g, 1, 4, 0, 16, 8, 39, MAT_METAL)
  // cabin: glass band with metal roof and pillars
  fill(g, 3, 9, 12, 14, 12, 30, MAT_GLASS)
  fill(g, 3, 9, 12, 14, 12, 13, MAT_METAL) // front pillar row
  fill(g, 3, 9, 29, 14, 12, 30, MAT_METAL) // rear pillar row
  fill(g, 3, 13, 12, 14, 14, 30, MAT_METAL) // roof
  return g
}

/** wagon: boxier, longer cabin */
function buildCar1(): VoxelGrid {
  const g = makeGrid(18, 16, 42)
  for (const zw of [6, 30]) {
    fill(g, 0, 0, zw, 3, 3, zw + 5, MAT_METAL)
    fill(g, 14, 0, zw, 17, 3, zw + 5, MAT_METAL)
  }
  fill(g, 1, 4, 0, 16, 9, 41, MAT_METAL)
  fill(g, 3, 10, 10, 14, 13, 38, MAT_GLASS)
  fill(g, 3, 10, 10, 14, 13, 11, MAT_METAL)
  fill(g, 3, 10, 37, 14, 13, 38, MAT_METAL)
  fill(g, 3, 14, 10, 14, 15, 38, MAT_METAL)
  return g
}

/** kind → grid; keys match Prop.kind emitted by the layout generator */
export function placeholderProps(): Record<string, VoxelGrid> {
  return { car0: buildCar0(), car1: buildCar1() }
}
