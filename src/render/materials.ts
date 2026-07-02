/**
 * Render-side I.mat view (T8). Id assignments + shared params (colorRamp,
 * strength, density, flags) come from the single authority table in
 * src/sim/materials.ts (V13) — this module only ADDS render params
 * (roughness/metalness/emissive) per id and flattens flags for shader use.
 * Pure data module: no three.js, no DOM.
 */
import {
  MATERIALS as SIM_MATERIALS,
  MatFlags,
} from '../sim/materials'

export interface MaterialDef {
  /** table index == voxel byte value */
  id: number
  name: string
  /** color ramp [dark, light] hex sRGB — shader mixes per-voxel */
  colorRamp: [number, number]
  strength: number
  density: number
  flammable: boolean
  floats: boolean
  transparent: boolean
  /** PBR params for the chunk material */
  roughness: number
  metalness: number
  /** emissive intensity multiplier (bloom feed), 0 = none */
  emissive: number
  /**
   * per-voxel color-ramp variation strength 0..1 (B8): organic materials get
   * visible per-voxel tint charm, smooth manufactured surfaces stay near-flat
   * so a plaster wall never reads as noisy fake-AO patchwork
   */
  variation: number
}

/** render params by sim material id — keep in sync with sim table names */
const RENDER_PARAMS: Record<
  number,
  { roughness: number; metalness?: number; emissive?: number; variation?: number }
> = {
  0: { roughness: 1 }, // air
  1: { roughness: 0.95, variation: 1 }, // dirt
  2: { roughness: 0.9, variation: 1 }, // grass
  3: { roughness: 0.9, variation: 0.4 }, // asphalt
  4: { roughness: 0.85, variation: 0.3 }, // concrete
  5: { roughness: 0.8, variation: 0.7 }, // brick
  6: { roughness: 0.7, variation: 0.75 }, // wood
  7: { roughness: 0.75, variation: 0.2 }, // plaster
  8: { roughness: 0.1, variation: 0.25 }, // glass
  9: { roughness: 0.35, metalness: 0.9, variation: 0.2 }, // metal
  10: { roughness: 0.15, variation: 0.4 }, // water-solid
  11: { roughness: 0.8, variation: 1 }, // leaves
  12: { roughness: 0.6, variation: 0.7 }, // rooftile
  13: { roughness: 0.5, emissive: 4, variation: 0.25 }, // lamp
  14: { roughness: 0.8, variation: 0.5 }, // flesh
}

export const MATERIALS: readonly MaterialDef[] = SIM_MATERIALS.map((m, i) => {
  if (!m) {
    // reserved slot: dense entry keeps shader uniform arrays index-aligned;
    // magenta ramp makes accidental use visible, not silent
    return {
      id: i,
      name: `reserved-${i}`,
      colorRamp: [0xff00ff, 0xff00ff] as [number, number],
      strength: 0,
      density: 0,
      flammable: false,
      floats: false,
      transparent: false,
      roughness: 1,
      metalness: 0,
      emissive: 0,
      variation: 0,
    }
  }
  const rp = RENDER_PARAMS[i] ?? { roughness: 1 }
  return {
    id: m.id,
    name: m.name,
    colorRamp: m.colorRamp,
    strength: m.strength,
    density: m.density,
    flammable: (m.flags & MatFlags.Flammable) !== 0,
    floats: (m.flags & MatFlags.Floats) !== 0,
    transparent: (m.flags & MatFlags.Transparent) !== 0,
    roughness: rp.roughness,
    metalness: rp.metalness ?? 0,
    emissive: rp.emissive ?? 0,
    variation: rp.variation ?? 0.5,
  }
})

export const MAT_AIR = 0

/** lookup with loud failure on ids outside the table (corrupt voxel data) */
export function getMaterial(id: number): MaterialDef {
  const m = MATERIALS[id]
  if (m === undefined) throw new Error(`unknown material id ${id} (table has ${MATERIALS.length})`)
  return m
}
