import { describe, expect, it } from 'vitest'
import { ChunkStore } from '../src/world/chunks'
import { Prng } from '../src/sim/prng'
import { WaterSim } from '../src/sim/water/water-sim'
import { MAX_LEVEL } from '../src/sim/water/rules'

// V9 — mass conservation. The total integer water sum must be EXACTLY
// constant across every step absent explicit source/sink ops. This is the
// invariant the pairwise-symmetric gather rules exist for; any asymmetric
// flow, active-set skip bug, or overflow shows up here.

/** complex terrain: rough heightfield + overhang slab + staircase + a pit, seeded */
function buildTerrain(world: ChunkStore, seed: number): void {
  const rng = new Prng(seed)
  for (let x = 0; x < 48; x++) {
    for (let z = 0; z < 32; z++) {
      const h = 2 + rng.nextInt(9) // rough ground, heights 2..10
      world.fillBox(x, 0, z, x, h, z, 2)
    }
  }
  world.fillBox(10, 14, 10, 24, 14, 24, 3) // floating overhang slab
  for (let i = 0; i < 8; i++) world.fillBox(30 + i, 0, 4, 31 + i, 11 - i, 12, 2) // staircase
  world.fillBox(38, 2, 18, 44, 10, 26, 0) // carve a pit into the ground
  // containment walls (world edges block the other two sides) — keeps the
  // active region small so the test stays fast
  world.fillBox(48, 0, 0, 49, 30, 33, 2)
  world.fillBox(0, 0, 32, 49, 30, 33, 2)
}

describe('water mass conservation over long runs (V9)', () => {
  it('total mass is exactly constant across 500 steps on complex terrain', () => {
    const world = new ChunkStore()
    buildTerrain(world, 1337)
    const w = new WaterSim(world)
    const rng = new Prng(99)

    let expected = 0
    for (let step = 0; step < 500; step++) {
      // keep pouring during the first 100 steps — conservation must hold
      // while water is falling, splashing, and spreading, not just at rest
      if (step < 100 && step % 5 === 0) {
        for (let n = 0; n < 4; n++) {
          const x = rng.nextInt(48)
          const z = rng.nextInt(32)
          expected += w.addWater(x, 20 + rng.nextInt(8), z, MAX_LEVEL)
        }
      }
      w.step()
      expect(w.totalMass(), `mass drifted at step ${step}`).toBe(expected)
    }
    expect(expected).toBeGreaterThan(50 * MAX_LEVEL) // the scenario actually poured a lot
  })

  it('explicit sinks are the only way mass decreases', () => {
    const world = new ChunkStore()
    world.fillBox(0, 0, 0, 31, 4, 31, 2)
    const w = new WaterSim(world)
    let expected = 0
    for (let x = 10; x <= 20; x++) expected += w.addWater(x, 8, 15, MAX_LEVEL)
    for (let step = 0; step < 200; step++) {
      if (step === 50) expected -= w.removeWater(15, 5, 15, 100) // sink op
      w.step()
      expect(w.totalMass(), `mass drifted at step ${step}`).toBe(expected)
    }
  })

  it('conserves mass across chunk borders (water crossing 32-boundaries)', () => {
    const world = new ChunkStore()
    world.fillBox(0, 0, 0, 95, 4, 95, 2) // floor spanning 3×3 chunks
    const w = new WaterSim(world)
    let expected = 0
    // pour right on the chunk corner (32,32) so flow crosses x, z, and y pages
    for (let y = 6; y <= 12; y++) expected += w.addWater(32, y, 32, MAX_LEVEL)
    for (let step = 0; step < 400; step++) {
      w.step()
      expect(w.totalMass(), `mass drifted at step ${step}`).toBe(expected)
    }
  })
})
