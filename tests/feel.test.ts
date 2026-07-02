import { beforeAll, describe, expect, it } from 'vitest'
import { Sim } from '../src/sim/loop'
import { registerEditOps } from '../src/sim/edit-ops'
import {
  KILL_PLANE_Y,
  MAX_BODY_ANGULAR_VELOCITY,
  MAX_BODY_LINEAR_VELOCITY,
  createPhysics,
  hashPhysics,
  loadJolt,
  materialFeel,
  type PhysicsWorld,
} from '../src/sim/physics'
import { MAT_CONCRETE, MAT_METAL, MAT_WOOD } from '../src/sim/materials'

// T40 — destruction physics FEEL. Materials must read as their weight under
// the same blast (impulse-based response: Jolt divides by mass), debris must
// never fly off to infinity (velocity caps), fall out of the world silently
// (kill plane removes + hashes), or jitter forever (sleep).

beforeAll(async () => {
  await loadJolt()
}, 30000)

/** ground slab + physics; blob is stamped AFTER createPhysics so the next
 *  structural pass extracts it as an island (it floats unsupported) */
async function setupWithIsland(mat: number): Promise<{ sim: Sim; phys: PhysicsWorld }> {
  const sim = new Sim(1)
  registerEditOps(sim)
  sim.world.fillBox(0, 0, 0, 127, 7, 127, 3)
  const phys = await createPhysics(sim)
  // 4×4×4 blob floating at y 40..43 — same size for every material
  sim.world.fillBox(60, 40, 60, 63, 43, 63, mat)
  sim.step() // structural pass extracts the island
  expect(phys.bodies.size).toBe(1)
  return { sim, phys }
}

/** horizontal speed of the island right after an explode next to it */
async function blastSpeed(mat: number): Promise<number> {
  const { sim, phys } = await setupWithIsland(mat)
  const body = [...phys.bodies.values()][0]
  expect(body.mat).toBe(mat)
  // blast 3m to the -x side, power 2: outside destruction reach of the blob
  // (island center dist ~30 voxels > r 8) but inside impulse reach (r×2 = 16
  // voxels… so bring it closer: 12 voxels away → inside 16)
  sim.queue.push({
    tick: sim.tick,
    playerId: 1,
    seq: 0,
    op: { kind: 'explode', x: 50, y: 42, z: 62, r: 8, power: 2 },
  })
  sim.step()
  const v = body.body.GetLinearVelocity()
  const speed = Math.sqrt(v.GetX() * v.GetX() + v.GetZ() * v.GetZ())
  phys.dispose()
  return speed
}

describe('density-true impulse response (T40.1)', () => {
  it('same blast: wood island launches ≥3.5× faster than concrete', async () => {
    const wood = await blastSpeed(MAT_WOOD)
    const concrete = await blastSpeed(MAT_CONCRETE)
    expect(wood).toBeGreaterThan(0.05) // wood actually moves
    expect(concrete).toBeGreaterThan(0) // concrete shifts, barely
    // wood 600 kg/m³ vs concrete 2400: same impulse / 4× mass ⇒ ~4× velocity
    expect(wood / concrete).toBeGreaterThanOrEqual(3.5)
  }, 30000)
})

describe('per-material friction/restitution (T40.2)', () => {
  it('island bodies get feel params from their dominant material', async () => {
    const { phys } = await setupWithIsland(MAT_METAL)
    const body = [...phys.bodies.values()][0]
    expect(body.mat).toBe(MAT_METAL)
    expect(body.body.GetFriction()).toBeCloseTo(materialFeel(MAT_METAL).friction, 6)
    expect(body.body.GetRestitution()).toBeCloseTo(materialFeel(MAT_METAL).restitution, 6)
    phys.dispose()
  }, 30000)

  it('feel table: metal slides+clangs, masonry grips+thuds, wood in between', () => {
    expect(materialFeel(MAT_METAL).friction).toBeLessThan(materialFeel(MAT_WOOD).friction)
    expect(materialFeel(MAT_WOOD).friction).toBeLessThan(materialFeel(MAT_CONCRETE).friction)
    expect(materialFeel(MAT_METAL).restitution).toBeGreaterThan(materialFeel(MAT_CONCRETE).restitution)
    expect(materialFeel(MAT_CONCRETE).restitution).toBeLessThan(0.1)
  })
})

describe('velocity clamps (T40.3)', () => {
  it('absurd explode power → speed capped, no NaN', async () => {
    const { sim, phys } = await setupWithIsland(MAT_WOOD)
    const body = [...phys.bodies.values()][0]
    sim.queue.push({
      tick: sim.tick,
      playerId: 1,
      seq: 0,
      op: { kind: 'explode', x: 50, y: 42, z: 62, r: 8, power: 1e9 },
    })
    for (let i = 0; i < 5; i++) sim.step()
    const v = body.body.GetLinearVelocity()
    const speed = Math.sqrt(v.GetX() ** 2 + v.GetY() ** 2 + v.GetZ() ** 2)
    expect(Number.isFinite(speed)).toBe(true)
    // small tolerance: gravity may add up to g·DT between clamp and readback
    expect(speed).toBeLessThanOrEqual(MAX_BODY_LINEAR_VELOCITY + 0.5)
    const av = body.body.GetAngularVelocity()
    const spin = Math.sqrt(av.GetX() ** 2 + av.GetY() ** 2 + av.GetZ() ** 2)
    expect(spin).toBeLessThanOrEqual(MAX_BODY_ANGULAR_VELOCITY + 1e-6)
    expect(Number.isFinite(body.px + body.py + body.pz)).toBe(true)
    phys.dispose()
  }, 30000)
})

describe('kill plane (T40.4)', () => {
  it('bodies falling below the kill plane are removed, deterministically', async () => {
    const run = async () => {
      const sim = new Sim(1)
      registerEditOps(sim)
      // small ground patch far from the blob: the island falls into the void
      sim.world.fillBox(0, 0, 0, 31, 7, 31, 3)
      const phys = await createPhysics(sim)
      sim.world.fillBox(200, 30, 200, 203, 33, 203, MAT_WOOD)
      sim.step()
      expect(phys.bodies.size).toBe(1)
      const hashes: number[] = []
      // 3m fall to y=0 then to -10: √(2·13/9.81) ≈ 1.63s → 120 ticks is plenty
      for (let i = 0; i < 150; i++) {
        sim.step()
        hashes.push(hashPhysics(phys))
      }
      const out = { size: phys.bodies.size, removed: phys.removedBodies, hashes }
      phys.dispose()
      return out
    }
    const a = await run()
    expect(a.size).toBe(0)
    expect(a.removed).toBe(1)
    const b = await run()
    expect(b.hashes).toEqual(a.hashes)
    expect(KILL_PLANE_Y).toBe(-10)
  }, 30000)
})

describe('sleep tuning (T40.5, V12)', () => {
  it('a dropped island settles, sleeps, and its transform freezes (stays dynamic)', async () => {
    const { sim, phys } = await setupWithIsland(MAT_CONCRETE)
    const body = [...phys.bodies.values()][0]
    // 3.2m drop + settle: give it 5 simulated seconds to fall asleep
    let sleptAt = -1
    for (let i = 0; i < 300; i++) {
      sim.step()
      if (!body.body.IsActive()) {
        sleptAt = i
        break
      }
    }
    expect(sleptAt).toBeGreaterThanOrEqual(0) // it DID sleep within 300 ticks
    // transform frozen while asleep…
    const frozen = [body.px, body.py, body.pz, body.qx, body.qy, body.qz, body.qw]
    for (let i = 0; i < 30; i++) sim.step()
    expect([body.px, body.py, body.pz, body.qx, body.qy, body.qz, body.qw]).toEqual(frozen)
    // …but the body is still dynamic (V12: sleep allowed, no re-weld/staticization)
    expect(phys.bodies.size).toBe(1)
    const api = phys.api
    expect(body.body.GetMotionType()).toBe(api.EMotionType_Dynamic)
    phys.dispose()
  }, 30000)
})
