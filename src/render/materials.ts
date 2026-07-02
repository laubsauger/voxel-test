/**
 * I.mat — material table (T8). id byte → render + gameplay params.
 * 0 = air. 16 entries. Voxel data stores only the id (V5); everything else
 * derives from this table. Pure data module: no three.js, no DOM — safe to
 * import from sim-adjacent code (physics density, water floats flag) and
 * unit-testable without a GPU.
 */

export interface MaterialDef {
  /** table index == voxel byte value */
  id: number
  name: string
  /** color ramp [dark, light] hex sRGB — shader mixes per-voxel */
  colorRamp: [number, number]
  /** destruction resistance, arbitrary units, 0 = none (air/fluids) */
  strength: number
  /** kg/m³ — physics mass + buoyancy */
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

function def(
  id: number,
  name: string,
  colorRamp: [number, number],
  strength: number,
  density: number,
  flags: { flammable?: boolean; floats?: boolean; transparent?: boolean },
  roughness: number,
  metalness = 0,
  emissive = 0,
): MaterialDef {
  return {
    id,
    name,
    colorRamp,
    strength,
    density,
    flammable: flags.flammable ?? false,
    floats: flags.floats ?? false,
    transparent: flags.transparent ?? false,
    roughness,
    metalness,
    emissive,
  }
}

export const MATERIALS: readonly MaterialDef[] = [
  def(0, 'air', [0x000000, 0x000000], 0, 0, {}, 1),
  def(1, 'dirt', [0x54422e, 0x7a6142], 2, 1500, {}, 0.95),
  def(2, 'grass', [0x44712f, 0x6fae4e], 2, 1400, { flammable: true }, 0.9),
  def(3, 'sand', [0xb5a675, 0xe0d3a0], 1, 1600, {}, 0.95),
  def(4, 'stone', [0x64645f, 0x8f8f88], 8, 2600, {}, 0.85),
  def(5, 'asphalt', [0x28282b, 0x454548], 5, 2300, {}, 0.9),
  def(6, 'concrete', [0x83837b, 0xb0b0a8], 7, 2400, {}, 0.85),
  def(7, 'brick', [0x83382a, 0xb05a40], 5, 1900, {}, 0.8),
  def(8, 'wood', [0x64452b, 0x9c7448], 3, 600, { flammable: true, floats: true }, 0.7),
  def(9, 'plaster', [0xc4bcae, 0xe8e2d6], 2, 900, {}, 0.75),
  def(10, 'glass', [0x9fc2d4, 0xd0e8f0], 1, 2500, { transparent: true }, 0.1),
  def(11, 'metal', [0x6e7176, 0xb4b8c0], 9, 7800, {}, 0.35, 0.9),
  def(12, 'water', [0x25517d, 0x4a8ac0], 0, 1000, { transparent: true }, 0.15),
  def(13, 'leaves', [0x2f4a25, 0x557d3a], 1, 300, { flammable: true, floats: true }, 0.8),
  def(14, 'rooftile', [0x5f342c, 0x8f4f42], 4, 1800, {}, 0.6),
  def(15, 'lamp', [0xffedb8, 0xfff9e0], 1, 400, {}, 0.5, 0, 4),
]

export const MAT_AIR = 0

/** lookup with loud failure on ids outside the table (corrupt voxel data) */
export function getMaterial(id: number): MaterialDef {
  const m = MATERIALS[id]
  if (m === undefined) throw new Error(`unknown material id ${id} (table has ${MATERIALS.length})`)
  return m
}
