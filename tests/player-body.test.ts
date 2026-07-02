import { beforeAll, describe, expect, it } from 'vitest'
import { Sim } from '../src/sim/loop'
import { registerEditOps } from '../src/sim/edit-ops'
import { createPhysics, hashPhysics, loadJolt, type PhysicsWorld } from '../src/sim/physics'
import {
  damagePlayersSphere,
  FLAG_LOST_ARM_L,
  SEGMENT_DEFS,
  type PlayerEntity,
} from '../src/sim/player'
import { VOXEL_SIZE } from '../src/world/chunks'

// T22 — losing an arm must be sim truth, not a visual: segment voxels are
// hashed state (V3), and the lostX flags are what gameplay reacts to.

beforeAll(async () => {
  await loadJolt()
}, 30000)

async function makePlayer(): Promise<{ sim: Sim; phys: PhysicsWorld; p: PlayerEntity }> {
  const sim = new Sim(3)
  registerEditOps(sim)
  sim.world.fillBox(400, 0, 400, 640, 7, 640, 3)
  const phys = await createPhysics(sim)
  sim.queue.push({ tick: 0, playerId: 1, seq: 0, op: { kind: 'spawn' } })
  for (let i = 0; i < 20; i++) sim.step() // settle on the ground
  return { sim, phys, p: phys.players.get(1)! }
}

/** world-voxel center of a segment */
function segCenter(p: PlayerEntity, name: string): { x: number; y: number; z: number } {
  const def = SEGMENT_DEFS.find((d) => d.name === name)!
  const bx = Math.floor(p.px / VOXEL_SIZE)
  const by = Math.floor(p.py / VOXEL_SIZE)
  const bz = Math.floor(p.pz / VOXEL_SIZE)
  return {
    x: bx + def.ox + def.sx / 2,
    y: by + def.oy + def.sy / 2,
    z: bz + def.oz + def.sz / 2,
  }
}

describe('segmented voxel player body (T22)', () => {
  it('spawns with full segments and no lost-segment flags', async () => {
    const { phys, p } = await makePlayer()
    expect(p.segments.length).toBe(6)
    expect(p.flags).toBe(0)
    for (const seg of p.segments) {
      expect(seg.count).toBe(seg.def.sx * seg.def.sy * seg.def.sz)
      expect(seg.count).toBe(seg.initial)
    }
    phys.dispose()
  }, 30000)

  it('localized damage removes voxels from the hit segment only', async () => {
    const { phys, p } = await makePlayer()
    const c = segCenter(p, 'armL')
    // small blast at the arm: strong enough for flesh at close range only
    damagePlayersSphere(phys, c.x, c.y, c.z, 2, 4)
    const armL = p.segments.find((s) => s.def.name === 'armL')!
    const head = p.segments.find((s) => s.def.name === 'head')!
    const legR = p.segments.find((s) => s.def.name === 'legR')!
    expect(armL.count).toBeLessThan(armL.initial)
    expect(armL.version).toBeGreaterThan(0)
    expect(head.count).toBe(head.initial)
    expect(legR.count).toBe(legR.initial)
    phys.dispose()
  }, 30000)

  it('segment below threshold sets its status flag (lostLeftArm)', async () => {
    const { phys, p } = await makePlayer()
    const c = segCenter(p, 'armL')
    damagePlayersSphere(phys, c.x, c.y, c.z, 8, 100) // obliterate the arm
    const armL = p.segments.find((s) => s.def.name === 'armL')!
    expect(armL.count).toBe(0)
    expect(p.flags & FLAG_LOST_ARM_L).toBe(FLAG_LOST_ARM_L)
    phys.dispose()
  }, 30000)

  it('explode op near the player damages segments through the command path (V1)', async () => {
    const { sim, phys, p } = await makePlayer()
    const before = p.segments.reduce((n, s) => n + s.count, 0)
    const h0 = hashPhysics(phys)
    const bx = Math.floor(p.px / VOXEL_SIZE)
    const by = Math.floor(p.py / VOXEL_SIZE)
    const bz = Math.floor(p.pz / VOXEL_SIZE)
    sim.queue.push({
      tick: sim.tick,
      playerId: 1,
      seq: 1,
      op: { kind: 'explode', x: bx + 6, y: by + 10, z: bz, r: 8, power: 6 },
    })
    sim.step()
    const after = p.segments.reduce((n, s) => n + s.count, 0)
    expect(after).toBeLessThan(before)
    expect(hashPhysics(phys)).not.toBe(h0) // segment damage is hashed state (V3)
    phys.dispose()
  }, 30000)

  it('identical damage on identical players → identical segment state', async () => {
    const run = async () => {
      const { phys, p } = await makePlayer()
      const c = segCenter(p, 'torso')
      damagePlayersSphere(phys, c.x + 1, c.y, c.z - 1, 4, 5)
      const out = {
        counts: p.segments.map((s) => s.count),
        grids: p.segments.map((s) => [...s.grid]),
        flags: p.flags,
      }
      phys.dispose()
      return out
    }
    const a = await run()
    const b = await run()
    expect(b).toEqual(a)
  }, 30000)
})
