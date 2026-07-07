import { beforeAll, describe, expect, it } from 'vitest'
import { Sim } from '../src/sim/loop'
import { registerEditOps } from '../src/sim/edit-ops'
import { createPhysics, hashPhysics, loadJolt, type PhysicsWorld } from '../src/sim/physics'
import { BOMB_FUSE_TICKS, BOMB_RESTITUTION } from '../src/sim/projectiles'
import type { ExplosionEvent } from '../src/sim/events'

// T54 — bomb projectile: 'throw' op spawns a sim-integrated projectile that
// arcs under gravity, bounces off voxels (restitution ~0.4), rests, and
// detonates the T55 explosion after a 3 s fuse. Deterministic + hashed (V2/V3):
// a desynced bomb means a desynced crater.

beforeAll(async () => {
  await loadJolt()
}, 30000)

async function setup(): Promise<{ sim: Sim; phys: PhysicsWorld }> {
  const sim = new Sim(1)
  registerEditOps(sim)
  sim.world.fillBox(0, 0, 0, 127, 7, 127, 3) // asphalt slab, top at y=8 (0.8 m)
  const phys = await createPhysics(sim)
  return { sim, phys }
}

const throwOp = (ox: number, oy: number, oz: number, vx: number, vy: number, vz: number) =>
  ({ kind: 'throw', ox, oy, oz, vx, vy, vz }) as const

describe('bomb projectile (T54, I.cmd, V1)', () => {
  it('throw spawns a projectile that arcs: rises, advances, then falls', async () => {
    const { sim, phys } = await setup()
    sim.queue.push({ tick: 0, playerId: 1, seq: 0, op: throwOp(3, 2, 3, 6, 5, 0) })
    sim.step()
    expect(phys.projectiles.size).toBe(1)
    const p = [...phys.projectiles.values()][0]
    const x0 = p.x
    let peak = p.y
    for (let i = 0; i < 40; i++) {
      sim.step()
      peak = Math.max(peak, p.y)
    }
    expect(peak).toBeGreaterThan(2.5) // rose above the launch height
    expect(p.x).toBeGreaterThan(x0 + 2) // travelled forward
    expect(p.y).toBeLessThan(peak) // and is falling again
    phys.dispose()
  }, 30000)

  it('bounces off the ground with ~0.4 restitution, then comes to rest', async () => {
    const { sim, phys } = await setup()
    // straight drop from 4 m onto the slab
    sim.queue.push({ tick: 0, playerId: 1, seq: 0, op: throwOp(6.4, 4, 6.4, 0, 0, 0) })
    sim.step()
    const p = [...phys.projectiles.values()][0]
    let preImpact = 0
    let bounceVy = 0
    for (let i = 0; i < 120 && bounceVy === 0; i++) {
      if (p.vy < preImpact) preImpact = p.vy
      sim.step()
      if (p.vy > 0.5) bounceVy = p.vy
    }
    expect(bounceVy).toBeGreaterThan(0) // it DID bounce up
    // energy lost: upward speed ≈ restitution × impact speed (tick-boundary slack)
    expect(bounceVy).toBeLessThanOrEqual(-preImpact * BOMB_RESTITUTION * 1.1)
    // and it settles before the fuse runs out
    let rested = false
    for (let i = 0; i < 150 && !rested; i++) {
      sim.step()
      rested = p.resting
    }
    expect(rested).toBe(true)
    expect(p.y).toBeGreaterThan(0.8) // resting ON the slab, not inside it
    phys.dispose()
  }, 30000)

  it('fuse (180 ticks) detonates the T55 explosion at the rest position', async () => {
    const { sim, phys } = await setup()
    sim.queue.push({ tick: 0, playerId: 1, seq: 0, op: throwOp(6.4, 2, 6.4, 0, 0, 0) })
    expect(BOMB_FUSE_TICKS).toBe(180)
    let exploded: ExplosionEvent | undefined
    for (let i = 0; i <= BOMB_FUSE_TICKS + 2 && !exploded; i++) {
      sim.step()
      exploded = sim.drainEvents().find((e): e is ExplosionEvent => e.kind === 'explosion')
    }
    expect(exploded).toBeDefined()
    expect(phys.projectiles.size).toBe(0) // bomb consumed
    // crater: slab voxels under the rest position are gone
    expect(sim.world.getVoxel(64, 7, 64)).toBe(0)
    // detonation happened where it lay (asphalt slab under the drop point)
    expect(Math.abs(exploded!.x - 6.4)).toBeLessThan(0.5)
    // rubble: the T55 ejecta spawned interactive bodies
    expect(phys.debris!.bodies.size).toBeGreaterThan(0) // T86: debris in local layer
    phys.dispose()
  }, 30000)

  it('falls out of the world → removed by the kill plane, no explosion', async () => {
    const { sim, phys } = await setup()
    // above the void far off the slab (slab is x/z ≤ 12.8 m)
    sim.queue.push({ tick: 0, playerId: 1, seq: 0, op: throwOp(50, 2, 50, 0, 0, 0) })
    sim.step()
    expect(phys.projectiles.size).toBe(1)
    for (let i = 0; i < 130; i++) sim.step()
    expect(phys.projectiles.size).toBe(0)
    expect(sim.drainEvents().find((e) => e.kind === 'explosion')).toBeUndefined()
    phys.dispose()
  }, 30000)

  it('projectiles are hashed sim state (V3): sims with/without a bomb diverge', async () => {
    const a = await setup()
    const b = await setup()
    a.sim.queue.push({ tick: 0, playerId: 1, seq: 0, op: throwOp(6.4, 4, 6.4, 1, 3, 0) })
    a.sim.step()
    b.sim.step()
    expect(hashPhysics(a.phys)).not.toBe(hashPhysics(b.phys))
    a.phys.dispose()
    b.phys.dispose()
  }, 30000)

  it('two identical runs through flight, bounce and detonation → identical hash sequences (V2/V3)', async () => {
    const run = async () => {
      const { sim, phys } = await setup()
      sim.queue.push({ tick: 0, playerId: 1, seq: 0, op: throwOp(3, 2, 3, 6, 5, 1) })
      const hashes: number[] = []
      for (let i = 0; i < BOMB_FUSE_TICKS + 30; i++) {
        sim.step()
        hashes.push(hashPhysics(phys))
      }
      phys.dispose()
      return hashes
    }
    const a = await run()
    const b = await run()
    expect(b).toEqual(a)
  }, 60000)
})
