import { describe, expect, it } from 'vitest'
import { ChunkKind, ChunkStore, chunkIndex, CHUNK_VOL } from '../src/world/chunks'

// V5: sparse chunk states keep a mostly-air/mostly-solid world in memory
// budget — dense realization only where edited.
describe('ChunkStore (I.chunk, V5)', () => {
  it('defaults to air everywhere, empty chunks allocate no data', () => {
    const s = new ChunkStore()
    expect(s.getVoxel(100, 100, 100)).toBe(0)
    expect(s.chunkAt(chunkIndex(3, 3, 3)).data).toBeNull()
  })

  it('setVoxel realizes uniform → dense preserving other voxels', () => {
    const s = new ChunkStore()
    s.fillBox(0, 0, 0, 31, 31, 31, 5) // whole chunk → uniform
    expect(s.chunkAt(chunkIndex(0, 0, 0)).kind).toBe(ChunkKind.Uniform)
    s.setVoxel(1, 1, 1, 0) // dig one voxel
    const c = s.chunkAt(chunkIndex(0, 0, 0))
    expect(c.kind).toBe(ChunkKind.Dense)
    expect(s.getVoxel(1, 1, 1)).toBe(0)
    expect(s.getVoxel(2, 1, 1)).toBe(5)
  })

  it('no-op writes do not dirty chunks', () => {
    const s = new ChunkStore()
    s.drainDirty()
    s.setVoxel(5, 5, 5, 0) // already air
    expect(s.drainDirty()).toHaveLength(0)
  })

  it('fillBox makes fully-covered chunks Uniform, partial chunks Dense', () => {
    const s = new ChunkStore()
    s.fillBox(0, 0, 0, 47, 31, 31, 3) // chunk 0 covered, chunk 1 half
    expect(s.chunkAt(chunkIndex(0, 0, 0)).kind).toBe(ChunkKind.Uniform)
    expect(s.chunkAt(chunkIndex(1, 0, 0)).kind).toBe(ChunkKind.Dense)
    expect(s.getVoxel(47, 10, 10)).toBe(3)
    expect(s.getVoxel(48, 10, 10)).toBe(0)
  })

  it('stampSphere digs a hole and marks dirty chunks', () => {
    const s = new ChunkStore()
    s.fillBox(0, 0, 0, 63, 63, 63, 2)
    s.drainDirty()
    s.stampSphere(32, 32, 32, 4, 0)
    expect(s.getVoxel(32, 32, 32)).toBe(0)
    expect(s.getVoxel(32, 37, 32)).toBe(2) // outside radius
    const dirty = s.drainDirty()
    expect(dirty.length).toBeGreaterThan(0)
  })

  it('out-of-bounds: get returns 0, set is a no-op', () => {
    const s = new ChunkStore()
    expect(s.getVoxel(-1, 0, 0)).toBe(0)
    expect(() => s.setVoxel(-1, 0, 0, 5)).not.toThrow()
    expect(s.getVoxel(1e6, 0, 0)).toBe(0)
  })

  it('drainDirty returns sorted, then clears', () => {
    const s = new ChunkStore()
    s.setVoxel(999, 0, 999, 1)
    s.setVoxel(0, 0, 0, 1)
    const d = s.drainDirty()
    expect(d).toEqual([...d].sort((a, b) => a - b))
    expect(s.drainDirty()).toHaveLength(0)
  })

  it('dense chunk is 32³ bytes', () => {
    expect(CHUNK_VOL).toBe(32768)
  })
})
