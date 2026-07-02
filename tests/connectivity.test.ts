import { describe, expect, it } from 'vitest'
import { ChunkStore } from '../src/world/chunks'
import {
  clampRegion,
  findUnsupportedIslands,
  MAX_REGION_EXTENT,
} from '../src/sim/connectivity'

// T11 — structural destruction hinges on this: cut a beam and the sim must
// find exactly the voxels that lost support, deterministically (V2), or
// clients desync and roofs float in mid-air.

function world(): ChunkStore {
  return new ChunkStore()
}

describe('connectivity flood-fill (T11, V2)', () => {
  it('supported structure → no islands', () => {
    const w = world()
    // pillar standing on ground layer y=0
    w.fillBox(10, 0, 10, 11, 10, 11, 3)
    const islands = findUnsupportedIslands(w, { x0: 0, y0: 0, z0: 0, x1: 30, y1: 30, z1: 30 })
    expect(islands).toEqual([])
  })

  it('cut beam → floating end becomes an island with exactly its voxels', () => {
    const w = world()
    // pillar (supported) + horizontal beam at its top
    w.fillBox(10, 0, 10, 11, 10, 11, 3) // pillar on ground
    w.fillBox(12, 10, 10, 20, 10, 11, 4) // beam sticking out
    // cut the beam at x=14..15
    w.fillBox(14, 10, 10, 15, 10, 11, 0)
    const islands = findUnsupportedIslands(w, { x0: 0, y0: 0, z0: 0, x1: 40, y1: 40, z1: 40 })
    expect(islands.length).toBe(1)
    const voxels = islands[0].voxels
    // floating piece: x 16..20, y 10, z 10..11 = 5*1*2 = 10 voxels, all mat 4
    expect(voxels.length).toBe(10)
    for (const v of voxels) {
      expect(v.x).toBeGreaterThanOrEqual(16)
      expect(v.x).toBeLessThanOrEqual(20)
      expect(v.y).toBe(10)
      expect(v.mat).toBe(4)
    }
  })

  it('free-floating blob is an island even without an edit', () => {
    const w = world()
    w.fillBox(5, 20, 5, 7, 22, 7, 5)
    const islands = findUnsupportedIslands(w, { x0: 0, y0: 10, z0: 0, x1: 20, y1: 40, z1: 20 })
    expect(islands.length).toBe(1)
    expect(islands[0].voxels.length).toBe(27)
  })

  it('escape hatch: structure reaching the region boundary with solid beyond → supported', () => {
    const w = world()
    // floating beam far above ground, extends past the region's +x face
    w.fillBox(10, 30, 10, 60, 30, 10, 4)
    const islands = findUnsupportedIslands(w, { x0: 0, y0: 20, z0: 0, x1: 40, y1: 40, z1: 20 })
    // beam continues at x=41+ outside the region ⇒ treated as connected
    expect(islands).toEqual([])
  })

  it('structure ending exactly at the region boundary with nothing beyond → island', () => {
    const w = world()
    w.fillBox(38, 30, 10, 40, 30, 10, 4) // ends at x=40 = boundary, air beyond
    const islands = findUnsupportedIslands(w, { x0: 0, y0: 20, z0: 0, x1: 40, y1: 40, z1: 20 })
    expect(islands.length).toBe(1)
    expect(islands[0].voxels.length).toBe(3)
  })

  it('two separate floating blobs → two islands, deterministic order', () => {
    const w = world()
    w.fillBox(5, 25, 5, 6, 26, 6, 3)
    w.fillBox(15, 20, 15, 16, 21, 16, 7)
    const a = findUnsupportedIslands(w, { x0: 0, y0: 10, z0: 0, x1: 30, y1: 40, z1: 30 })
    expect(a.length).toBe(2)
    // seed scan is y→z→x: the lower blob (y=20) comes first
    expect(a[0].voxels[0].mat).toBe(7)
    expect(a[1].voxels[0].mat).toBe(3)
    // identical run → identical result including voxel order (V2)
    const b = findUnsupportedIslands(w, { x0: 0, y0: 10, z0: 0, x1: 30, y1: 40, z1: 30 })
    expect(b).toEqual(a)
  })

  it('region clamps to MAX_REGION_EXTENT per axis', () => {
    const r = clampRegion({ x0: 0, y0: 0, z0: 0, x1: 999, y1: 40, z1: 999 })
    expect(r.x1 - r.x0 + 1).toBe(MAX_REGION_EXTENT)
    expect(r.z1 - r.z0 + 1).toBe(MAX_REGION_EXTENT)
    expect(r.y1 - r.y0 + 1).toBe(41)
  })
})
