import { describe, expect, it } from 'vitest'
import { chunkIndex } from '../src/world/chunks'
import { RemeshScheduler, chunkCenter, chunkCoords } from '../src/render/remesh-scheduler'

// V7: remesh is budgeted per frame — a big explosion dirties hundreds of
// chunks but each frame only pays for N, nearest to the camera first so the
// visible world updates before distant terrain.

describe('chunk coordinate helpers', () => {
  it('chunkCoords inverts chunkIndex', () => {
    for (const [cx, cy, cz] of [[0, 0, 0], [5, 3, 12], [31, 15, 31]] as const) {
      expect(chunkCoords(chunkIndex(cx, cy, cz))).toEqual([cx, cy, cz])
    }
  })

  it('chunkCenter is the chunk middle in world meters (32 vox × 0.1 m)', () => {
    expect(chunkCenter(chunkIndex(0, 0, 0))).toEqual({ x: 1.6, y: 1.6, z: 1.6 })
    const c = chunkCenter(chunkIndex(2, 1, 3))
    expect(c.x).toBeCloseTo(8, 10)
    expect(c.y).toBeCloseTo(4.8, 10)
    expect(c.z).toBeCloseTo(11.2, 10)
  })
})

describe('RemeshScheduler (T9, V7)', () => {
  const cam = chunkCenter(chunkIndex(0, 0, 0))

  it('respects the per-frame budget', () => {
    const s = new RemeshScheduler()
    for (let cx = 0; cx < 10; cx++) s.enqueue(chunkIndex(cx, 0, 0))
    expect(s.take(3, cam)).toHaveLength(3)
    expect(s.size).toBe(7) // rest stays queued for later frames
    expect(s.take(100, cam)).toHaveLength(7)
    expect(s.size).toBe(0)
    expect(s.take(5, cam)).toEqual([])
  })

  it('returns nearest-to-camera chunks first (priority ordering)', () => {
    const s = new RemeshScheduler()
    const far = chunkIndex(9, 0, 0)
    const near = chunkIndex(1, 0, 0)
    const mid = chunkIndex(4, 0, 0)
    s.enqueue(far)
    s.enqueue(near)
    s.enqueue(mid)
    expect(s.take(2, cam)).toEqual([near, mid])
    expect(s.take(2, cam)).toEqual([far])
  })

  it('prioritizes in full 3D, not just horizontally', () => {
    const s = new RemeshScheduler()
    const above = chunkIndex(0, 1, 0) // 3.2 m up
    const distant = chunkIndex(5, 0, 0) // 16 m away
    s.enqueue(distant)
    s.enqueue(above)
    expect(s.take(1, cam)).toEqual([above])
  })

  it('re-enqueueing a pending chunk does not duplicate work', () => {
    const s = new RemeshScheduler()
    const ci = chunkIndex(2, 2, 2)
    s.enqueue(ci)
    s.enqueue(ci)
    s.enqueue(ci)
    expect(s.size).toBe(1)
    expect(s.take(10, cam)).toEqual([ci])
  })

  it('breaks distance ties deterministically by chunk index', () => {
    const s = new RemeshScheduler()
    const camAt2 = chunkCenter(chunkIndex(2, 0, 0))
    const left = chunkIndex(1, 0, 0)
    const right = chunkIndex(3, 0, 0) // same distance from chunk 2 center
    s.enqueue(right)
    s.enqueue(left)
    expect(s.take(2, camAt2)).toEqual([left, right])
  })

  it('budget 0 takes nothing and leaves the queue intact', () => {
    const s = new RemeshScheduler()
    s.enqueue(chunkIndex(1, 1, 1))
    expect(s.take(0, cam)).toEqual([])
    expect(s.size).toBe(1)
  })
})
