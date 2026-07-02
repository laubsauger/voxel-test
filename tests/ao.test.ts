import { describe, expect, it } from 'vitest'
import { PAD, meshChunk, paddedIndex, type ChunkMesh } from '../src/render/mesher'

// T7: per-vertex voxel AO (corner trick: 2 sides + 1 corner neighbor per
// quad vertex → level 0..3). AO is why voxel scenes read as 3D — and greedy
// merging across differing AO would smear it, so it gates merging too.

function grid(voxels: Array<[number, number, number, number]>): Uint8Array {
  const p = new Uint8Array(PAD * PAD * PAD)
  for (const [x, y, z, m] of voxels) p[paddedIndex(x, y, z)] = m
  return p
}

/** map "x,y,z" of each vertex of quads matching a filter → ao level */
function aoByVertex(
  mesh: ChunkMesh,
  filter: (normal: [number, number, number], verts: number[][]) => boolean,
): Map<string, number> {
  const out = new Map<string, number>()
  for (let q = 0; q < mesh.quadCount; q++) {
    const normal: [number, number, number] = [
      mesh.normals[q * 12],
      mesh.normals[q * 12 + 1],
      mesh.normals[q * 12 + 2],
    ]
    const verts: number[][] = []
    for (let i = 0; i < 4; i++) {
      const o = (q * 4 + i) * 3
      verts.push([mesh.positions[o], mesh.positions[o + 1], mesh.positions[o + 2]])
    }
    if (!filter(normal, verts)) continue
    for (let i = 0; i < 4; i++) out.set(verts[i].join(','), mesh.ao[q * 4 + i])
  }
  return out
}

const isTopFaceAtY1 = (n: number[], verts: number[][]): boolean =>
  n[1] === 1 && verts.every((v) => v[1] === 1)

describe('voxel AO (T7)', () => {
  it('an isolated voxel is fully open: AO 3 on every vertex', () => {
    const m = meshChunk(grid([[5, 5, 5, 1]]))
    for (let i = 0; i < m.ao.length; i++) expect(m.ao[i]).toBe(3)
  })

  it('side occluder darkens exactly the adjacent top-face corners (known config)', () => {
    // ground voxel at (2,0,2), occluder diagonally up at (3,1,2):
    // top-face vertices on the x=3 edge see one side neighbor → AO 2,
    // vertices on the x=2 edge stay fully open → AO 3.
    const m = meshChunk(grid([[2, 0, 2, 1], [3, 1, 2, 2]]))
    const ao = aoByVertex(m, isTopFaceAtY1)
    expect(ao.size).toBe(4)
    expect(ao.get('2,1,2')).toBe(3)
    expect(ao.get('2,1,3')).toBe(3)
    expect(ao.get('3,1,2')).toBe(2)
    expect(ao.get('3,1,3')).toBe(2)
  })

  it('two side occluders pinch a corner to AO 0 (corner rule, not additive)', () => {
    // occluders at (3,1,2) and (2,1,3) share the top-face corner (3,1,3)
    const m = meshChunk(grid([[2, 0, 2, 1], [3, 1, 2, 2], [2, 1, 3, 2]]))
    const ao = aoByVertex(m, isTopFaceAtY1)
    expect(ao.get('3,1,3')).toBe(0) // both sides solid ⇒ fully dark
    expect(ao.get('2,1,2')).toBe(3) // opposite corner untouched
  })

  it('corner-only neighbor costs one level (side1+side2+corner sum)', () => {
    // occluder diagonal at (3,1,3): only the corner sample for vertex (3,1,3)
    const m = meshChunk(grid([[2, 0, 2, 1], [3, 1, 3, 2]]))
    const ao = aoByVertex(m, isTopFaceAtY1)
    expect(ao.get('3,1,3')).toBe(2)
    expect(ao.get('2,1,2')).toBe(3)
  })

  it('differing AO prevents greedy merging (no AO smearing)', () => {
    // ground pair along z, same material — merges into 1 top quad...
    const plain = meshChunk(grid([[2, 0, 2, 1], [2, 0, 3, 1]]))
    const plainTop = aoByVertex(plain, isTopFaceAtY1)
    expect(plainTop.size).toBe(4) // one merged quad → 4 distinct vertices

    // ...but an occluder beside only one of them splits the AO keys
    const occl = meshChunk(grid([[2, 0, 2, 1], [2, 0, 3, 1], [3, 1, 2, 2]]))
    let topQuads = 0
    for (let q = 0; q < occl.quadCount; q++) {
      const verts: number[][] = []
      for (let i = 0; i < 4; i++) {
        const o = (q * 4 + i) * 3
        verts.push([occl.positions[o], occl.positions[o + 1], occl.positions[o + 2]])
      }
      if (isTopFaceAtY1([occl.normals[q * 12], occl.normals[q * 12 + 1], occl.normals[q * 12 + 2]], verts)) {
        topQuads++
      }
    }
    expect(topQuads).toBe(2) // split instead of smeared
    expect(occl.quadCount).toBeGreaterThan(plain.quadCount)
  })

  it('AO uses neighbor-chunk shell data at chunk boundaries', () => {
    // ground voxel at the chunk edge; occluder lives in the +x neighbor
    // chunk (shell coordinate 32) — AO must still darken the shared edge
    const m = meshChunk(grid([[31, 0, 5, 1], [32, 1, 5, 2]]))
    const ao = aoByVertex(m, isTopFaceAtY1)
    expect(ao.get('32,1,5')).toBe(2)
    expect(ao.get('32,1,6')).toBe(2)
    expect(ao.get('31,1,5')).toBe(3)
  })
})
