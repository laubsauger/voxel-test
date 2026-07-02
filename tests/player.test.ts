import { beforeAll, describe, expect, it } from 'vitest'
import { Sim } from '../src/sim/loop'
import { registerEditOps } from '../src/sim/edit-ops'
import { createPhysics, hashPhysics, loadJolt } from '../src/sim/physics'
import { INPUT_FWD, INPUT_JUMP } from '../src/sim/player'
import type { Command } from '../src/sim/commands'

// T21 — character controller determinism: two sims fed the same move
// commands must land on bit-identical player positions, or lockstep co-op
// desyncs the moment someone walks (V2, V3).

beforeAll(async () => {
  await loadJolt()
}, 30000)

async function makeSim() {
  const sim = new Sim(9)
  registerEditOps(sim)
  // ground around the spawn column (spawn is at 51.2m + playerId → voxel ~512)
  sim.world.fillBox(400, 0, 400, 640, 7, 640, 3)
  const phys = await createPhysics(sim)
  return { sim, phys }
}

function moveCmds(ticks: number, input: number, yaw: number): Command[] {
  const cmds: Command[] = [{ tick: 0, playerId: 1, seq: 0, op: { kind: 'spawn' } }]
  for (let t = 1; t <= ticks; t++) {
    cmds.push({ tick: t, playerId: 1, seq: t, op: { kind: 'move', input, yaw, pitch: 0 } })
  }
  return cmds
}

describe('player character controller (T21, I.jolt, V1, V2)', () => {
  it('two sims, same inputs → same position bits and physics hash', async () => {
    const run = async () => {
      const { sim, phys } = await makeSim()
      for (const c of moveCmds(60, INPUT_FWD, 0.7)) sim.queue.push(c)
      const hashes: number[] = []
      for (let t = 0; t <= 60; t++) {
        sim.step()
        hashes.push(hashPhysics(phys))
      }
      const p = phys.players.get(1)!
      const out = { pos: [p.px, p.py, p.pz], hashes }
      phys.dispose()
      return out
    }
    const a = await run()
    const b = await run()
    expect(Object.is(a.pos[0], b.pos[0])).toBe(true) // exact f64 bits
    expect(Object.is(a.pos[1], b.pos[1])).toBe(true)
    expect(Object.is(a.pos[2], b.pos[2])).toBe(true)
    expect(b.hashes).toEqual(a.hashes)
  }, 30000)

  it('move commands actually move the player (walk forward, yaw 0 → -z)', async () => {
    const { sim, phys } = await makeSim()
    for (const c of moveCmds(60, INPUT_FWD, 0)) sim.queue.push(c)
    for (let t = 0; t <= 60; t++) sim.step()
    const p = phys.players.get(1)!
    expect(p.pz).toBeLessThan(51.2 - 1) // walked at least 1m in -z
    expect(Math.abs(p.px - 52.2)).toBeLessThan(0.01) // playerId 1 spawns at x=52.2, no drift
    expect(p.py).toBeCloseTo(0.8, 1) // standing on ground (slab top at y=0.8m)
    phys.dispose()
  }, 30000)

  it('jump lifts the player off the ground', async () => {
    const { sim, phys } = await makeSim()
    sim.queue.push({ tick: 0, playerId: 1, seq: 0, op: { kind: 'spawn' } })
    for (let t = 0; t < 20; t++) sim.step() // settle onto the ground
    const p = phys.players.get(1)!
    const restY = p.py
    sim.queue.push({ tick: sim.tick, playerId: 1, seq: 1, op: { kind: 'move', input: INPUT_JUMP, yaw: 0, pitch: 0 } })
    for (let t = 0; t < 10; t++) sim.step()
    expect(p.py).toBeGreaterThan(restY + 0.2)
    phys.dispose()
  }, 30000)

  it('move before spawn fails loud (V10)', async () => {
    const { sim, phys } = await makeSim()
    sim.queue.push({ tick: 0, playerId: 2, seq: 0, op: { kind: 'move', input: INPUT_FWD, yaw: 0, pitch: 0 } })
    expect(() => sim.step()).toThrow(/unspawned/)
    phys.dispose()
  }, 30000)

  it('spawn allocates entity id from the sim counter (V8)', async () => {
    const { sim, phys } = await makeSim()
    const before = sim.nextEntityId
    sim.queue.push({ tick: 0, playerId: 1, seq: 0, op: { kind: 'spawn' } })
    sim.queue.push({ tick: 0, playerId: 2, seq: 0, op: { kind: 'spawn' } })
    sim.step()
    expect(phys.players.get(1)!.id).toBe(before)
    expect(phys.players.get(2)!.id).toBe(before + 1)
    phys.dispose()
  }, 30000)
})
