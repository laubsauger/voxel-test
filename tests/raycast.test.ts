import { describe, expect, it } from 'vitest'
import { ddaRaycast } from '../src/sim/shoot-op'
import { raycastWorld } from '../src/ui/raycast'
import { ChunkStore, VOXEL_SIZE } from '../src/world/chunks'

// T28 — DDA voxel raycaster: known grid hits, face normals, misses.
// One traversal implementation serves both the sim 'shoot' handler and the
// render-layer tool targeting — these tests pin its geometry down.

function worldWithBlock(x: number, y: number, z: number, mat = 4): ChunkStore {
  const w = new ChunkStore()
  w.setVoxel(x, y, z, mat)
  return w
}

describe('ddaRaycast (voxel space)', () => {
  it('hits a known voxel straight down +x with the entry-face normal', () => {
    const w = worldWithBlock(10, 5, 5)
    const hit = ddaRaycast(w, 2.5, 5.5, 5.5, 1, 0, 0, 100)
    expect(hit).not.toBeNull()
    expect([hit!.x, hit!.y, hit!.z]).toEqual([10, 5, 5])
    expect(hit!.mat).toBe(4)
    expect([hit!.nx, hit!.ny, hit!.nz]).toEqual([-1, 0, 0]) // entered through -x face
    expect(hit!.dist).toBeCloseTo(7.5, 10) // 2.5 → boundary at 10
  })

  it('hits along -y (digging straight down)', () => {
    const w = worldWithBlock(3, 2, 3)
    const hit = ddaRaycast(w, 3.5, 9.5, 3.5, 0, -1, 0, 100)
    expect([hit!.x, hit!.y, hit!.z]).toEqual([3, 2, 3])
    expect([hit!.nx, hit!.ny, hit!.nz]).toEqual([0, 1, 0])
  })

  it('traverses diagonals without skipping voxels', () => {
    const w = new ChunkStore()
    // wall of voxels on the x=8 plane — a diagonal ray must not tunnel through
    for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) w.setVoxel(8, y, z, 1)
    const hit = ddaRaycast(w, 0.5, 0.5, 0.5, 1, 0.7, 0.3, 100)
    expect(hit).not.toBeNull()
    expect(hit!.x).toBe(8)
  })

  it('returns null on a miss within maxDist', () => {
    const w = worldWithBlock(50, 5, 5)
    expect(ddaRaycast(w, 0.5, 5.5, 5.5, 1, 0, 0, 10)).toBeNull()
    expect(ddaRaycast(w, 0.5, 5.5, 5.5, 0, 1, 0, 100)).toBeNull()
    expect(ddaRaycast(w, 0.5, 5.5, 5.5, 0, 0, 0, 100)).toBeNull() // zero dir
  })

  it('reports a zero normal when the origin voxel is already solid', () => {
    const w = worldWithBlock(1, 1, 1)
    const hit = ddaRaycast(w, 1.5, 1.5, 1.5, 1, 0, 0, 10)
    expect(hit!.dist).toBe(0)
    expect([hit!.nx, hit!.ny, hit!.nz]).toEqual([0, 0, 0])
  })

  it('normalizes non-unit directions (dist stays in voxel units)', () => {
    const w = worldWithBlock(10, 5, 5)
    const hit = ddaRaycast(w, 2.5, 5.5, 5.5, 10, 0, 0, 100)
    expect(hit!.dist).toBeCloseTo(7.5, 10)
  })
})

describe('raycastWorld (meters wrapper, T28 tools)', () => {
  it('converts meters → voxels and exposes the place-adjacent voxel', () => {
    const w = worldWithBlock(10, 5, 5)
    // origin 0.25m = voxel 2.5; looking +x
    const hit = raycastWorld(w, 0.25, 0.55, 0.55, 1, 0, 0, 10)
    expect(hit).not.toBeNull()
    expect([hit!.x, hit!.y, hit!.z]).toEqual([10, 5, 5])
    // build target = voxel just outside the entry face
    expect([hit!.px, hit!.py, hit!.pz]).toEqual([9, 5, 5])
    expect(hit!.mx).toBeCloseTo(10.5 * VOXEL_SIZE, 10)
  })

  it('respects maxDist in meters', () => {
    const w = worldWithBlock(10, 5, 5) // 1m away and change
    expect(raycastWorld(w, 0.25, 0.55, 0.55, 1, 0, 0, 0.5)).toBeNull()
    expect(raycastWorld(w, 0.25, 0.55, 0.55, 1, 0, 0, 2)).not.toBeNull()
  })
})
