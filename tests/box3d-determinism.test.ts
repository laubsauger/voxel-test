/**
 * Is the Box3D destruction backend replay-deterministic? Same seed + same command
 * log, two independent runs → must produce bit-identical body-state sequences.
 * This is the gate that decides whether a Box3D-canonical lockstep MP is possible
 * (Box3D peer vs Box3D peer), independent of Jolt-hash parity (B30).
 */
import { describe, it, expect } from 'vitest'
import { Sim } from '../src/sim/loop'
import { registerEditOps } from '../src/sim/edit-ops'
import { createBox3DPhysics } from '../src/spike/box3d-physics'
import type { Command } from '../src/sim/commands'

const log: Command[] = [
  { tick: 2, playerId: 1, seq: 0, op: { kind: 'dig', x: 32, y: 20, z: 32, r: 5 } },
  { tick: 6, playerId: 1, seq: 1, op: { kind: 'explode', x: 32, y: 9, z: 32, r: 6, power: 6 } },
  { tick: 10, playerId: 2, seq: 0, op: { kind: 'explode', x: 34, y: 12, z: 33, r: 5, power: 5 } },
]

/** deterministic digest of all body transforms this tick (sorted by id) */
function bodyHash(bodies: Map<number, { id: number; px: number; py: number; pz: number; qx: number; qy: number; qz: number; qw: number }>): string {
  const rows = [...bodies.values()].sort((a, b) => a.id - b.id)
  return rows.map((b) => `${b.id}:${b.px},${b.py},${b.pz},${b.qx},${b.qy},${b.qz},${b.qw}`).join('|')
}

async function run(): Promise<string[]> {
  const sim = new Sim(7)
  registerEditOps(sim)
  sim.world.fillBox(0, 0, 0, 63, 7, 63, 3)
  sim.world.fillBox(30, 8, 30, 35, 30, 35, 5)
  const phys = await createBox3DPhysics(sim)
  for (const c of log) sim.queue.push(c)
  const hashes: string[] = []
  for (let i = 0; i < 30; i++) {
    sim.step()
    hashes.push(bodyHash(phys.bodies))
  }
  phys.dispose()
  return hashes
}

describe('Box3D backend replay determinism', () => {
  it('two identical runs → identical body-state sequences', async () => {
    const a = await run()
    const b = await run()
    expect(a.length).toBe(b.length)
    // spawn count must match, and every tick's transforms must be bit-identical
    expect(b).toEqual(a)
    // sanity: bodies actually spawned (not a trivial pass over empty state)
    expect(a[a.length - 1].length).toBeGreaterThan(0)
  }, 30000)
})
