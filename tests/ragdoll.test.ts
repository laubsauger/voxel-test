import { beforeAll, describe, expect, it } from 'vitest'
import { Sim } from '../src/sim/loop'
import { registerEditOps } from '../src/sim/edit-ops'
import { createPhysics, hashPhysics, loadJolt, type PhysicsWorld } from '../src/sim/physics'
import { registerShootOp } from '../src/sim/shoot-op'
import { type PlayerEntity } from '../src/sim/player'
import { WORLD_VX, VOXEL_SIZE } from '../src/world/chunks'

// T77 — death ragdolls. Why these tests exist: the corpse is 6 constrained
// Jolt bodies in the SHARED deterministic physics world (V2), so its part
// transforms are lockstep sim state — they MUST be hashed (V3), spawn on
// death only, carry the killing impulse (rocket flings, gun crumples) and
// despawn exactly at the victim's respawn tick with no leaked bodies. A
// regression in any of these silently desyncs MP or leaks Jolt bodies.

beforeAll(async () => {
  await loadJolt()
}, 30000)

// B32 — spawn column is the world center; playerId N spawns at x = CM + N (m)
const CVX = WORLD_VX >> 1
const CM = CVX * VOXEL_SIZE

async function setup(): Promise<{ sim: Sim; phys: PhysicsWorld }> {
  const sim = new Sim(7)
  registerEditOps(sim)
  // ground slab around the spawn columns (same shape as player-combat.test.ts)
  sim.world.fillBox(CVX - 112, 0, CVX - 112, CVX + 128, 7, CVX + 128, 3)
  const phys = await createPhysics(sim)
  registerShootOp(sim, phys)
  return { sim, phys }
}

/** spawn players 1 + 2 and settle them onto the ground */
async function setupDuel(): Promise<{ sim: Sim; phys: PhysicsWorld; p1: PlayerEntity; p2: PlayerEntity }> {
  const { sim, phys } = await setup()
  sim.queue.push({ tick: 0, playerId: 1, seq: 0, op: { kind: 'spawn' } })
  sim.queue.push({ tick: 0, playerId: 2, seq: 0, op: { kind: 'spawn' } })
  for (let t = 0; t < 20; t++) sim.step()
  sim.drainEvents()
  return { sim, phys, p1: phys.players.get(1)!, p2: phys.players.get(2)! }
}

/** shoot from p1 straight +x at chest height (p2 stands 1 m away in +x) */
function shootAt(sim: Sim, from: PlayerEntity, seq: number): void {
  sim.queue.push({
    tick: sim.tick,
    playerId: from.playerId,
    seq,
    op: { kind: 'shoot', ox: from.px, oy: from.py + 1.2, oz: from.pz, dx: 1, dy: 0, dz: 0 },
  })
}

/** machine-gun p2 to death (gun-kill path) */
function killP2(sim: Sim, p1: PlayerEntity, p2: PlayerEntity): void {
  let seq = 100
  while (p2.alive) {
    shootAt(sim, p1, seq++)
    sim.step()
    if (seq > 120) throw new Error('victim never died — damage path broken')
  }
}

/** p1 detonates a rocket-grade blast (ROCKET_POWER 12) 2 voxels from p2 —
 *  lethal at that range (floor(144·(1−2/18)) = 128 hp) with a non-degenerate
 *  horizontal launch direction (explosion-kill path) */
function bombP2(sim: Sim, p2: PlayerEntity): void {
  sim.queue.push({
    tick: sim.tick,
    playerId: 1,
    seq: 0,
    op: {
      kind: 'explode',
      x: p2.px / VOXEL_SIZE + 2,
      y: (p2.py + 0.8) / VOXEL_SIZE,
      z: p2.pz / VOXEL_SIZE,
      r: 18,
      power: 12,
    },
  })
  sim.step()
}

describe('death ragdoll spawn (T77, V2/V8)', () => {
  it('a kill spawns exactly one 6-part ragdoll for the victim; parts move over ticks (gravity + launch)', async () => {
    const { sim, phys, p1, p2 } = await setupDuel()
    expect(phys.ragdolls.size).toBe(0)
    killP2(sim, p1, p2)

    expect(phys.ragdolls.size).toBe(1)
    const r = [...phys.ragdolls.values()][0]
    expect(r.parts.length).toBe(6)
    expect(r.playerId).toBe(2)
    // deterministic lifetime contract: despawn tick == the victim's respawn tick
    expect(r.despawnAtTick).toBe(p2.respawnAtTick)
    // parts spawned at the corpse, near the victim
    for (const p of r.parts) {
      expect(Math.hypot(p.px - p2.px, p.pz - p2.pz)).toBeLessThan(1.5)
    }

    // the ragdoll is DYNAMIC: under gravity + the killing impulse the part
    // transforms change over the following ticks (a frozen pose would not)
    const before = r.parts.map((p) => [p.px, p.py, p.pz, p.qx, p.qy, p.qz, p.qw])
    for (let i = 0; i < 30; i++) sim.step()
    const after = r.parts.map((p) => [p.px, p.py, p.pz, p.qx, p.qy, p.qz, p.qw])
    expect(after).not.toEqual(before)
    for (const p of r.parts) expect(Number.isFinite(p.py)).toBe(true)
    phys.dispose()
  }, 30000)

  it('ragdoll transforms are hashed (V3): presence and any part transform change hashPhysics', async () => {
    const { sim, phys, p1, p2 } = await setupDuel()
    const h0 = hashPhysics(phys)
    killP2(sim, p1, p2)
    const h1 = hashPhysics(phys)
    expect(h1).not.toBe(h0) // ragdoll presence (+ combat state) is hashed

    const r = [...phys.ragdolls.values()][0]
    r.parts[1].px += 0.5 // mutate the torso transform directly
    expect(hashPhysics(phys)).not.toBe(h1)
    phys.dispose()
  }, 30000)
})

describe('death ragdoll lifetime (T77)', () => {
  it('despawns exactly at the respawn tick; the player respawns alive at the spawn column; no bodies left', async () => {
    const { sim, phys, p1, p2 } = await setupDuel()
    killP2(sim, p1, p2)
    const respawnAt = p2.respawnAtTick
    expect(respawnAt).toBeGreaterThan(sim.tick)

    // the corpse persists every tick up to (not including) the respawn tick
    while (sim.tick < respawnAt) {
      expect(phys.ragdolls.size).toBe(1)
      sim.step()
    }
    // the loop's last step ran tick respawnAt-1 — corpse still there;
    // the NEXT step runs tick == respawnAt: respawn + ragdoll despawn together
    expect(phys.ragdolls.size).toBe(1)
    expect(p2.alive).toBe(false)
    sim.step()
    expect(p2.alive).toBe(true)
    expect(phys.ragdolls.size).toBe(0)
    // respawned at the deterministic spawn column (playerId 2 → x = CM + 2)
    expect(p2.px).toBeCloseTo(CM + 2, 1)
    expect(p2.pz).toBeCloseTo(CM, 1)
    // no residue: further ticks run clean with zero ragdolls
    for (let i = 0; i < 10; i++) sim.step()
    expect(phys.ragdolls.size).toBe(0)
    phys.dispose()
  }, 30000)
})

describe('killing impulse (T77)', () => {
  it('an explosion kill flings the torso harder than a gun kill', async () => {
    // average torso speed over the 5 ticks after death, per kill kind
    const torsoSpeed = async (kind: 'gun' | 'boom'): Promise<number> => {
      const { sim, phys, p1, p2 } = await setupDuel()
      if (kind === 'gun') killP2(sim, p1, p2)
      else bombP2(sim, p2)
      expect(p2.alive).toBe(false)
      const torso = [...phys.ragdolls.values()][0].parts[1]
      const x0 = torso.px, y0 = torso.py, z0 = torso.pz
      const ticks = 5
      for (let i = 0; i < ticks; i++) sim.step()
      const d = Math.hypot(torso.px - x0, torso.py - y0, torso.pz - z0)
      phys.dispose()
      return d / (ticks / 60)
    }
    const gun = await torsoSpeed('gun')
    const boom = await torsoSpeed('boom')
    // rocket/bomb-grade blast (power 9 point-blank ≈ 10 m/s launch) must
    // clearly out-fling the gun crumple (2.5 m/s shove)
    expect(boom).toBeGreaterThan(gun * 1.5)
  }, 60000)
})

describe('determinism (T77, V2/V3)', () => {
  it('two identical runs with a ragdoll kill produce identical hashPhysics sequences over 120 ticks', async () => {
    const run = async (): Promise<number[]> => {
      const { sim, phys, p2 } = await setupDuel()
      bombP2(sim, p2) // explosion kill: constraints + launch + debris cascade
      expect(p2.alive).toBe(false)
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
  }, 60000)
})
