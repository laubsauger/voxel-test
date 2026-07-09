import { describe, expect, it } from 'vitest'
import { ChunkStore, VOXEL_SIZE } from '../src/world/chunks'
import { WaterSim, hashWater } from '../src/sim/water/water-sim'
import { MAX_LEVEL } from '../src/sim/water/rules'
import { WaterSurface, extractWaterSurface } from '../src/render/water/surface'

// T16 — surface extraction is render-layer: it must produce a closed skin
// around exposed water and must never mutate sim state (V6).

describe('water surface extraction (T16, V6)', () => {
  it('a lone full water cell yields all 6 faces', () => {
    const world = new ChunkStore() // empty world: the cell rests at y=0, all faces exposed
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

  it('B20: a shorter water neighbor exposes a side strip (no see-through seams)', () => {
    const world = new ChunkStore()
    world.fillBox(0, 0, 0, 31, 4, 31, 2)
    const w = new WaterSim(world)
    w.addWater(5, 5, 5, MAX_LEVEL) // full column
    w.addWater(6, 5, 5, 100) // shorter neighbor — covers the shared face only up to 100/255
    const s = extractWaterSurface(w, world)
    // find the +x face of the full cell (normal +1,0,0 at x plane 6*VOXEL)
    let found = false
    for (let q = 0; q < s.normals.length / 12; q++) {
      const nx = s.normals[q * 12]
      const px = s.positions[q * 12]
      if (nx !== 1 || Math.abs(px - 0.6) > 1e-6) continue
      const ys = [1, 2, 3].map((v) => s.positions[q * 12 + v * 3 + 1]).concat(s.positions[q * 12 + 1])
      const minY = Math.min(...ys)
      const maxY = Math.max(...ys)
      // strip spans exactly neighbor fill height -> own fill height
      expect(minY).toBeCloseTo((5 + 100 / MAX_LEVEL) * VOXEL_SIZE, 6)
      expect(maxY).toBeCloseTo(6 * VOXEL_SIZE, 6)
      found = true
    }
    expect(found, 'side strip between differing fill heights was not emitted').toBe(true)
    // and the shorter cell's own face against the taller one stays culled
    for (let q = 0; q < s.normals.length / 12; q++) {
      const nx = s.normals[q * 12]
      const px = s.positions[q * 12]
      expect(nx === -1 && Math.abs(px - 0.6) < 1e-6, 'interior face leaked').toBe(false)
    }
  })

  it('B20: every wet column exposes exactly one top face — at its partial surface, never mid-column', () => {
    const world = new ChunkStore()
    world.fillBox(0, 0, 0, 31, 4, 31, 2)
    const w = new WaterSim(world)
    w.addWater(5, 5, 5, 120) // shallow partial column
    w.addWater(6, 5, 5, MAX_LEVEL) // deeper neighbor: full cell…
    w.addWater(6, 6, 5, 95) // …plus a partial surface cell above it
    const s = extractWaterSurface(w, world)
    let tops = 0
    let bottoms = 0
    for (let q = 0; q < s.normals.length / 12; q++) {
      const ny = s.normals[q * 12 + 1]
      if (ny === 1) tops++
      if (ny === -1) bottoms++
    }
    // one free surface per column — the full cell under more water must NOT
    // emit a top (open band bug, B20), and solid-floored cells no bottom
    expect(tops).toBe(2)
    expect(bottoms).toBe(0)
  })

  it('B26: edits far from water are free — no wake, no version bump, no rebuild', () => {
    const world = new ChunkStore()
    world.fillBox(0, 0, 0, 63, 4, 63, 2)
    const w = new WaterSim(world)
    world.onVoxelChanged = (x, y, z) => w.notifyVoxelChanged(x, y, z)
    // small pond in one corner
    for (let x = 4; x <= 8; x++) for (let z = 4; z <= 8; z++) w.addWater(x, 5, z, 200)
    for (let i = 0; i < 500 && w.activeChunkCount > 0; i++) w.step()
    expect(w.activeChunkCount).toBe(0)

    const surface = new WaterSurface()
    expect(surface.update(w, world)).toBe(true) // initial build
    expect(surface.chunkMeshCount).toBeGreaterThan(0)

    // dig on the far side of the map (same world, nowhere near water)
    const version = w.version
    world.setVoxel(60, 4, 60, 0)
    world.setVoxel(60, 3, 60, 0)
    expect(w.version, 'far edit must not bump water version').toBe(version)
    expect(w.activeChunkCount, 'far edit must not wake water').toBe(0)
    expect(surface.update(w, world), 'far edit must not rebuild the surface').toBe(false)

    // an edit NEXT to the pond still wakes + rebuilds
    world.setVoxel(9, 5, 6, 2) // solid beside the water
    expect(w.version).toBeGreaterThan(version)
    expect(surface.update(w, world)).toBe(true)
    surface.dispose()
  })

  it('B26: incremental rebuild equals a from-scratch extraction mid-drain', { timeout: 120000 }, () => {
    const world = new ChunkStore()
    world.fillBox(0, 0, 0, 63, 7, 63, 2)
    world.fillBox(28, 8, 28, 40, 12, 40, 2) // basin crossing the x/z=32 corner
    world.fillBox(29, 8, 29, 39, 12, 39, 0)
    const w = new WaterSim(world)
    world.onVoxelChanged = (x, y, z) => w.notifyVoxelChanged(x, y, z)
    for (let y = 8; y <= 11; y++)
      for (let z = 29; z <= 39; z++)
        for (let x = 29; x <= 39; x++) w.addWater(x, y, z, MAX_LEVEL)
    const surface = new WaterSurface()
    surface.update(w, world)

    // breach, then keep flowing; drain the dirty set only every few steps so
    // accumulation across steps is exercised too (render frame < sim rate)
    for (let y = 8; y <= 11; y++) world.setVoxel(28, y, 34, 0)
    for (let i = 0; i < 1200; i++) {
      w.step()
      if (i % 4 === 3) surface.update(w, world)
    }
    surface.update(w, world)

    // mid-flow incremental state must equal a from-scratch extraction
    const full = extractWaterSurface(w, world)
    let incrementalVerts = 0
    surface.mesh.traverse((o) => {
      const g = (o as { geometry?: { getAttribute(n: string): { count: number } } }).geometry
      if (g) incrementalVerts += g.getAttribute('position').count
    })
    expect(incrementalVerts).toBe(full.positions.length / 3)
    // setup validity: the pond must actually span multiple water PAGES so the
    // incremental path exercises cross-chunk seams (T94: meshes merge per
    // region now — mesh count no longer proxies chunk span)
    let pages = 0
    w.forEachPage(() => pages++)
    expect(pages).toBeGreaterThan(1)
    surface.dispose()
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
