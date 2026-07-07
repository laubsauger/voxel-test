import { beforeAll, describe, expect, it } from 'vitest'
import { Sim } from '../src/sim/loop'
import { registerEditOps } from '../src/sim/edit-ops'
import { createPhysics, loadJolt, type PhysicsWorld } from '../src/sim/physics'
import { registerShootOp } from '../src/sim/shoot-op'
import { hashSim } from '../src/sim/hash'

// T28 — 'shoot' op (I.cmd): deterministic hitscan through sim.world, small
// strength-scaled destruction at the hit voxel, same connectivity path as
// explode. Mirrors tests/explode.test.ts patterns (V1: everything through
// commands; V2/V3: replayable).

beforeAll(async () => {
  await loadJolt()
}, 30000)

const DIRT = 1
const METAL = 9

async function setup(): Promise<{ sim: Sim; phys: PhysicsWorld }> {
  const sim = new Sim(1)
  registerEditOps(sim)
  sim.world.fillBox(0, 0, 0, 127, 7, 127, 3) // ground slab
  const phys = await createPhysics(sim)
  registerShootOp(sim, phys)
  return { sim, phys }
}

describe('shoot op (T28, I.cmd, V1)', () => {
  it('removes the hit voxel via a deterministic raycast', async () => {
    const { sim, phys } = await setup()
    // dirt wall on the x=100 voxel plane
    sim.world.fillBox(100, 8, 90, 100, 40, 110, DIRT)
    sim.step()

    // shoot from (5m, 2m, 10m) straight +x → must hit the wall at voxel x=100, y=20, z=100
    sim.queue.push({
      tick: 1,
      playerId: 1,
      seq: 0,
      op: { kind: 'shoot', ox: 5.05, oy: 2.05, oz: 10.05, dx: 1, dy: 0, dz: 0 },
    })
    sim.step()

    expect(sim.world.getVoxel(100, 20, 100)).toBe(0) // hit voxel removed
    // wall voxels well outside the r=1.5 sphere are untouched
    expect(sim.world.getVoxel(100, 24, 100)).toBe(DIRT)
    expect(sim.world.getVoxel(100, 20, 96)).toBe(DIRT)
    phys.dispose()
  }, 30000)

  it('does not scratch hard materials (metal survives SHOOT_POWER)', async () => {
    const { sim, phys } = await setup()
    sim.world.fillBox(100, 8, 90, 100, 40, 110, METAL)
    sim.step()
    sim.queue.push({
      tick: 1,
      playerId: 1,
      seq: 0,
      op: { kind: 'shoot', ox: 5.05, oy: 2.05, oz: 10.05, dx: 1, dy: 0, dz: 0 },
    })
    sim.step()
    expect(sim.world.getVoxel(100, 20, 100)).toBe(METAL)
    phys.dispose()
  }, 30000)

  it('misses are a no-op (sim hash matches a control sim without the shot)', async () => {
    const a = await setup()
    const b = await setup()
    a.sim.queue.push({
      tick: 0,
      playerId: 1,
      seq: 0,
      op: { kind: 'shoot', ox: 5, oy: 30, oz: 10, dx: 0, dy: 1, dz: 0 }, // straight up into air
    })
    a.sim.step()
    b.sim.step()
    expect(hashSim(a.sim)).toBe(hashSim(b.sim))
    a.phys.dispose()
    b.phys.dispose()
  }, 30000)

  it('severing a thin post spawns an island body (same connectivity path as explode)', async () => {
    const { sim, phys } = await setup()
    // 1-voxel post from the slab up
    sim.world.fillBox(100, 8, 100, 100, 30, 100, DIRT)
    sim.step()
    expect(phys.bodies.size).toBe(0)

    // shoot the post near its base — r=1.5 sphere cuts the 1-voxel column
    sim.queue.push({
      tick: 1,
      playerId: 1,
      seq: 0,
      op: { kind: 'shoot', ox: 5.05, oy: 1.25, oz: 10.05, dx: 1, dy: 0, dz: 0 },
    })
    sim.step()

    expect(phys.debris!.bodies.size).toBe(1) // T86: upper section became a LOCAL debris body
    phys.dispose()
  }, 30000)

  it('same shot twice in identical sims → identical outcome (V2/V3)', async () => {
    const runOnce = async () => {
      const { sim, phys } = await setup()
      sim.world.fillBox(100, 8, 90, 100, 40, 110, DIRT)
      sim.queue.push({
        tick: 1,
        playerId: 1,
        seq: 0,
        op: { kind: 'shoot', ox: 5.05, oy: 2.05, oz: 10.05, dx: 1, dy: 0.13, dz: 0.07 },
      })
      for (let i = 0; i < 5; i++) sim.step()
      const h = hashSim(sim)
      phys.dispose()
      return h
    }
    expect(await runOnce()).toBe(await runOnce())
  }, 30000)
})
