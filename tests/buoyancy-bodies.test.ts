import { beforeAll, describe, expect, it } from 'vitest'
import { Sim } from '../src/sim/loop'
import { registerEditOps } from '../src/sim/edit-ops'
import { createPhysics, hashPhysics, loadJolt, type PhysicsWorld } from '../src/sim/physics'
import { attachWaterSim, type WaterSim } from '../src/sim/water/water-sim'
import { attachBuoyancy } from '../src/sim/buoyancy-coupling'
import { MAT_CONCRETE, MAT_WOOD } from '../src/sim/materials'
import { MAX_LEVEL } from '../src/sim/water/rules'

// T17/T40.6 — buoyancy coupling: wood debris dropped in a pool must float and
// settle near the waterline; concrete must sink to the pool floor. Wrong sign,
// wrong system order or non-determinism here means floating concrete or
// lockstep desync the moment anything touches water.

beforeAll(async () => {
  await loadJolt()
}, 30000)

/**
 * Scripted pool world: ground slab (top y=0.8m), basin walls y8..15, water
 * filled x22..37 / z22..37 / y8..15 at 255 → waterline at y=16 voxels = 1.6m.
 * System order per src/sim/buoyancy-coupling.ts: physics → water → buoyancy.
 */
async function poolWorld(): Promise<{ sim: Sim; phys: PhysicsWorld; water: WaterSim }> {
  const sim = new Sim(3)
  registerEditOps(sim)
  sim.world.fillBox(0, 0, 0, 63, 7, 63, 3) // ground slab
  // basin walls (2 thick) around x20..39 / z20..39, up to y15
  sim.world.fillBox(20, 8, 20, 39, 15, 21, 4)
  sim.world.fillBox(20, 8, 38, 39, 15, 39, 4)
  sim.world.fillBox(20, 8, 22, 21, 15, 37, 4)
  sim.world.fillBox(38, 8, 22, 39, 15, 37, 4)
  const phys = await createPhysics(sim)
  const water = attachWaterSim(sim)
  attachBuoyancy(sim, phys, water)
  for (let y = 8; y <= 15; y++)
    for (let z = 22; z <= 37; z++)
      for (let x = 22; x <= 37; x++) water.addWater(x, y, z, MAX_LEVEL)
  return { sim, phys, water }
}

/** stamp a 4×4×4 blob above the pool center; next tick extracts it as an island */
function dropBlob(sim: Sim, phys: PhysicsWorld, mat: number) {
  sim.world.fillBox(28, 20, 28, 31, 23, 31, mat)
  sim.step()
  expect(phys.bodies.size).toBe(1)
  return [...phys.bodies.values()][0]
}

const WATERLINE = 16 * 0.1 // 1.6 m
const POOL_FLOOR = 8 * 0.1 // 0.8 m

describe('buoyancy coupling (T17, T40.6, I.mat floats)', () => {
  it('wood island floats: settles with its top above and bottom below the waterline', async () => {
    const { sim, phys } = await poolWorld()
    const body = dropBlob(sim, phys, MAT_WOOD)
    for (let i = 0; i < 600; i++) sim.step() // 10s: drop, bob, settle
    // grid corner y: floating equilibrium for ρ=600 is ~60% of the 0.4m cube
    // submerged → py ≈ 1.36m. Assert a generous floating band, clearly off the floor.
    expect(body.py).toBeGreaterThan(POOL_FLOOR + 0.3)
    expect(body.py).toBeLessThan(WATERLINE)
    expect(body.py + 0.4).toBeGreaterThan(WATERLINE) // top sticks out
    // …and it has settled (bob decayed): position drift < 1cm over the next second
    const y0 = body.py
    for (let i = 0; i < 60; i++) sim.step()
    expect(Math.abs(body.py - y0)).toBeLessThan(0.01)
    phys.dispose()
  }, 30000)

  it('concrete island sinks and rests on the pool floor', async () => {
    const { sim, phys } = await poolWorld()
    const body = dropBlob(sim, phys, MAT_CONCRETE)
    for (let i = 0; i < 400; i++) sim.step()
    expect(body.py).toBeCloseTo(POOL_FLOOR, 1) // resting on the basin floor
    phys.dispose()
  }, 30000)

  it('two identical pool runs → identical physics hash sequences (V2/V3)', async () => {
    const run = async () => {
      const { sim, phys } = await poolWorld()
      dropBlob(sim, phys, MAT_WOOD)
      const hashes: number[] = []
      for (let i = 0; i < 120; i++) {
        sim.step()
        hashes.push(hashPhysics(phys))
      }
      phys.dispose()
      return hashes
    }
    const a = await run()
    const b = await run()
    expect(b).toEqual(a)
  }, 30000)
})
