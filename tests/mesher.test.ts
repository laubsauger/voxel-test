import { describe, expect, it } from 'vitest'
import { PAD, buildPaddedChunk, meshChunk, paddedIndex, type ChunkMesh } from '../src/render/mesher'
import { MAT_GLASS, MAT_WATER_SOLID } from '../src/sim/materials'

/** T39 split the mesher output into streams; T6 cases exercise opaque faces */
const meshChunkOpaque = (p: Uint8Array): ChunkMesh => meshChunk(p).opaque

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
    const m = meshChunkOpaque(grid([]))
    expect(m.quadCount).toBe(0)
    expect(m.positions).toHaveLength(0)
    expect(m.indices).toHaveLength(0)
  })

  it('single voxel → 6 quads, 24 verts, 36 indices, one per face direction', () => {
    const m = meshChunkOpaque(grid([[0, 0, 0, 7]]))
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
    const m = meshChunkOpaque(grid([[0, 0, 0, 3], [1, 0, 0, 3]]))
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
    const m = meshChunkOpaque(grid([[0, 0, 0, 3], [1, 0, 0, 4]]))
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
    const m = meshChunkOpaque(p)
    expect(m.quadCount).toBe(6) // each face merged to a single 32×32 rect
    expect(m.positions).toHaveLength(24 * 3)
  })

  it('neighbor shell culls boundary faces (needs neighbor chunk data)', () => {
    // voxel at chunk edge; neighbor chunk voxel (shell x=32) is solid
    const m = meshChunkOpaque(grid([[31, 0, 0, 5], [32, 0, 0, 5]]))
    const dirs = quads(m).map((q) => q.normal.join(','))
    expect(m.quadCount).toBe(5)
    expect(dirs).not.toContain('1,0,0') // +x face hidden by neighbor chunk
  })

  it('uv is quad-local and scaled by quad size (texture tiling)', () => {
    const m = meshChunkOpaque(grid([[0, 0, 0, 3], [1, 0, 0, 3]]))
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

// T39/B5: transparent materials (I.mat Transparent flag: glass, water-solid)
// mesh into a SECOND stream so windows can render see-through. The face
// rules below are why glass reads as glass: a culled boundary face would
// leave a hole in the wall behind a window (B5's original bug was the
// inverse — glass merged into the opaque stream and rendered solid).
describe('transparency streams (T39)', () => {
  it('a lone glass voxel meshes 6 quads into the transparent stream only', () => {
    const m = meshChunk(grid([[0, 0, 0, MAT_GLASS]]))
    expect(m.opaque.quadCount).toBe(0)
    expect(m.transparent.quadCount).toBe(6)
    for (let i = 0; i < m.transparent.materials.length; i++) {
      expect(m.transparent.materials[i]).toBe(MAT_GLASS)
    }
  })

  it('adjacent same-material glass culls interior faces and greedy-merges', () => {
    const m = meshChunk(grid([[0, 0, 0, MAT_GLASS], [1, 0, 0, MAT_GLASS]]))
    // like the solid pair: 4 merged sides + 2 end caps, no x=1 interior face
    expect(m.transparent.quadCount).toBe(6)
    for (const q of quads(m.transparent)) {
      expect(q.verts.every((v) => v[0] === 1), 'interior glass face leaked').toBe(false)
    }
  })

  it('solid vs glass: the solid face is EMITTED (visible through the pane), glass emits none toward the solid', () => {
    const m = meshChunk(grid([[0, 0, 0, 4], [1, 0, 0, MAT_GLASS]]))
    // opaque: 6 faces (its +x boundary face against glass must NOT cull)
    expect(m.opaque.quadCount).toBe(6)
    const solidBoundary = quads(m.opaque).find((q) => q.normal[0] === 1)
    expect(solidBoundary, 'solid face against glass was culled').toBeDefined()
    expect(solidBoundary!.verts.every((v) => v[0] === 1)).toBe(true)
    // glass: 5 faces — no face looking back into the solid (-x)
    expect(m.transparent.quadCount).toBe(5)
    expect(quads(m.transparent).map((q) => q.normal.join(','))).not.toContain('-1,0,0')
  })

  it('glass vs water-solid: DIFFERENT transparent materials both emit at the seam', () => {
    const m = meshChunk(grid([[0, 0, 0, MAT_GLASS], [1, 0, 0, MAT_WATER_SOLID]]))
    const dirs = quads(m.transparent).map((q) => `${q.mat}:${q.normal.join(',')}`)
    expect(m.opaque.quadCount).toBe(0)
    expect(m.transparent.quadCount).toBe(12) // 6 + 6, seam faces kept both sides
    expect(dirs).toContain(`${MAT_GLASS}:1,0,0`)
    expect(dirs).toContain(`${MAT_WATER_SOLID}:-1,0,0`)
  })

  it('window-in-wall: wall ring keeps opaque reveal faces, pane is transparent-only', () => {
    // 3×3 plaster wall slab at x∈[0..2],y∈[0..2],z=0 with a glass center
    const voxels: Array<[number, number, number, number]> = []
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 3; x++) {
        voxels.push([x, y, 0, x === 1 && y === 1 ? MAT_GLASS : 7])
      }
    }
    const m = meshChunk(grid(voxels))
    // the pane's two big faces (±z) live in the transparent stream
    const paneDirs = new Set(quads(m.transparent).map((q) => q.normal.join(',')))
    expect(paneDirs).toEqual(new Set(['0,0,1', '0,0,-1']))
    // the wall emits its 4 reveal faces around the pane (visible through it)
    for (const dir of ['1,0,0', '-1,0,0', '0,1,0', '0,-1,0']) {
      const reveal = quads(m.opaque).some(
        (q) => q.normal.join(',') === dir && q.mat === 7 &&
          // reveal faces of the opening touch the pane cell x∈[1,2] y∈[1,2]
          q.verts.every((v) => v[0] >= 1 && v[0] <= 2 && v[1] >= 1 && v[1] <= 2),
      )
      expect(reveal, `missing wall reveal face ${dir}`).toBe(true)
    }
  })
})
