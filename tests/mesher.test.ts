import { describe, expect, it } from 'vitest'
import { PAD, buildPaddedChunk, meshChunk, paddedIndex, type ChunkMesh } from '../src/render/mesher'

// T6: greedy mesher correctness. These run the pure function — no Worker,
// no GPU — so a meshing regression fails fast in CI.

function grid(voxels: Array<[number, number, number, number]>): Uint8Array {
  const p = new Uint8Array(PAD * PAD * PAD)
  for (const [x, y, z, m] of voxels) p[paddedIndex(x, y, z)] = m
  return p
}

interface Quad {
  mat: number
  normal: [number, number, number]
  /** 4 corner positions */
  verts: [number, number, number][]
  ao: number[]
}

function quads(mesh: ChunkMesh): Quad[] {
  const out: Quad[] = []
  for (let q = 0; q < mesh.quadCount; q++) {
    const verts: [number, number, number][] = []
    for (let i = 0; i < 4; i++) {
      const o = (q * 4 + i) * 3
      verts.push([mesh.positions[o], mesh.positions[o + 1], mesh.positions[o + 2]])
    }
    out.push({
      mat: mesh.materials[q * 4],
      normal: [mesh.normals[q * 12], mesh.normals[q * 12 + 1], mesh.normals[q * 12 + 2]],
      verts,
      ao: [mesh.ao[q * 4], mesh.ao[q * 4 + 1], mesh.ao[q * 4 + 2], mesh.ao[q * 4 + 3]],
    })
  }
  return out
}

describe('greedy mesher (T6, V7-prep)', () => {
  it('empty chunk produces no geometry', () => {
    const m = meshChunk(grid([]))
    expect(m.quadCount).toBe(0)
    expect(m.positions).toHaveLength(0)
    expect(m.indices).toHaveLength(0)
  })

  it('single voxel → 6 quads, 24 verts, 36 indices, one per face direction', () => {
    const m = meshChunk(grid([[0, 0, 0, 7]]))
    expect(m.quadCount).toBe(6)
    expect(m.positions).toHaveLength(24 * 3)
    expect(m.normals).toHaveLength(24 * 3)
    expect(m.uvs).toHaveLength(24 * 2)
    expect(m.indices).toHaveLength(36)
    const dirs = new Set(quads(m).map((q) => q.normal.join(',')))
    expect(dirs).toEqual(
      new Set(['1,0,0', '-1,0,0', '0,1,0', '0,-1,0', '0,0,1', '0,0,-1']),
    )
    // all verts on the unit cube of that voxel
    for (const q of quads(m)) for (const v of q.verts) for (const c of v) {
      expect(c === 0 || c === 1).toBe(true)
    }
    // every quad carries the voxel's material
    for (let i = 0; i < m.materials.length; i++) expect(m.materials[i]).toBe(7)
  })

  it('two adjacent same-material voxels merge: 6 quads, no interior face', () => {
    const m = meshChunk(grid([[0, 0, 0, 3], [1, 0, 0, 3]]))
    // greedy: 4 side faces merged 2-long + 2 end caps = 6 quads (not 10)
    expect(m.quadCount).toBe(6)
    // no quad may lie in the interior plane x=1 (faces between solid voxels)
    for (const q of quads(m)) {
      expect(q.verts.every((v) => v[0] === 1)).toBe(false)
    }
    // merged top face spans x 0..2
    const top = quads(m).find((q) => q.normal[1] === 1)!
    const xs = top.verts.map((v) => v[0])
    expect(Math.min(...xs)).toBe(0)
    expect(Math.max(...xs)).toBe(2)
  })

  it('different materials do not merge but shared face is still culled', () => {
    const m = meshChunk(grid([[0, 0, 0, 3], [1, 0, 0, 4]]))
    // 2 end caps + 4 side directions × 2 voxels = 10 quads
    expect(m.quadCount).toBe(10)
    for (const q of quads(m)) {
      expect(q.verts.every((v) => v[0] === 1), 'interior face leaked').toBe(false)
    }
    const mats = new Set(quads(m).map((q) => q.mat))
    expect(mats).toEqual(new Set([3, 4]))
  })

  it('full solid chunk with empty neighbors → exactly 6 big quads', () => {
    const p = new Uint8Array(PAD * PAD * PAD)
    for (let y = 0; y < 32; y++)
      for (let z = 0; z < 32; z++)
        for (let x = 0; x < 32; x++) p[paddedIndex(x, y, z)] = 6
    const m = meshChunk(p)
    expect(m.quadCount).toBe(6) // each face merged to a single 32×32 rect
    expect(m.positions).toHaveLength(24 * 3)
  })

  it('neighbor shell culls boundary faces (needs neighbor chunk data)', () => {
    // voxel at chunk edge; neighbor chunk voxel (shell x=32) is solid
    const m = meshChunk(grid([[31, 0, 0, 5], [32, 0, 0, 5]]))
    const dirs = quads(m).map((q) => q.normal.join(','))
    expect(m.quadCount).toBe(5)
    expect(dirs).not.toContain('1,0,0') // +x face hidden by neighbor chunk
  })

  it('uv is quad-local and scaled by quad size (texture tiling)', () => {
    const m = meshChunk(grid([[0, 0, 0, 3], [1, 0, 0, 3]]))
    const top = quads(m).findIndex((q) => q.normal[1] === 1)
    const uv = m.uvs.slice(top * 8, top * 8 + 8)
    // a 1×2 or 2×1 rect: uv extents must be {1,2}
    const us = [uv[0], uv[2], uv[4], uv[6]]
    const vs = [uv[1], uv[3], uv[5], uv[7]]
    expect(new Set([Math.max(...us), Math.max(...vs)])).toEqual(new Set([1, 2]))
  })
})

describe('buildPaddedChunk (T6 neighbor gather)', () => {
  it('samples chunk voxels plus a 1-voxel neighbor shell in world coords', () => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    const sample = (x: number, y: number, _z: number): number => {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x)
      minY = Math.min(minY, y); maxY = Math.max(maxY, y)
      return 0
    }
    buildPaddedChunk(sample, 1, 2, 3)
    expect([minX, maxX]).toEqual([31, 64]) // chunk x ∈ [32,63] ± shell
    expect([minY, maxY]).toEqual([63, 96]) // chunk y ∈ [64,95] ± shell
  })

  it('places sampled voxels at the matching padded index', () => {
    const sample = (x: number, y: number, z: number): number =>
      x === 32 + 5 && y === 64 + 6 && z === 96 + 7 ? 9 : 0
    const p = buildPaddedChunk(sample, 1, 2, 3)
    expect(p[paddedIndex(5, 6, 7)]).toBe(9)
    expect(p.reduce((a, b) => a + b, 0)).toBe(9) // nothing else set
  })
})
