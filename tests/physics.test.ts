import { beforeAll, describe, expect, it } from 'vitest'
import { Sim } from '../src/sim/loop'
import { hashSim } from '../src/sim/hash'
import { registerEditOps } from '../src/sim/edit-ops'
import { createPhysics, hashPhysics, loadJolt, type PhysicsWorld } from '../src/sim/physics'
import type { Command } from '../src/sim/commands'

// T10 — Jolt WASM integration. V3 groundwork: two identical runs must produce
// identical physics hash sequences, or lockstep multiplayer desyncs.
// Jolt is WASM: load once in beforeAll (async init, node env workaround).

beforeAll(async () => {
  await loadJolt()
}, 30000)

function makeSim(seed: number): Sim {
  const sim = new Sim(seed)
  registerEditOps(sim)
  // small ground slab: 2×2 chunks area, 8 voxels tall
  sim.world.fillBox(0, 0, 0, 63, 7, 63, 3)
  return sim
}

async function run(seed: number, commands: Command[], ticks: number) {
  const sim = makeSim(seed)
  const phys = await createPhysics(sim)
  for (const c of commands) sim.queue.push(c)
  const simHashes: number[] = []
  const physHashes: number[] = []
  for (let i = 0; i < ticks; i++) {
    sim.step()
    simHashes.push(hashSim(sim))
    physHashes.push(hashPhysics(phys))
  }
  const staticBodies = phys.staticBodyCount
  phys.dispose()
  return { simHashes, physHashes, staticBodies }
}

const log: Command[] = [
  { tick: 1, playerId: 1, seq: 0, op: { kind: 'dig', x: 20, y: 7, z: 20, r: 4 } },
  { tick: 4, playerId: 1, seq: 1, op: { kind: 'place', x: 40, y: 10, z: 40, r: 3, mat: 5 } },
  { tick: 8, playerId: 2, seq: 0, op: { kind: 'dig', x: 42, y: 8, z: 40, r: 3 } },
  // T13: explode severs the placed blob → island bodies enter the physics hash
  { tick: 12, playerId: 1, seq: 2, op: { kind: 'explode', x: 40.5, y: 8.5, z: 40.5, r: 5, power: 3 } },
]

describe('physics determinism (T10, I.jolt, V2, V3)', () => {
  it('two identical runs → identical sim + physics hash sequences', async () => {
    const a = await run(7, log, 20)
    const b = await run(7, log, 20)
    expect(b.physHashes).toEqual(a.physHashes)
    expect(b.simHashes).toEqual(a.simHashes)
  }, 30000)

  it('world-static bodies exist for solid chunks and rebuild on edits', async () => {
    const sim = makeSim(1)
    const phys = await createPhysics(sim)
    // ground slab spans 2×2 chunks in x/z, 1 chunk in y → 4 static bodies
    expect(phys.staticBodyCount).toBe(4)
    sim.queue.push(log[0])
    sim.step()
    sim.step()
    // dig realized a chunk to dense; body count unchanged, but remesh queue saw it
    expect(phys.staticBodyCount).toBe(4)
    expect(phys.drainRemesh().length).toBeGreaterThan(0)
    phys.dispose()
  }, 30000)

  it('physics step runs inside the sim tick at fixed DT (V2)', async () => {
    const sim = makeSim(1)
    const phys = await createPhysics(sim)
    // stepping the sim must not throw and must advance ticks; Jolt stepping is
    // registered as a Sim system so there is no other way to advance physics
    for (let i = 0; i < 5; i++) sim.step()
    expect(sim.tick).toBe(5)
    phys.dispose()
  }, 30000)
})
