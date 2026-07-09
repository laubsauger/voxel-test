import { describe, expect, it } from 'vitest'
import { ChunkStore } from '../src/world/chunks'
import { WaterSim, hashWater } from '../src/sim/water/water-sim'
import { MAX_LEVEL } from '../src/sim/water/rules'

// T15 perf invariant — settled water costs nothing. The active-set design
// exists so a full pool at rest consumes zero sim time; if settling breaks,
// every pool in the arena burns CPU forever.

describe('water active set (T15 perf invariant)', () => {
  it('settles to zero active chunks, then steps are free and state is frozen', () => {
    const world = new ChunkStore()
    world.fillBox(0, 0, 0, 31, 5, 31, 2)
    // small basin
    world.fillBox(10, 6, 10, 21, 9, 10, 2)
    world.fillBox(10, 6, 21, 21, 9, 21, 2)
    world.fillBox(10, 6, 10, 10, 9, 20, 2)
    world.fillBox(21, 6, 11, 21, 9, 20, 2)
    const w = new WaterSim(world)
    for (let x = 12; x <= 19; x++) for (let z = 12; z <= 19; z++) w.addWater(x, 8, z, 200)

    let settledAt = -1
    for (let i = 0; i < 2000; i++) {
      w.step()
      if (w.activeChunkCount === 0) {
        settledAt = i
        break
      }
    }
    expect(settledAt, 'water never settled').toBeGreaterThanOrEqual(0)

    // settled: further steps change nothing — hash, stepCount, version frozen
    const hash = hashWater(w)
    const steps = w.stepCount
    const version = w.version
    for (let i = 0; i < 100; i++) w.step()
    expect(hashWater(w)).toBe(hash)
    expect(w.stepCount).toBe(steps) // stepCount does not advance while asleep
    expect(w.version).toBe(version)
    expect(w.activeChunkCount).toBe(0)
  })

  it('a source op wakes the region back up', () => {
    const world = new ChunkStore()
    world.fillBox(0, 0, 0, 31, 4, 31, 2)
    const w = new WaterSim(world)
    w.addWater(16, 5, 16, 50)
    for (let i = 0; i < 200 && w.activeChunkCount > 0; i++) w.step()
    expect(w.activeChunkCount).toBe(0)

    expect(w.addWater(16, 6, 16, 100)).toBe(100)
    expect(w.activeChunkCount).toBeGreaterThan(0)
    const before = hashWater(w)
    w.step()
    expect(hashWater(w)).not.toBe(before) // it actually simulates again
  })

  it('settled water does ZERO work — column work counter frozen at scale (V2-pure cost proof)', () => {
    // a large settled sheet (128×128 columns ≈ a park pond / sea slice) must
    // cost literally nothing per step: no wall-clock here (V2 purity) — the
    // sim's own work counter is the evidence
    const world = new ChunkStore()
    world.fillBox(0, 0, 0, 129, 4, 129, 2) // floor
    world.fillBox(0, 5, 0, 129, 6, 0, 2) // containment walls around the sheet
    world.fillBox(0, 5, 129, 129, 6, 129, 2)
    world.fillBox(0, 5, 0, 0, 6, 129, 2)
    world.fillBox(129, 5, 0, 129, 6, 129, 2)
    const w = new WaterSim(world)
    for (let x = 1; x <= 128; x++) for (let z = 1; z <= 128; z++) w.addWater(x, 5, z, 200)
    for (let i = 0; i < 5000 && w.activeChunkCount > 0; i++) w.step()
    expect(w.activeChunkCount).toBe(0)

    const work = w.workCount
    const hash = hashWater(w)
    for (let i = 0; i < 1000; i++) w.step() // ~8 seconds of game time
    expect(w.workCount, 'settled water still burned work').toBe(work)
    expect(hashWater(w)).toBe(hash)

    // a disturbance costs work again (the counter is live, not a stub)
    world.setVoxel(64, 4, 64, 0) // open the floor under the sheet
    w.notifyVoxelChanged(64, 4, 64)
    for (let i = 0; i < 4 && w.activeChunkCount > 0; i++) w.step()
    expect(w.workCount).toBeGreaterThan(work)
  })

  it('a voxel edit notification wakes a settled chunk', () => {
    const world = new ChunkStore()
    world.fillBox(0, 0, 0, 31, 8, 31, 2)
    world.fillBox(14, 6, 14, 17, 8, 17, 0) // small pit
    const w = new WaterSim(world)
    for (let x = 14; x <= 17; x++) for (let z = 14; z <= 17; z++) w.addWater(x, 6, z, MAX_LEVEL)
    for (let i = 0; i < 500 && w.activeChunkCount > 0; i++) w.step()
    expect(w.activeChunkCount).toBe(0)

    world.setVoxel(14, 5, 14, 0) // open the pit floor
    w.notifyVoxelChanged(14, 5, 14)
    expect(w.activeChunkCount).toBeGreaterThan(0)
    const mass = w.totalMass()
    for (let i = 0; i < 500 && w.activeChunkCount > 0; i++) w.step()
    expect(w.levelAt(14, 5, 14)).toBeGreaterThan(0) // water moved into the opened cell
    expect(w.totalMass()).toBe(mass)
  })
})
