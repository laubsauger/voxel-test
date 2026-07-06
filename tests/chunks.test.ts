import { describe, expect, it } from 'vitest'
import { ChunkKind, ChunkStore, chunkIndex, CHUNK_VOL, CHUNK_COUNT } from '../src/world/chunks'
import { Sim } from '../src/sim/loop'
import { hashSim } from '../src/sim/hash'

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

// P18 — palette compression. WHY this matters: the store must shrink cold
// chunks to grow the world past its heap ceiling WITHOUT ever perturbing the
// logical voxels or the lockstep determinism hash (V2/V3). Compression is a
// pure memory optimization; a compressed chunk must be byte-for-byte identical
// to its Dense form on every read, hash, and serialize.
describe('ChunkStore palette compression (P18, V3)', () => {
  /** build a Dense chunk (index 0) with a handful of materials in a fixed pattern */
  function makeDenseChunk(s: ChunkStore): void {
    s.fillBox(0, 0, 0, 20, 31, 31, 3) // partial cover → chunk 0 becomes Dense (air + mat 3)
    // scatter a few more materials deterministically so the palette is > 1
    for (let i = 0; i < CHUNK_VOL; i += 7) {
      const x = i & 31
      const y = (i >> 10) & 31
      const z = (i >> 5) & 31
      s.setVoxel(x, y, z, (i % 13) as number) // materials 0..12
    }
  }

  it('compress → inflate round-trips a Dense chunk byte-exact (lossless)', () => {
    const s = new ChunkStore()
    makeDenseChunk(s)
    const ci = chunkIndex(0, 0, 0)
    expect(s.chunkAtRaw(ci).kind).toBe(ChunkKind.Dense)
    const before = s.chunkAt(ci).data!.slice() // snapshot logical bytes

    const ok = s.compress(ci)
    expect(ok).toBe(true)
    expect(s.chunkAtRaw(ci).kind).toBe(ChunkKind.Palette)
    // packed payload is strictly smaller than the 32768-byte Dense array
    const raw = s.chunkAtRaw(ci)
    expect(raw.packed!.length + raw.palette!.length).toBeLessThan(CHUNK_VOL)

    // getVoxel reads the compressed chunk directly, still byte-exact
    for (let vi = 0; vi < CHUNK_VOL; vi++) {
      const x = vi & 31, z = (vi >> 5) & 31, y = (vi >> 10) & 31
      expect(s.getVoxel(x, y, z)).toBe(before[vi])
    }

    // chunkAt inflates back to a byte-identical Dense array
    const after = s.chunkAt(ci)
    expect(after.kind).toBe(ChunkKind.Dense)
    expect(after.data!).toEqual(before)
  })

  it('compress is a no-op on empty/uniform chunks', () => {
    const s = new ChunkStore()
    s.fillBox(0, 0, 0, 31, 31, 31, 5) // uniform
    expect(s.compress(chunkIndex(0, 0, 0))).toBe(false)
    expect(s.compress(chunkIndex(9, 9, 9))).toBe(false) // empty
  })

  it('setVoxel on a compressed chunk inflates and writes correctly', () => {
    const s = new ChunkStore()
    makeDenseChunk(s)
    const ci = chunkIndex(0, 0, 0)
    s.compress(ci)
    expect(s.chunkAtRaw(ci).kind).toBe(ChunkKind.Palette)
    s.setVoxel(5, 5, 5, 42)
    expect(s.chunkAtRaw(ci).kind).toBe(ChunkKind.Dense) // write made it hot again
    expect(s.getVoxel(5, 5, 5)).toBe(42)
  })

  // THE determinism guarantee: hashSim must be identical whether or not the
  // world is compressed. Peers may compress on different schedules; if this
  // failed, lockstep would desync (V3, non-negotiable).
  it('hashSim is identical whether or not chunks are compressed', () => {
    const build = () => {
      const sim = new Sim(1234)
      sim.world.fillBox(0, 0, 0, 200, 20, 200, 3) // ground band → many chunks
      sim.world.stampSphere(50, 20, 50, 8, 0) // dig → Dense chunks w/ air+mat
      sim.world.stampSphere(120, 18, 130, 10, 7) // add another material
      sim.world.setVoxel(64, 22, 64, 9)
      return sim
    }
    const a = build()
    const uncompressed = hashSim(a)

    const b = build()
    // compress EVERY Dense chunk in b
    let compressed = 0
    for (let i = 0; i < CHUNK_COUNT; i++) if (b.world.compress(i)) compressed++
    expect(compressed).toBeGreaterThan(0) // sanity: we actually compressed something
    const compressedHash = hashSim(b)

    expect(compressedHash).toBe(uncompressed)

    // and it stays equal after a partial inflate (mixed state, like a live peer)
    b.world.chunkAt(chunkIndex(50 >> 5, 20 >> 5, 50 >> 5)) // inflate one chunk
    expect(hashSim(b)).toBe(uncompressed)
  })

  it('compactStep sweeps cold chunks and reclaims memory, skipping dirty ones', () => {
    const s = new ChunkStore()
    makeDenseChunk(s)
    s.setVoxel(300, 5, 300, 4) // a second Dense chunk, currently dirty
    const dirtyCi = chunkIndex(300 >> 5, 0, 300 >> 5)
    // chunk 0's edits are also dirty; drain so only the fresh edit stays dirty
    s.drainDirty()
    s.setVoxel(300, 6, 300, 5) // re-dirty the far chunk only
    const reclaimed = s.compactStep(100, CHUNK_COUNT)
    expect(reclaimed).toBeGreaterThan(0)
    expect(s.chunkAtRaw(chunkIndex(0, 0, 0)).kind).toBe(ChunkKind.Palette) // cold → compressed
    expect(s.chunkAtRaw(dirtyCi).kind).toBe(ChunkKind.Dense) // dirty → left alone
  })
})
