import { describe, expect, it } from 'vitest'
import { Sim } from '../src/sim/loop'
import { hashSim } from '../src/sim/hash'
import { registerEditOps } from '../src/sim/edit-ops'
import type { Command } from '../src/sim/commands'

// V3: same seed + same command log ⇒ identical hash sequence.
// This is the determinism contract lockstep multiplayer stands on —
// if this test breaks, co-op desyncs.

function makeSim(seed: number): Sim {
  const sim = new Sim(seed)
  registerEditOps(sim)
  sim.world.fillBox(0, 0, 0, 1023, 63, 1023, 2) // ground slab
  return sim
}

const log: Command[] = [
  { tick: 1, playerId: 1, seq: 0, op: { kind: 'dig', x: 100, y: 60, z: 100, r: 8 } },
  { tick: 3, playerId: 2, seq: 0, op: { kind: 'dig', x: 110, y: 60, z: 100, r: 5 } },
  { tick: 3, playerId: 1, seq: 1, op: { kind: 'place', x: 100, y: 70, z: 100, r: 4, mat: 7 } },
  { tick: 7, playerId: 1, seq: 2, op: { kind: 'dig', x: 100, y: 64, z: 100, r: 12 } },
]

function run(seed: number, commands: Command[], ticks: number): number[] {
  const sim = makeSim(seed)
  for (const c of commands) sim.queue.push(c)
  const hashes: number[] = []
  for (let i = 0; i < ticks; i++) {
    sim.step()
    hashes.push(hashSim(sim))
  }
  return hashes
}

describe('replay determinism (V3, I.hash)', () => {
  it('same seed + same log ⇒ identical hash sequence', () => {
    expect(run(1234, log, 10)).toEqual(run(1234, log, 10))
  })

  it('command arrival order does not matter, only (tick, playerId, seq)', () => {
    const shuffled = [log[3], log[1], log[0], log[2]]
    expect(run(1234, shuffled, 10)).toEqual(run(1234, log, 10))
  })

  it('one changed command ⇒ hashes diverge from that tick on', () => {
    const tampered = log.map((c, i) =>
      i === 1 ? { ...c, op: { ...c.op, r: 6 } } : c,
    ) as Command[]
    const a = run(1234, log, 10)
    const b = run(1234, tampered, 10)
    expect(a.slice(0, 2)).toEqual(b.slice(0, 2)) // before tick 3: identical
    expect(a[3]).not.toBe(b[3]) // after tampered tick: diverged
  })

  it('different seed ⇒ different hash (prng state is part of state)', () => {
    const a = run(1, log, 1)
    const b = run(2, log, 1)
    expect(a[0]).not.toBe(b[0])
  })

  it('dig actually removes voxels, place adds (V1 path end-to-end)', () => {
    const sim = makeSim(1)
    sim.queue.push(log[0])
    sim.step()
    sim.step()
    expect(sim.world.getVoxel(100, 60, 100)).toBe(0)
    expect(sim.world.getVoxel(100, 30, 100)).toBe(2)
  })
})
