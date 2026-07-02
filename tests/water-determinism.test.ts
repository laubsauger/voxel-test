import { describe, expect, it } from 'vitest'
import { ChunkStore } from '../src/world/chunks'
import { Fnv } from '../src/sim/hash'
import { Sim } from '../src/sim/loop'
import { WaterSim, attachWaterSim, hashWater, hashWaterInto } from '../src/sim/water/water-sim'
import { MAX_LEVEL } from '../src/sim/water/rules'

// V2/V3 — the water field is authoritative sim state: identical scenarios
// must produce identical hash sequences on every step, or lockstep peers
// desync. Also verifies the field hash integrates with the Fnv I.hash
// primitive so it can be folded into the global sim hash.

/** a scenario with falling, spreading, draining, and mid-run source/sink ops */
function runScenario(steps: number): { w: WaterSim; hashes: number[] } {
  const world = new ChunkStore()
  world.fillBox(0, 0, 0, 63, 6, 63, 2)
  world.fillBox(20, 7, 20, 43, 12, 20, 2)
  world.fillBox(20, 7, 43, 43, 12, 43, 2)
  world.fillBox(20, 7, 20, 20, 12, 42, 2)
  world.fillBox(43, 7, 21, 43, 12, 42, 2)
  const w = new WaterSim(world)
  const hashes: number[] = []
  for (let step = 0; step < steps; step++) {
    if (step < 20) {
      for (let x = 25; x <= 30; x++) w.addWater(x, 16, 30, MAX_LEVEL)
    }
    if (step === 60) {
      world.setVoxel(43, 8, 30, 0) // breach the pool wall
      w.notifyVoxelChanged(43, 8, 30)
    }
    if (step === 100) w.removeWater(30, 7, 30, 200)
    w.step()
    hashes.push(hashWater(w))
  }
  return { w, hashes }
}

describe('water determinism (V2, V3, I.hash)', () => {
  it('two identical runs produce identical hash sequences', () => {
    const a = runScenario(160)
    const b = runScenario(160)
    expect(a.hashes).toEqual(b.hashes)
    expect(a.w.totalMass()).toBe(b.w.totalMass())
  })

  it('a single-cell water difference changes the hash', () => {
    const a = runScenario(30)
    const b = runScenario(30)
    b.w.addWater(25, 13, 25, 1)
    expect(hashWater(a.w)).not.toBe(hashWater(b.w))
  })

  it('hashWater is FNV-1a over stepCount + sorted pages (Fnv integration)', () => {
    const { w } = runScenario(10)
    // reproduce the format manually with the I.hash primitive
    const h = new Fnv()
    h.u32(w.stepCount)
    w.forEachPage((ci, data) => h.u32(ci).bytes(data))
    expect(h.value).toBe(hashWater(w))
    // and it composes into a larger digest without disturbing it
    const combined = hashWaterInto(new Fnv().u32(0xdeadbeef), w).value
    expect(combined).not.toBe(hashWater(w))
    expect(combined >>> 0).toBe(combined) // u32
  })

  it('runs as a Sim system via attachWaterSim (V1 wiring, deterministic ticks)', () => {
    const run = (): number => {
      const sim = new Sim(42)
      sim.world.fillBox(0, 0, 0, 31, 4, 31, 2)
      const water = attachWaterSim(sim)
      water.addWater(16, 10, 16, MAX_LEVEL)
      for (let i = 0; i < 50; i++) sim.step()
      return hashWater(water)
    }
    expect(run()).toBe(run())
    // and the water actually moved: it fell out of the source cell
    const sim = new Sim(42)
    sim.world.fillBox(0, 0, 0, 31, 4, 31, 2)
    const water = attachWaterSim(sim)
    water.addWater(16, 10, 16, MAX_LEVEL)
    for (let i = 0; i < 10; i++) sim.step()
    expect(water.levelAt(16, 10, 16)).toBe(0)
    expect(water.totalMass()).toBe(MAX_LEVEL)
  })
})
