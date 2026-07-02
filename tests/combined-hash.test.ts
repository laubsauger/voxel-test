import { beforeAll, describe, expect, it } from 'vitest'
import { Sim } from '../src/sim/loop'
import { registerEditOps } from '../src/sim/edit-ops'
import { createPhysics, loadJolt } from '../src/sim/physics'
import { attachWaterSim } from '../src/sim/water/water-sim'
import { combinedHash } from '../src/net/combined-hash'
import type { Command } from '../src/sim/commands'

// T71 (V3, V10) — the desync detector hashes THIS combined value every 30
// ticks. WHY these tests matter: if the combined hash missed physics or water
// state, two peers could diverge in those systems and the detector would stay
// green — silent desync, the exact failure V10 bans. So: the hash must be
// (a) stable across identical runs and (b) sensitive to each subsystem.

beforeAll(async () => {
  await loadJolt()
}, 30000)

async function makeGameSim(seed: number) {
  const sim = new Sim(seed)
  registerEditOps(sim)
  sim.world.fillBox(0, 0, 0, 63, 7, 63, 3)
  const water = attachWaterSim(sim)
  sim.world.onVoxelChanged = (x, y, z) => water.notifyVoxelChanged(x, y, z)
  const phys = await createPhysics(sim)
  return { sim, phys, water }
}

const log: Command[] = [
  { tick: 1, playerId: 1, seq: 0, op: { kind: 'dig', x: 20, y: 7, z: 20, r: 4 } },
  { tick: 3, playerId: 1, seq: 1, op: { kind: 'place', x: 40, y: 10, z: 40, r: 3, mat: 5 } },
  { tick: 6, playerId: 1, seq: 2, op: { kind: 'explode', x: 40.5, y: 8.5, z: 40.5, r: 5, power: 3 } },
]

describe('combined desync hash (T71, V3)', () => {
  it('identical command logs ⇒ identical combined hash sequence', async () => {
    const runs = []
    for (let r = 0; r < 2; r++) {
      const { sim, phys, water } = await makeGameSim(7)
      for (const c of log) sim.queue.push(c)
      const hashes: number[] = []
      for (let i = 0; i < 15; i++) {
        sim.step()
        hashes.push(combinedHash(sim, phys, water))
      }
      phys.dispose()
      runs.push(hashes)
    }
    expect(runs[1]).toEqual(runs[0])
  }, 30000)

  it('is sensitive to water state, not just chunks (silent water desync = V10 violation)', async () => {
    const a = await makeGameSim(7)
    const b = await makeGameSim(7)
    for (let i = 0; i < 3; i++) {
      a.sim.step()
      b.sim.step()
    }
    expect(combinedHash(b.sim, b.phys, b.water)).toBe(combinedHash(a.sim, a.phys, a.water))
    // diverge ONLY the water field on b (no chunk/physics change)
    b.water.addWater(30, 9, 30, 200)
    expect(combinedHash(b.sim, b.phys, b.water)).not.toBe(combinedHash(a.sim, a.phys, a.water))
    a.phys.dispose()
    b.phys.dispose()
  }, 30000)

  it('is sensitive to physics body state (spawned island on one peer only)', async () => {
    const a = await makeGameSim(9)
    const b = await makeGameSim(9)
    // same edits on both, but b explodes → dynamic island bodies only on b
    const edit: Command = { tick: 0, playerId: 1, seq: 0, op: { kind: 'place', x: 40, y: 10, z: 40, r: 3, mat: 5 } }
    a.sim.queue.push(edit)
    b.sim.queue.push(edit)
    b.sim.queue.push({ tick: 2, playerId: 1, seq: 1, op: { kind: 'explode', x: 40.5, y: 8.5, z: 40.5, r: 5, power: 3 } })
    for (let i = 0; i < 6; i++) {
      a.sim.step()
      b.sim.step()
    }
    expect(combinedHash(b.sim, b.phys, b.water)).not.toBe(combinedHash(a.sim, a.phys, a.water))
    a.phys.dispose()
    b.phys.dispose()
  }, 30000)
})
