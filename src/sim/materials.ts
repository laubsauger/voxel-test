/**
 * I.mat — minimal material table needed by the physics track (T12/T13).
 *
 * The render track owns colors/ramps (SPEC I.mat lists colorRamp); this file
 * defines only what the sim needs: density (mass), strength (blast
 * resistance), flags. If/when a render-side material module lands, it should
 * import THIS table for the shared fields — see INTEGRATION-physics.md.
 *
 * id 0 = air. 16 entries (V5: voxel = 1 byte material id).
 */

export const MAT_FLAG_FLAMMABLE = 1
export const MAT_FLAG_FLOATS = 2
export const MAT_FLAG_TRANSPARENT = 4

export interface Material {
  name: string
  /** kg/m³ — dynamic body mass = voxel count × density × VOXEL_VOLUME */
  density: number
  /** blast resistance ≥ 1 (0 for air). Explode destroys where falloff·power ≥ strength. */
  strength: number
  flags: number
}

/** 10cm voxel → 0.001 m³ */
export const VOXEL_VOLUME = 0.001

export const MATERIALS: readonly Material[] = [
  { name: 'air', density: 0, strength: 0, flags: 0 }, // 0
  { name: 'dirt', density: 1600, strength: 1, flags: 0 }, // 1
  { name: 'grass', density: 1500, strength: 1, flags: 0 }, // 2
  { name: 'stone', density: 2600, strength: 4, flags: 0 }, // 3
  { name: 'wood', density: 600, strength: 2, flags: MAT_FLAG_FLAMMABLE | MAT_FLAG_FLOATS }, // 4
  { name: 'brick', density: 1900, strength: 3, flags: 0 }, // 5
  { name: 'concrete', density: 2400, strength: 5, flags: 0 }, // 6
  { name: 'metal', density: 7800, strength: 8, flags: 0 }, // 7
  { name: 'glass', density: 2500, strength: 1, flags: MAT_FLAG_TRANSPARENT }, // 8
  { name: 'flesh', density: 1000, strength: 1, flags: 0 }, // 9 — player body segments (T22)
  { name: 'plastic', density: 950, strength: 1, flags: MAT_FLAG_FLOATS }, // 10
  { name: 'asphalt', density: 2300, strength: 4, flags: 0 }, // 11
  { name: 'plaster', density: 850, strength: 1, flags: 0 }, // 12
  { name: 'tile', density: 2000, strength: 2, flags: 0 }, // 13
  { name: 'leaves', density: 300, strength: 1, flags: MAT_FLAG_FLAMMABLE }, // 14
  { name: 'reserved', density: 1000, strength: 2, flags: 0 }, // 15
]

export const MAT_FLESH = 9

/** material for a voxel id — fails loud on ids outside the table (V10) */
export function material(id: number): Material {
  const m = MATERIALS[id]
  if (!m) throw new Error(`unknown material id ${id}`)
  return m
}
