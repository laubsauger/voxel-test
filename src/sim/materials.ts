/**
 * I.mat — material table. Voxel byte id → material params (V5: ids 0..255,
 * table holds ~16 slots). Shared by render (colorRamp), physics (strength,
 * density) and content (stamping, .vox remap) tracks.
 *
 * Id assignments (coordinate via src/sim/gen/INTEGRATION-content.md):
 *   0 air, 1 dirt, 2 grass, 3 asphalt, 4 concrete, 5 brick, 6 wood,
 *   7 plaster, 8 glass, 9 metal, 10 water-solid marker (reserved for the
 *   water track: solid cells the CA treats as water source volume),
 *   11..15 reserved (null).
 */

export const enum MatFlags {
  None = 0,
  Flammable = 1,
  Floats = 2,
  Transparent = 4,
}

export interface Material {
  id: number
  name: string
  /** two RGB endpoints (0xRRGGBB) for per-voxel color variation */
  colorRamp: [number, number]
  /** blast/dig resistance, 0 = not destructible-relevant (air) */
  strength: number
  /** kg/m³ — drives island mass + floats behavior */
  density: number
  flags: number
}

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

/** table indexed by material id; null = reserved slot */
export const MATERIALS: (Material | null)[] = [
  { id: 0, name: 'air', colorRamp: [0x000000, 0x000000], strength: 0, density: 0, flags: MatFlags.None },
  { id: 1, name: 'dirt', colorRamp: [0x6b4a2e, 0x7d5a3a], strength: 20, density: 1600, flags: MatFlags.None },
  { id: 2, name: 'grass', colorRamp: [0x4f7d3a, 0x639448], strength: 15, density: 1400, flags: MatFlags.None },
  { id: 3, name: 'asphalt', colorRamp: [0x2e2e32, 0x3a3a40], strength: 60, density: 2400, flags: MatFlags.None },
  { id: 4, name: 'concrete', colorRamp: [0x9a9a94, 0xb0b0a8], strength: 80, density: 2400, flags: MatFlags.None },
  { id: 5, name: 'brick', colorRamp: [0x9c4a32, 0xb05a3c], strength: 50, density: 1900, flags: MatFlags.None },
  { id: 6, name: 'wood', colorRamp: [0x8a6a42, 0xa07c50], strength: 30, density: 600, flags: MatFlags.Flammable | MatFlags.Floats },
  { id: 7, name: 'plaster', colorRamp: [0xd8d2c4, 0xe8e2d4], strength: 25, density: 1000, flags: MatFlags.None },
  { id: 8, name: 'glass', colorRamp: [0xa8cce0, 0xc0e0f0], strength: 5, density: 2500, flags: MatFlags.Transparent },
  { id: 9, name: 'metal', colorRamp: [0x707880, 0x8a929a], strength: 120, density: 7800, flags: MatFlags.None },
  { id: 10, name: 'water-solid', colorRamp: [0x2a5a8a, 0x3a6a9a], strength: 0, density: 1000, flags: MatFlags.Transparent },
  null,
  null,
  null,
  null,
  null,
]

export function getMaterial(id: number): Material | null {
  return id >= 0 && id < MATERIALS.length ? MATERIALS[id] : null
}
