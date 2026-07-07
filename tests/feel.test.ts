import type { B3Body } from 'box3d-wasm/standard'
import { beforeAll, describe, expect, it } from 'vitest'
import { Sim } from '../src/sim/loop'
import { registerEditOps } from '../src/sim/edit-ops'
import {
  KILL_PLANE_Y,
  createPhysics,
  hashPhysics,
  loadJolt,
  materialFeel,
  type PhysicsWorld,
} from '../src/sim/physics'
import { MAT_CONCRETE, MAT_METAL, MAT_WOOD } from '../src/sim/materials'

// T40 (ported to T86/V17) — destruction physics FEEL. Voxel debris now lives
// in the LOCAL Box3D layer (phys.debris, src/sim/debris.ts), not in the Jolt
// phys.bodies map. Materials must still read as their weight under the same
// blast (impulse / mass), debris must never fly off to infinity (layer clamps
// 28 m/s / 14 rad/s each tick), must fall out of the world silently (layer
// kill plane), and must not jitter forever — V17 supersedes V12: settled
// debris FREEZES (flips static, id in phys.debris.frozen) instead of merely
// sleeping.

beforeAll(async () => {
  await loadJolt()
}, 30000)

// debris.ts velocity clamps (MAX_LIN=28, MAX_ANG=14) are module-private —
// assert against them with a little headroom.
const DEBRIS_MAX_LIN = 28
const DEBRIS_MAX_ANG = 14

/** ground slab + physics; blob is stamped AFTER createPhysics so the next
 *  structural pass extracts it as an island (it floats unsupported).
 *  T86: the island spawns into the LOCAL debris layer, not phys.bodies. */
async function setupWithIsland(mat: number): Promise<{ sim: Sim; phys: PhysicsWorld }> {
  const sim = new Sim(1)
  registerEditOps(sim)
  sim.world.fillBox(0, 0, 0, 127, 7, 127, 3)
  const phys = await createPhysics(sim)
  // 4×4×4 blob floating at y 40..43 — same size for every material
  sim.world.fillBox(60, 40, 60, 63, 43, 63, mat)
  sim.step() // structural pass extracts the island
  expect(phys.bodies.size).toBe(0) // V17: Jolt map holds only vehicle wrecks
  expect(phys.debris!.bodies.size).toBe(1)
  return { sim, phys }
}

/** horizontal speed of the island right after an explode next to it */
async function blastSpeed(mat: number): Promise<number> {
  const { sim, phys } = await setupWithIsland(mat)
  const body = [...phys.debris!.bodies.values()][0]
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
  // read velocity right after the explode tick (later ticks add damping)
  const v = (body.body as B3Body).getLinearVelocity()
  const speed = Math.sqrt(v.x * v.x + v.z * v.z)
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
  it('island bodies carry the dominant material the layer feels with', async () => {
    const { phys } = await setupWithIsland(MAT_METAL)
    const body = [...phys.debris!.bodies.values()][0]
    expect(body.mat).toBe(MAT_METAL)
    // T86 port note: box3d-wasm exposes NO friction/restitution getters, so the
    // old body.GetFriction()/GetRestitution() readback cannot be ported 1:1.
    // Structural check instead: the layer applies materialFeel(body.mat) to the
    // hull shape at spawn (debris.ts attachHull), so assert the feel values it
    // WOULD apply for this body's dominant material are the canonical table
    // entries (metal: slick + clangy).
    const feel = materialFeel(body.mat)
    expect(feel.friction).toBeCloseTo(0.25, 6)
    expect(feel.restitution).toBeCloseTo(0.3, 6)
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
    const body = [...phys.debris!.bodies.values()][0]
    sim.queue.push({
      tick: sim.tick,
      playerId: 1,
      seq: 0,
      op: { kind: 'explode', x: 50, y: 42, z: 62, r: 8, power: 1e9 },
    })
    for (let i = 0; i < 5; i++) sim.step()
    // T86: caps live in the debris layer (hard clamp 28 m/s / 14 rad/s applied
    // every layer step) — assert ≤ 30 with headroom, not the old Jolt cap of 60
    const v = (body.body as B3Body).getLinearVelocity()
    const speed = Math.sqrt(v.x ** 2 + v.y ** 2 + v.z ** 2)
    expect(Number.isFinite(speed)).toBe(true)
    expect(speed).toBeLessThanOrEqual(DEBRIS_MAX_LIN + 2)
    const av = (body.body as B3Body).getAngularVelocity()
    const spin = Math.sqrt(av.x ** 2 + av.y ** 2 + av.z ** 2)
    expect(spin).toBeLessThanOrEqual(DEBRIS_MAX_ANG + 1e-6)
    expect(Number.isFinite(body.px + body.py + body.pz)).toBe(true)
    phys.dispose()
  }, 30000)
})

describe('kill plane (T40.4)', () => {
  it('debris falling below the kill plane is removed; world hashes stay deterministic', async () => {
    const run = async () => {
      const sim = new Sim(1)
      registerEditOps(sim)
      // small ground patch far from the blob: the island falls into the void
      sim.world.fillBox(0, 0, 0, 31, 7, 31, 3)
      const phys = await createPhysics(sim)
      sim.world.fillBox(200, 30, 200, 203, 33, 203, MAT_WOOD)
      sim.step()
      expect(phys.debris!.bodies.size).toBe(1)
      const hashes: number[] = []
      // 3m fall to y=0 then to -10: √(2·13/9.81) ≈ 1.63s → 120 ticks is plenty
      for (let i = 0; i < 150; i++) {
        sim.step()
        hashes.push(hashPhysics(phys))
      }
      const out = { size: phys.debris!.bodies.size, hashes }
      phys.dispose()
      return out
    }
    const a = await run()
    expect(a.size).toBe(0)
    // T86 port note: phys.removedBodies no longer counts debris kill-plane
    // removals (layer-local despawn, excluded from hashes) — the old
    // `removed === 1` assertion is dropped; the size check above covers intent.
    const b = await run()
    expect(b.hashes).toEqual(a.hashes) // debris excluded from hash → still equal
    expect(KILL_PLANE_Y).toBe(-10) // layer uses the same -10 internally
  }, 30000)
})

describe('freeze on settle (T40.5, V17 supersedes V12)', () => {
  it('a dropped island settles, freezes static, and its transform stops changing', async () => {
    const { sim, phys } = await setupWithIsland(MAT_CONCRETE)
    const debris = phys.debris!
    const body = [...debris.bodies.values()][0]
    // 3.2m drop + settle + FREEZE_TICKS(55) rest accrual — 900 ticks (15s) is generous
    let frozeAt = -1
    for (let i = 0; i < 900; i++) {
      sim.step()
      if (debris.frozen.has(body.id)) {
        frozeAt = i
        break
      }
    }
    expect(frozeAt).toBeGreaterThanOrEqual(0) // it DID freeze
    // V17: frozen debris stays a BODY (static, batched render) — no re-weld,
    // no despawn — and its mirrored transform stops changing entirely.
    const frozen = [body.px, body.py, body.pz, body.qx, body.qy, body.qz, body.qw]
    for (let i = 0; i < 30; i++) sim.step()
    expect([body.px, body.py, body.pz, body.qx, body.qy, body.qz, body.qw]).toEqual(frozen)
    expect(debris.bodies.size).toBe(1)
    expect(debris.frozen.has(body.id)).toBe(true)
    expect(debris.activeCount).toBe(0)
    phys.dispose()
  }, 30000)
})
