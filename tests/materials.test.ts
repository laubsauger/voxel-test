import { describe, expect, it } from 'vitest'
import { MAT_AIR, MATERIALS, getMaterial } from '../src/render/materials'
import * as SIM from '../src/sim/materials'

// I.mat: id byte → {colorRamp, strength, density, flags}. 0 = air, ~16 entries.
// The table drives destruction feel (strength), physics (density, floats)
// and rendering (colorRamp, PBR params) — entries must stay coherent.
describe('material table (I.mat)', () => {
  it('has 29 entries whose id matches their table index (voxel byte == index)', () => {
    expect(MATERIALS).toHaveLength(29) // B32 sand (16) + T99 bombay set (17-28)
    for (let i = 0; i < MATERIALS.length; i++) expect(MATERIALS[i].id).toBe(i)
  })

  it('id 0 is air: massless, strengthless, no flags', () => {
    const air = getMaterial(MAT_AIR)
    expect(air.name).toBe('air')
    expect(air.strength).toBe(0)
    expect(air.density).toBe(0)
    expect(air.flammable).toBe(false)
    expect(air.floats).toBe(false)
  })

  it('all non-air, non-reserved solids have positive density (physics mass)', () => {
    for (const m of MATERIALS.slice(1)) {
      if (m.name.startsWith('reserved-')) continue
      expect(m.density, m.name).toBeGreaterThan(0)
    }
  })

  it('glass and water are transparent, nothing structural is', () => {
    expect(getMaterial(8).name).toBe('glass')
    expect(getMaterial(8).transparent).toBe(true)
    expect(getMaterial(10).name).toBe('water-solid')
    expect(getMaterial(10).transparent).toBe(true)
    for (const name of ['concrete', 'brick', 'asphalt', 'metal']) {
      const m = MATERIALS.find((x) => x.name === name)!
      expect(m.transparent, name).toBe(false)
    }
  })

  it('render ids match the sim authority table (V13 — single I.mat source)', () => {
    expect(getMaterial(3).name).toBe('asphalt')
    expect(getMaterial(6).name).toBe('wood')
    expect(getMaterial(9).name).toBe('metal')
  })

  it('wood floats and burns (buoyancy + fire gameplay hooks)', () => {
    const wood = MATERIALS.find((m) => m.name === 'wood')!
    expect(wood.floats).toBe(true)
    expect(wood.flammable).toBe(true)
    expect(wood.density).toBeLessThan(1000) // must be lighter than water to float
  })

  it('metal is the only strongly metallic material', () => {
    const metal = MATERIALS.find((m) => m.name === 'metal')!
    expect(metal.metalness).toBeGreaterThan(0.5)
    for (const m of MATERIALS) {
      if (m.name !== 'metal') expect(m.metalness, m.name).toBeLessThan(0.5)
    }
  })

  it('lookup fails loud for ids outside the table', () => {
    expect(() => getMaterial(29)).toThrow(/unknown material/) // 28 = art-pink (T99)
    expect(() => getMaterial(255)).toThrow(/unknown material/)
  })
})

// T99 — bombay palette rows (WP1). Ids reserved in INTEGRATION-content.md
// first (B1 lesson: parallel agents once forked divergent id tables).
describe('T99 bombay materials', () => {
  const T99_IDS: Record<string, number> = {
    'salt-crust': SIM.MAT_SALT_CRUST,
    'playa-mud': SIM.MAT_PLAYA_MUD,
    rust: SIM.MAT_RUST,
    char: SIM.MAT_CHAR,
    'bone-shell': SIM.MAT_BONE_SHELL,
    'cracked-asphalt': SIM.MAT_CRACKED_ASPHALT,
    'galv-metal': SIM.MAT_GALV_METAL,
    'opera-blue': SIM.MAT_OPERA_BLUE,
    'art-red': SIM.MAT_ART_RED,
    'art-yellow': SIM.MAT_ART_YELLOW,
    'art-teal': SIM.MAT_ART_TEAL,
    'art-pink': SIM.MAT_ART_PINK,
  }

  it('every new id is unique and unclaimed by any pre-T99 material', () => {
    const ids = Object.values(T99_IDS)
    expect(new Set(ids).size).toBe(ids.length) // no duplicate reservations
    for (const id of ids) expect(id, `id ${id} collides with pre-T99 range`).toBeGreaterThanOrEqual(17)
    expect(Math.max(...ids)).toBe(28) // contiguous block matches the reservation doc
  })

  it('round-trips through the render derivation (V13 — render derives, never redefines)', () => {
    for (const [name, id] of Object.entries(T99_IDS)) {
      const sim = SIM.MATERIALS[id]!
      const render = getMaterial(id)
      expect(sim.name, `sim name @ ${id}`).toBe(name)
      expect(render.name, `render name @ ${id}`).toBe(name)
      expect(render.colorRamp, name).toEqual(sim.colorRamp)
      expect(render.strength, name).toBe(sim.strength)
      expect(render.density, name).toBe(sim.density)
    }
  })

  it('palette hexes match the bombay research doc (§1.7)', () => {
    expect(SIM.MATERIALS[SIM.MAT_SALT_CRUST]!.colorRamp).toEqual([0xede8dc, 0xf7f4ea])
    expect(SIM.MATERIALS[SIM.MAT_PLAYA_MUD]!.colorRamp).toEqual([0x8a7458, 0xc9b08a])
    expect(SIM.MATERIALS[SIM.MAT_RUST]!.colorRamp).toEqual([0x7a3b24, 0xb4552d])
    expect(SIM.MATERIALS[SIM.MAT_OPERA_BLUE]!.colorRamp[1]).toBe(0x4a8fd2) // #3E7FBF family
  })

  it('gameplay coherence: rust/galv weaker than metal, char is burned-out (weak, NOT flammable)', () => {
    const metal = SIM.MATERIALS[9]!
    expect(SIM.MATERIALS[SIM.MAT_RUST]!.strength).toBeLessThan(metal.strength)
    expect(SIM.MATERIALS[SIM.MAT_GALV_METAL]!.strength).toBeLessThan(metal.strength)
    const char = getMaterial(SIM.MAT_CHAR)
    expect(char.strength).toBe(1)
    expect(char.flammable).toBe(false) // already burned — fire must not re-ignite it
    expect(getMaterial(SIM.MAT_SALT_CRUST).strength).toBe(1) // walkable brittle crust
  })

  it('total material count stays far under the P18 palette cap (128) and the voxel byte (256)', () => {
    expect(SIM.MATERIALS.length).toBeLessThan(128) // PALETTE_MAX, src/world/chunks.ts
    expect(SIM.MATERIALS.length).toBeLessThan(256)
  })
})
