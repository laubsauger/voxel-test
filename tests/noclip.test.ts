import { beforeAll, describe, expect, it } from 'vitest'
import { Sim } from '../src/sim/loop'
import { registerEditOps } from '../src/sim/edit-ops'
import { createPhysics, hashPhysics, loadJolt, type PhysicsWorld } from '../src/sim/physics'
import { INPUT_BACK, INPUT_FWD, INPUT_JUMP } from '../src/sim/player'

// T47 — noclip dev mode: command-toggled fly with no collision, fully inside
// the deterministic tick (works in lockstep). Toggle off resumes the normal
// character controller at the flown position.

beforeAll(async () => {
  await loadJolt()
}, 30000)

async function makeSim(): Promise<{ sim: Sim; phys: PhysicsWorld }> {
  const sim = new Sim(9)
  registerEditOps(sim)
  sim.world.fillBox(912, 0, 912, 1152, 7, 1152, 3) // ground, top y=0.8m
  // solid wall across the walking path: z 99.2..99.7m, floor to 3.1m
  sim.world.fillBox(1012, 8, 992, 1056, 30, 996, 4)
  const phys = await createPhysics(sim)
  return { sim, phys }
}

function pushMoves(sim: Sim, from: number, count: number, input: number): number {
  for (let t = from; t < from + count; t++) {
    sim.queue.push({ tick: t, playerId: 1, seq: t * 2, op: { kind: 'move', input, yaw: 0, pitch: 0 } })
  }
  return from + count
}

describe('noclip (T47, I.cmd, V1, V2)', () => {
  it('walking is wall-blocked; noclip flies through; toggle off restores collision', async () => {
    const { sim, phys } = await makeSim()
    sim.queue.push({ tick: 0, playerId: 1, seq: 0, op: { kind: 'spawn' } })
    // 1) normal walk into the wall: blocked at ~99.7+0.3
    let t = pushMoves(sim, 1, 120, INPUT_FWD)
    while (sim.tick < t) sim.step()
    const p = phys.players.get(1)!
    expect(p.pz).toBeGreaterThan(99.8) // never crossed the wall
    expect(p.noclip).toBe(false)

    // 2) toggle noclip, fly forward through the wall (10 m/s × 1s = 10m)
    sim.queue.push({ tick: t, playerId: 1, seq: t * 2 + 1, op: { kind: 'noclip' } })
    t = pushMoves(sim, t, 60, INPUT_FWD)
    while (sim.tick < t) sim.step()
    expect(p.noclip).toBe(true)
    expect(p.pz).toBeLessThan(99.1) // through the wall
    const flownY = p.py
    expect(flownY).toBeCloseTo(0.81, 1) // level flight, no gravity in noclip

    // 3) toggle off in the open beyond the wall: collision + gravity resume
    sim.queue.push({ tick: t, playerId: 1, seq: t * 2 + 1, op: { kind: 'noclip' } })
    t = pushMoves(sim, t, 120, INPUT_BACK) // walk back toward the wall
    while (sim.tick < t) sim.step()
    expect(p.noclip).toBe(false)
    expect(p.pz).toBeLessThan(99.1) // wall blocks from this side too (99.2 − 0.3)
    expect(p.py).toBeCloseTo(0.8, 1) // standing on the ground again
    phys.dispose()
  }, 30000)

  it('jump bit flies up, no ceiling can stop it', async () => {
    const { sim, phys } = await makeSim()
    sim.queue.push({ tick: 0, playerId: 1, seq: 0, op: { kind: 'spawn' } })
    sim.queue.push({ tick: 1, playerId: 1, seq: 2, op: { kind: 'noclip' } })
    const t = pushMoves(sim, 2, 60, INPUT_JUMP)
    while (sim.tick < t) sim.step()
    const p = phys.players.get(1)!
    expect(p.py).toBeGreaterThan(0.8 + 8) // ~10m/s straight up for ~1s
    phys.dispose()
  }, 30000)

  it('noclip flight is deterministic and hash-visible (V2/V3)', async () => {
    const run = async () => {
      const { sim, phys } = await makeSim()
      sim.queue.push({ tick: 0, playerId: 1, seq: 0, op: { kind: 'spawn' } })
      sim.queue.push({ tick: 5, playerId: 1, seq: 11, op: { kind: 'noclip' } })
      const t = pushMoves(sim, 6, 40, INPUT_FWD | INPUT_JUMP)
      const hashes: number[] = []
      while (sim.tick < t) {
        sim.step()
        hashes.push(hashPhysics(phys))
      }
      // white-box: the noclip flag itself must be part of the hash
      const p = phys.players.get(1)!
      const h0 = hashPhysics(phys)
      p.noclip = !p.noclip
      expect(hashPhysics(phys)).not.toBe(h0)
      p.noclip = !p.noclip
      phys.dispose()
      return hashes
    }
    const a = await run()
    const b = await run()
    expect(b).toEqual(a)
  }, 30000)
})
