import { beforeAll, describe, expect, it } from 'vitest'
import { Sim } from '../src/sim/loop'
import { registerEditOps } from '../src/sim/edit-ops'
import { createPhysics, hashPhysics, loadJolt, type PhysicsWorld } from '../src/sim/physics'
import { TNT_POWER } from '../src/sim/tnt'
import type { ExplosionEvent } from '../src/sim/events'

// P19 — remote-detonated TNT: 'tnt_place' drops charge entities; 'tnt_detonate'
// blows them ALL at once (chained T55 explosions). No fuse timer. Deterministic
// + hashed (V2/V3): placed charges and the detonation cascade are sim state.

beforeAll(async () => {
  await loadJolt()
}, 30000)

async function setup(): Promise<{ sim: Sim; phys: PhysicsWorld }> {
  const sim = new Sim(1)
  registerEditOps(sim)
  sim.world.fillBox(0, 0, 0, 127, 11, 127, 4) // concrete slab, top at y=12 (1.2 m)
  const phys = await createPhysics(sim)
  return { sim, phys }
}

const place = (x: number, y: number, z: number) => ({ kind: 'tnt_place', x, y, z }) as const
const detonate = () => ({ kind: 'tnt_detonate' }) as const

/** place three charges in a row on the slab, one tick */
function placeThree(sim: Sim): void {
  sim.queue.push({ tick: sim.tick, playerId: 1, seq: 0, op: place(4.0, 1.3, 6.4) })
  sim.queue.push({ tick: sim.tick, playerId: 1, seq: 1, op: place(6.4, 1.3, 6.4) })
  sim.queue.push({ tick: sim.tick, playerId: 1, seq: 2, op: place(8.8, 1.3, 6.4) })
}

describe('remote TNT (P19, I.cmd, V1)', () => {
  it('tnt_place drops persistent charge entities (place several)', async () => {
    const { sim, phys } = await setup()
    placeThree(sim)
    sim.step()
    expect(phys.charges.size).toBe(3)
    // a few idle ticks: charges do NOT self-detonate (remote, no fuse)
    for (let i = 0; i < 30; i++) sim.step()
    expect(phys.charges.size).toBe(3)
    expect(sim.drainEvents().some((e) => e.kind === 'explosion')).toBe(false)
    phys.dispose()
  }, 30000)

  it('tnt_detonate blows all charges at once → chained explosions + craters', async () => {
    const { sim, phys } = await setup()
    placeThree(sim)
    sim.step()
    expect(phys.charges.size).toBe(3)
    sim.queue.push({ tick: sim.tick, playerId: 1, seq: 0, op: detonate() })
    sim.step()
    const booms = sim.drainEvents().filter((e): e is ExplosionEvent => e.kind === 'explosion')
    expect(booms.length).toBe(3) // one chained boom per charge
    expect(booms.every((b) => b.power === TNT_POWER)).toBe(true)
    expect(phys.charges.size).toBe(0) // every charge consumed
    // craters under each charge position (slab top voxel removed)
    expect(sim.world.getVoxel(40, 11, 64)).toBe(0)
    expect(sim.world.getVoxel(64, 11, 64)).toBe(0)
    expect(sim.world.getVoxel(88, 11, 64)).toBe(0)
    // rubble from the chained blasts
    expect(phys.bodies.size).toBeGreaterThan(0)
    phys.dispose()
  }, 30000)

  it('charges are hashed sim state (V3): placing one diverges the hash', async () => {
    const a = await setup()
    const b = await setup()
    a.sim.queue.push({ tick: 0, playerId: 1, seq: 0, op: place(6.4, 1.3, 6.4) })
    a.sim.step()
    b.sim.step()
    expect(hashPhysics(a.phys)).not.toBe(hashPhysics(b.phys))
    a.phys.dispose()
    b.phys.dispose()
  }, 30000)

  it('two identical runs (place several → remote detonate → chained booms) → identical hash sequences (V2/V3)', async () => {
    const run = async () => {
      const { sim, phys } = await setup()
      placeThree(sim)
      sim.step()
      sim.queue.push({ tick: sim.tick, playerId: 1, seq: 0, op: detonate() })
      const hashes: number[] = []
      for (let i = 0; i < 30; i++) {
        sim.step()
        hashes.push(hashPhysics(phys))
      }
      phys.dispose()
      return hashes
    }
    const a = await run()
    const b = await run()
    expect(b).toEqual(a)
    // sanity: detonation actually mutated hashed state across the run
    expect(a.some((h, i) => i > 0 && h !== a[i - 1])).toBe(true)
  }, 60000)
})
