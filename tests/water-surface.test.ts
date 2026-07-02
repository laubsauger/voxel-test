import { describe, expect, it } from 'vitest'
import { ChunkStore, VOXEL_SIZE } from '../src/world/chunks'
import { WaterSim, hashWater } from '../src/sim/water/water-sim'
import { MAX_LEVEL } from '../src/sim/water/rules'
import { extractWaterSurface } from '../src/render/water/surface'

// T16 — surface extraction is render-layer: it must produce a closed skin
// around exposed water and must never mutate sim state (V6).

describe('water surface extraction (T16, V6)', () => {
  it('a lone full water cell yields all 6 faces', () => {
    const world = new ChunkStore()
    const w = new WaterSim(world)
    w.addWater(5, 5, 5, MAX_LEVEL)
    const s = extractWaterSurface(w, world)
    expect(s.indices.length).toBe(6 * 6) // 6 quads × 2 tris
    expect(s.positions.length).toBe(6 * 4 * 3)
    expect(s.depths.length).toBe(6 * 4)
  })

  it('faces against solids and between water cells are culled', () => {
    const world = new ChunkStore()
    world.fillBox(0, 0, 0, 31, 4, 31, 2) // floor under the water
    const w = new WaterSim(world)
    w.addWater(5, 5, 5, MAX_LEVEL) // resting on floor
    w.addWater(6, 5, 5, MAX_LEVEL) // touching neighbor
    const s = extractWaterSurface(w, world)
    // per cell: no bottom (solid), no shared face → 2×(top + 3 sides) = 8 quads
    expect(s.indices.length / 6).toBe(8)
  })

  it('top surface sits at the partial fill height', () => {
    const world = new ChunkStore()
    world.fillBox(0, 0, 0, 31, 4, 31, 2)
    const w = new WaterSim(world)
    w.addWater(5, 5, 5, 100)
    const s = extractWaterSurface(w, world)
    // find the +y face vertices and check their height
    let topY = -1
    for (let i = 0; i < s.normals.length; i += 3) {
      if (s.normals[i + 1] === 1) topY = s.positions[i * 1 + 1]
    }
    const expected = (5 + 100 / MAX_LEVEL) * VOXEL_SIZE
    expect(topY).toBeCloseTo(expected, 6)
  })

  it('depth attribute measures contiguous water thickness', () => {
    const world = new ChunkStore()
    world.fillBox(0, 0, 0, 31, 4, 31, 2)
    const w = new WaterSim(world)
    // 3-deep column: two full cells + a full top cell
    w.addWater(5, 5, 5, MAX_LEVEL)
    w.addWater(5, 6, 5, MAX_LEVEL)
    w.addWater(5, 7, 5, MAX_LEVEL)
    const s = extractWaterSurface(w, world)
    const maxDepth = Math.max(...s.depths)
    expect(maxDepth).toBeCloseTo(3 * VOXEL_SIZE, 6)
  })

  it('extraction never mutates sim state (V6)', () => {
    const world = new ChunkStore()
    world.fillBox(0, 0, 0, 31, 4, 31, 2)
    const w = new WaterSim(world)
    w.addWater(16, 8, 16, MAX_LEVEL)
    for (let i = 0; i < 10; i++) w.step()
    const hashBefore = hashWater(w)
    const versionBefore = w.version
    extractWaterSurface(w, world)
    expect(hashWater(w)).toBe(hashBefore)
    expect(w.version).toBe(versionBefore)
    world.drainDirty() // extraction must not have dirtied chunks either
    extractWaterSurface(w, world)
    expect(world.drainDirty()).toHaveLength(0)
  })
})
