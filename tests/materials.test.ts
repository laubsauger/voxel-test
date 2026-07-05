import { describe, expect, it } from 'vitest'
import { MAT_AIR, MATERIALS, getMaterial } from '../src/render/materials'

// I.mat: id byte → {colorRamp, strength, density, flags}. 0 = air, ~16 entries.
// The table drives destruction feel (strength), physics (density, floats)
// and rendering (colorRamp, PBR params) — entries must stay coherent.
describe('material table (I.mat)', () => {
  it('has 17 entries whose id matches their table index (voxel byte == index)', () => {
    expect(MATERIALS).toHaveLength(17) // B32 — added sand (16)
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
    expect(() => getMaterial(17)).toThrow(/unknown material/) // 16 is now sand
    expect(() => getMaterial(255)).toThrow(/unknown material/)
  })
})
