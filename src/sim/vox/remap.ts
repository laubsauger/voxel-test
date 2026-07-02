/**
 * .vox palette → I.mat material-id remap (second half of I.vox).
 *
 * A remap table maps .vox palette indices (1..255) to our material ids.
 * Explicit entries win; everything else falls back to nearest-color match
 * against the material table's colorRamp midpoints. Pure functions (V2).
 */

import { MATERIALS, MAT_AIR } from '../materials'
import { paletteRgb, type VoxModel } from './vox'

/** explicit palette-index → material-id overrides (partial) */
export type RemapOverrides = Readonly<Record<number, number>>

/** material-id voxel grid in OUR axes: y up, index = x + z*sx + y*sx*sz */
export interface VoxelGrid {
  sx: number
  sy: number
  sz: number
  mats: Uint8Array
}

function rampMidRgb(ramp: [number, number]): [number, number, number] {
  const a = ramp[0], b = ramp[1]
  return [
    (((a >>> 16) & 0xff) + ((b >>> 16) & 0xff)) >> 1,
    (((a >>> 8) & 0xff) + ((b >>> 8) & 0xff)) >> 1,
    ((a & 0xff) + (b & 0xff)) >> 1,
  ]
}

/** nearest material id (excluding air) by squared RGB distance; ties → lower id */
export function nearestMaterial(r: number, g: number, b: number): number {
  let best = MAT_AIR
  let bestD = Infinity
  for (const m of MATERIALS) {
    if (!m || m.id === MAT_AIR) continue
    const [mr, mg, mb] = rampMidRgb(m.colorRamp)
    const d = (r - mr) ** 2 + (g - mg) ** 2 + (b - mb) ** 2
    if (d < bestD) {
      bestD = d
      best = m.id
    }
  }
  return best
}

/**
 * Build a full 256-entry remap table: table[paletteIndex] = material id.
 * Index 0 (empty voxel) always maps to air. V5: outputs are valid ids 0..255.
 */
export function buildRemap(palette: Uint32Array, overrides: RemapOverrides = {}): Uint8Array {
  const table = new Uint8Array(256)
  for (let i = 1; i < 256; i++) {
    const explicit = overrides[i]
    if (explicit !== undefined) {
      if (explicit < 0 || explicit > 255) throw new Error(`remap override for palette ${i} out of byte range: ${explicit}`)
      table[i] = explicit
    } else {
      const [r, g, b] = paletteRgb(palette[i])
      table[i] = nearestMaterial(r, g, b)
    }
  }
  return table
}

/**
 * VoxModel (.vox z-up, palette indices) → VoxelGrid (y-up, material ids).
 * Axis map: world x = vox x, world y = vox z (up), world z = vox y.
 */
export function toGrid(model: VoxModel, remap: Uint8Array): VoxelGrid {
  const sx = model.sx, sy = model.sz, sz = model.sy
  const mats = new Uint8Array(sx * sy * sz)
  for (let vz = 0; vz < model.sz; vz++) {
    for (let vy = 0; vy < model.sy; vy++) {
      for (let vx = 0; vx < model.sx; vx++) {
        const ci = model.voxels[vx + vy * model.sx + vz * model.sx * model.sy]
        if (ci === 0) continue
        mats[vx + vy * sx + vz * sx * sz] = remap[ci]
      }
    }
  }
  return { sx, sy, sz, mats }
}
