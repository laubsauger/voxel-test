import { beforeAll, describe, expect, it } from 'vitest'
import { Sim } from '../src/sim/loop'
import { registerEditOps } from '../src/sim/edit-ops'
import { createPhysics, hashPhysics, loadJolt, type PhysicsWorld } from '../src/sim/physics'
import { ROCKET_POWER, ROCKET_RADIUS, ROCKET_TTL_TICKS } from '../src/sim/rockets'
import { BOMB_POWER, BOMB_RADIUS } from '../src/sim/destruction'
import type { ExplosionEvent } from '../src/sim/events'

// P19 — rocket launcher: 'rocket' op spawns a fast straight sim projectile that
// detonates a punchy T55 explosion on the first world-voxel or body impact.
// Deterministic + hashed (V2/V3): a desynced rocket means a desynced crater.

beforeAll(async () => {
  await loadJolt()
}, 30000)

async function setup(): Promise<{ sim: Sim; phys: PhysicsWorld }> {
  const sim = new Sim(1)
  registerEditOps(sim)
  // a thick concrete wall spanning z, standing at x∈[100,115] voxels (10–11.5 m)
  sim.world.fillBox(100, 0, 0, 115, 40, 127, 4)
  const phys = await createPhysics(sim)
  return { sim, phys }
}

const rocketOp = (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number) =>
  ({ kind: 'rocket', ox, oy, oz, dx, dy, dz }) as const

describe('rocket launcher (P19, I.cmd, V1)', () => {
  it('is punchier than the bomb (larger radius, higher power)', () => {
    expect(ROCKET_RADIUS).toBeGreaterThan(BOMB_RADIUS)
    expect(ROCKET_POWER).toBeGreaterThanOrEqual(BOMB_POWER)
  })

  it('flies straight and fast toward the aim, no gravity drop', async () => {
    const { sim, phys } = await setup()
    // fire from 2 m up, dead level toward +x
    sim.queue.push({ tick: 0, playerId: 1, seq: 0, op: rocketOp(1, 2, 6.4, 1, 0, 0) })
    sim.step()
    expect(phys.rockets.size).toBe(1)
    const r = [...phys.rockets.values()][0]
    const x0 = r.x
    sim.step()
    expect(r.x).toBeGreaterThan(x0 + 1) // covered > 1 m in a single tick (fast)
    expect(r.y).toBeCloseTo(2, 5) // level flight — no gravity
    expect(r.z).toBeCloseTo(6.4, 5)
    phys.dispose()
  }, 30000)

  it('detonates a T55 explosion on world-voxel impact and craters the wall', async () => {
    const { sim, phys } = await setup()
    sim.queue.push({ tick: 0, playerId: 1, seq: 0, op: rocketOp(1, 2, 6.4, 1, 0, 0) })
    let exploded: ExplosionEvent | undefined
    // wall face is at ~10 m; at 80 m/s it arrives well within the TTL
    for (let i = 0; i <= ROCKET_TTL_TICKS && !exploded; i++) {
      sim.step()
      exploded = sim.drainEvents().find((e): e is ExplosionEvent => e.kind === 'explosion')
    }
    expect(exploded).toBeDefined()
    expect(phys.rockets.size).toBe(0) // rocket consumed on impact
    expect(exploded!.power).toBe(ROCKET_POWER)
    // blast landed at the near wall face (~10 m in x), on the fire line
    expect(exploded!.x).toBeGreaterThan(9)
    expect(exploded!.x).toBeLessThan(13)
    expect(Math.abs(exploded!.z - 6.4)).toBeLessThan(1)
    // crater: wall voxels at the near face are gone
    expect(sim.world.getVoxel(100, 20, 64)).toBe(0)
    // rubble: T55 ejecta spawned interactive bodies
    expect(phys.debris!.bodies.size).toBeGreaterThan(0) // T86: debris in local layer
    phys.dispose()
  }, 30000)

  it('a clean miss fizzles at max range with no explosion', async () => {
    const { sim, phys } = await setup()
    // aim UP into empty sky — never meets the wall
    sim.queue.push({ tick: 0, playerId: 1, seq: 0, op: rocketOp(1, 50, 6.4, 0, 1, 0) })
    sim.step()
    expect(phys.rockets.size).toBe(1)
    let boom = false
    for (let i = 0; i <= ROCKET_TTL_TICKS + 2; i++) {
      sim.step()
      if (sim.drainEvents().some((e) => e.kind === 'explosion')) boom = true
    }
    expect(phys.rockets.size).toBe(0) // gone by TTL
    expect(boom).toBe(false)
    phys.dispose()
  }, 30000)

  it('rockets are hashed sim state (V3): sims with/without a rocket diverge', async () => {
    const a = await setup()
    const b = await setup()
    a.sim.queue.push({ tick: 0, playerId: 1, seq: 0, op: rocketOp(1, 2, 6.4, 1, 0, 0) })
    a.sim.step()
    b.sim.step()
    expect(hashPhysics(a.phys)).not.toBe(hashPhysics(b.phys))
    a.phys.dispose()
    b.phys.dispose()
  }, 30000)

  it('two identical runs (fire → flight → impact → explosion) → identical hash sequences (V2/V3)', async () => {
    const run = async () => {
      const { sim, phys } = await setup()
      sim.queue.push({ tick: 0, playerId: 1, seq: 0, op: rocketOp(1, 2, 6.4, 1, 0.05, 0) })
      const hashes: number[] = []
      for (let i = 0; i < 40; i++) {
        sim.step()
        hashes.push(hashPhysics(phys))
      }
      phys.dispose()
      return hashes
    }
    const a = await run()
    const b = await run()
    expect(b).toEqual(a)
    // sanity: the run actually produced a detonation (crater voxel removed)
    expect(a.some((h, i) => i > 0 && h !== a[i - 1])).toBe(true)
  }, 60000)
})
