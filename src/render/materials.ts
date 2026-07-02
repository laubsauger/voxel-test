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
}

/** render params by sim material id — keep in sync with sim table names */
const RENDER_PARAMS: Record<number, { roughness: number; metalness?: number; emissive?: number }> = {
  0: { roughness: 1 }, // air
  1: { roughness: 0.95 }, // dirt
  2: { roughness: 0.9 }, // grass
  3: { roughness: 0.9 }, // asphalt
  4: { roughness: 0.85 }, // concrete
  5: { roughness: 0.8 }, // brick
  6: { roughness: 0.7 }, // wood
  7: { roughness: 0.75 }, // plaster
  8: { roughness: 0.1 }, // glass
  9: { roughness: 0.35, metalness: 0.9 }, // metal
  10: { roughness: 0.15 }, // water-solid
  11: { roughness: 0.8 }, // leaves
  12: { roughness: 0.6 }, // rooftile
  13: { roughness: 0.5, emissive: 4 }, // lamp
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
  }
})

export const MAT_AIR = 0

/** lookup with loud failure on ids outside the table (corrupt voxel data) */
export function getMaterial(id: number): MaterialDef {
  const m = MATERIALS[id]
  if (m === undefined) throw new Error(`unknown material id ${id} (table has ${MATERIALS.length})`)
  return m
}
