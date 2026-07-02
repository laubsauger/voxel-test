/**
 * I.mat — material table. Voxel byte id → material params (V5: ids 0..255,
 * table holds 16 slots). Shared by render (colorRamp + PBR derive), physics
 * (strength, density), content (stamping, .vox remap) and water (floats).
 *
 * V13: THIS is the only I.mat id authority. Render/physics derive params
 * from these ids — never redefine id assignments elsewhere.
 *
 * Id assignments (coordinate via src/sim/gen/INTEGRATION-content.md):
 *   0 air, 1 dirt, 2 grass, 3 asphalt, 4 concrete, 5 brick, 6 wood,
 *   7 plaster, 8 glass, 9 metal, 10 water-solid marker (water track: solid
 *   cells the CA treats as source volume), 11 leaves, 12 rooftile, 13 lamp,
 *   14 flesh (player body segments), 15 reserved (null).
 *
 * Strength scale: blast resistance ~0..10. Explode destroys where
 * falloff · power ≥ strength (src/sim/destruction.ts). Air/water 0.
 */

export const enum MatFlags {
  None = 0,
  Flammable = 1,
  Floats = 2,
  Transparent = 4,
}

// physics-track aliases (same bit values)
export const MAT_FLAG_FLAMMABLE = 1
export const MAT_FLAG_FLOATS = 2
export const MAT_FLAG_TRANSPARENT = 4

export interface Material {
  id: number
  name: string
  /** two RGB endpoints (0xRRGGBB) for per-voxel color variation */
  colorRamp: [number, number]
  /** blast resistance ~0..10; explode destroys where falloff·power ≥ strength */
  strength: number
  /** kg/m³ — dynamic body mass = voxel count × density × VOXEL_VOLUME */
  density: number
  flags: number
}

/** 10cm voxel → 0.001 m³ */
export const VOXEL_VOLUME = 0.001

export const MAT_AIR = 0
export const MAT_DIRT = 1
export const MAT_GRASS = 2
export const MAT_ASPHALT = 3
export const MAT_CONCRETE = 4
export const MAT_BRICK = 5
export const MAT_WOOD = 6
export const MAT_PLASTER = 7
export const MAT_GLASS = 8
export const MAT_METAL = 9
export const MAT_WATER_SOLID = 10
export const MAT_LEAVES = 11
export const MAT_ROOFTILE = 12
export const MAT_LAMP = 13
export const MAT_FLESH = 14

/** table indexed by material id; null = reserved slot */
export const MATERIALS: (Material | null)[] = [
  { id: 0, name: 'air', colorRamp: [0x000000, 0x000000], strength: 0, density: 0, flags: MatFlags.None },
  { id: 1, name: 'dirt', colorRamp: [0x6b4a2e, 0x7d5a3a], strength: 1, density: 1600, flags: MatFlags.None },
  { id: 2, name: 'grass', colorRamp: [0x4f7d3a, 0x639448], strength: 1, density: 1400, flags: MatFlags.None },
  { id: 3, name: 'asphalt', colorRamp: [0x2e2e32, 0x3a3a40], strength: 4, density: 2400, flags: MatFlags.None },
  { id: 4, name: 'concrete', colorRamp: [0x9a9a94, 0xb0b0a8], strength: 5, density: 2400, flags: MatFlags.None },
  { id: 5, name: 'brick', colorRamp: [0x9c4a32, 0xb05a3c], strength: 3, density: 1900, flags: MatFlags.None },
  { id: 6, name: 'wood', colorRamp: [0x8a6a42, 0xa07c50], strength: 2, density: 600, flags: MatFlags.Flammable | MatFlags.Floats },
  { id: 7, name: 'plaster', colorRamp: [0xd8d2c4, 0xe8e2d4], strength: 1, density: 1000, flags: MatFlags.None },
  { id: 8, name: 'glass', colorRamp: [0xa8cce0, 0xc0e0f0], strength: 1, density: 2500, flags: MatFlags.Transparent },
  { id: 9, name: 'metal', colorRamp: [0x707880, 0x8a929a], strength: 8, density: 7800, flags: MatFlags.None },
  { id: 10, name: 'water-solid', colorRamp: [0x2a5a8a, 0x3a6a9a], strength: 0, density: 1000, flags: MatFlags.Transparent },
  { id: 11, name: 'leaves', colorRamp: [0x2f4a25, 0x557d3a], strength: 1, density: 300, flags: MatFlags.Flammable | MatFlags.Floats },
  { id: 12, name: 'rooftile', colorRamp: [0x5f342c, 0x8f4f42], strength: 2, density: 1800, flags: MatFlags.None },
  { id: 13, name: 'lamp', colorRamp: [0xffedb8, 0xfff9e0], strength: 1, density: 400, flags: MatFlags.None },
  { id: 14, name: 'flesh', colorRamp: [0xc08a7a, 0xd8a090], strength: 1, density: 1000, flags: MatFlags.None },
  null,
]

export function getMaterial(id: number): Material | null {
  return id >= 0 && id < MATERIALS.length ? MATERIALS[id] : null
}

/** material for a voxel id — fails loud on ids outside the table (V10) */
export function material(id: number): Material {
  const m = MATERIALS[id]
  if (!m) throw new Error(`unknown material id ${id}`)
  return m
}
