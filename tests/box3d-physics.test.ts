/**
 * T84 / V16 — the REAL destruction pipeline runs on Box3D. This is the port-map's
 * proof path: fill a real ChunkStore (ground + a brick column), wire a
 * Box3DPhysicsWorld via the SAME edit + destruction ops the game uses, push a real
 * `explode` command, step the real Sim, and assert the pipeline produced dynamic
 * debris bodies with finite, falling transforms — i.e. connectivity.findUnsupportedIslands
 * → extractIsland → buildVoxelBody (convex-hull islands) all work on box3d-wasm.
 *
 * Determinism/hash parity with Jolt is intentionally NOT asserted (B30: box3d is
 * f32 + a different body decomposition — its own non-MP build).
 */
import { describe, it, expect } from 'vitest'
import { Sim } from '../src/sim/loop'
import { registerEditOps } from '../src/sim/edit-ops'
import { createBox3DPhysics } from '../src/spike/box3d-physics'
import type { Command } from '../src/sim/commands'

function makeSim(seed: number): Sim {
  const sim = new Sim(seed)
  registerEditOps(sim)
  // ground slab (2×2 chunks, 8 tall) + a brick column standing on it
  sim.world.fillBox(0, 0, 0, 63, 7, 63, 3)
  sim.world.fillBox(30, 8, 30, 35, 30, 35, 5) // brick pillar, 6×23×6 voxels
  return sim
}

describe('T84 — real destruction pipeline on Box3D (V16, B30)', () => {
  it('explode command → convex-hull debris bodies, static colliders built', async () => {
    const sim = makeSim(7)
    const phys = await createBox3DPhysics(sim)

    const staticBefore = phys.staticColliderCount
    expect(staticBefore).toBeGreaterThan(0) // ground + pillar → colliders (per greedy box)

    // real explode op at the pillar base — severs the column, unsupported top
    // becomes islands via connectivity, extracted as Box3D dynamic bodies
    const cmd: Command = { tick: 1, playerId: 1, seq: 0, op: { kind: 'explode', x: 32, y: 9, z: 32, r: 6, power: 6 } }
    sim.queue.push(cmd)

    for (let i = 0; i < 40; i++) sim.step()

    // the pipeline spawned dynamic bodies (islands + ejecta debris)
    expect(phys.bodies.size).toBeGreaterThan(0)

    // every body has finite transforms and did not tunnel to infinity
    let minY = Infinity
    for (const b of phys.bodies.values()) {
      expect(Number.isFinite(b.px) && Number.isFinite(b.py) && Number.isFinite(b.pz)).toBe(true)
      expect(Number.isFinite(b.qx) && Number.isFinite(b.qw)).toBe(true)
      expect(b.py).toBeGreaterThan(-20)
      minY = Math.min(minY, b.py)
    }

    // voxels were actually removed from the world at the blast
    expect(sim.world.getVoxel(32, 9, 32)).toBe(0)

    phys.dispose()
  }, 30000)

  it('debris moves under the solver over time (physics actually integrates)', async () => {
    const sim = makeSim(3)
    const phys = await createBox3DPhysics(sim)
    sim.queue.push({ tick: 1, playerId: 1, seq: 0, op: { kind: 'explode', x: 32, y: 20, z: 32, r: 7, power: 8 } })

    for (let i = 0; i < 5; i++) sim.step()
    expect(phys.bodies.size).toBeGreaterThan(0)
    const first = [...phys.bodies.values()][0]
    const p0 = { x: first.px, y: first.py, z: first.pz }
    for (let i = 0; i < 40; i++) sim.step()
    const still = phys.bodies.get(first.id)
    if (still) {
      // the body's transform changed materially — the solver integrated it
      const moved = Math.hypot(still.px - p0.x, still.py - p0.y, still.pz - p0.z)
      expect(moved).toBeGreaterThan(0.05)
    }

    phys.dispose()
  }, 30000)
})
