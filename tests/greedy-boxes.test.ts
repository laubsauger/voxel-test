import { describe, expect, it } from 'vitest'
import { greedyBoxes, type Box } from '../src/sim/greedy-boxes'
import { Prng } from '../src/sim/prng'

// T10/T12: greedy-merged boxes are the collider primitive for both static
// chunks and dynamic islands. They must exactly cover the solid voxels —
// a gap means falling through the world, an overhang means invisible walls.

function grid(sx: number, sy: number, sz: number, fill: (x: number, y: number, z: number) => number): Uint8Array {
  const g = new Uint8Array(sx * sy * sz)
  for (let y = 0; y < sy; y++)
    for (let z = 0; z < sz; z++)
      for (let x = 0; x < sx; x++) g[x + z * sx + y * sx * sz] = fill(x, y, z)
  return g
}

/** paint boxes back into a grid; throws on overlap or out-of-bounds */
function cover(boxes: Box[], sx: number, sy: number, sz: number): Uint8Array {
  const g = new Uint8Array(sx * sy * sz)
  for (const b of boxes) {
    expect(b.x >= 0 && b.y >= 0 && b.z >= 0).toBe(true)
    expect(b.x + b.sx <= sx && b.y + b.sy <= sy && b.z + b.sz <= sz).toBe(true)
    for (let y = b.y; y < b.y + b.sy; y++)
      for (let z = b.z; z < b.z + b.sz; z++)
        for (let x = b.x; x < b.x + b.sx; x++) {
          const i = x + z * sx + y * sx * sz
          expect(g[i], `overlap at ${x},${y},${z}`).toBe(0)
          g[i] = 1
        }
  }
  return g
}

describe('greedyBoxes (T10/T12 collider correctness)', () => {
  it('single voxel → one 1×1×1 box', () => {
    const g = grid(3, 3, 3, (x, y, z) => (x === 1 && y === 1 && z === 1 ? 5 : 0))
    expect(greedyBoxes(g, 3, 3, 3)).toEqual([{ x: 1, y: 1, z: 1, sx: 1, sy: 1, sz: 1 }])
  })

  it('full grid merges to a single box', () => {
    const g = grid(4, 4, 4, () => 2)
    expect(greedyBoxes(g, 4, 4, 4)).toEqual([{ x: 0, y: 0, z: 0, sx: 4, sy: 4, sz: 4 }])
  })

  it('empty grid → no boxes', () => {
    expect(greedyBoxes(new Uint8Array(8), 2, 2, 2)).toEqual([])
  })

  it('L-shape covers exactly, no overlap', () => {
    // 4×1×4 slab with one 2×1×2 corner missing
    const g = grid(4, 1, 4, (x, _y, z) => (x >= 2 && z >= 2 ? 0 : 1))
    const boxes = greedyBoxes(g, 4, 1, 4)
    const painted = cover(boxes, 4, 1, 4)
    for (let i = 0; i < g.length; i++) expect(painted[i]).toBe(g[i] === 0 ? 0 : 1)
    expect(boxes.length).toBe(2) // greedy on this shape must merge into two boxes
  })

  it('mixed materials merge (colliders ignore material)', () => {
    const g = grid(2, 1, 1, (x) => x + 1) // mats 1 and 2
    expect(greedyBoxes(g, 2, 1, 1)).toEqual([{ x: 0, y: 0, z: 0, sx: 2, sy: 1, sz: 1 }])
  })

  it('pseudo-random pattern: exact cover, deterministic output', () => {
    const prng = new Prng(42)
    const g = grid(8, 8, 8, () => (prng.nextU32() & 3 ? 0 : 1))
    const solidCount = g.reduce((n, v) => n + (v ? 1 : 0), 0)
    const boxes = greedyBoxes(g, 8, 8, 8)
    const painted = cover(boxes, 8, 8, 8)
    let covered = 0
    for (let i = 0; i < g.length; i++) {
      expect(painted[i]).toBe(g[i] === 0 ? 0 : 1) // covers all solid, no air
      covered += painted[i]
    }
    expect(covered).toBe(solidCount)
    // deterministic: same input → identical box list (V2)
    expect(greedyBoxes(g, 8, 8, 8)).toEqual(boxes)
  })

  it('rejects mismatched grid size (fail loud)', () => {
    expect(() => greedyBoxes(new Uint8Array(7), 2, 2, 2)).toThrow(/grid length/)
  })
})
