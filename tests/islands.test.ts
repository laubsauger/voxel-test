import { beforeAll, describe, expect, it } from 'vitest'
import { Sim } from '../src/sim/loop'
import { registerEditOps } from '../src/sim/edit-ops'
import { createPhysics, loadJolt } from '../src/sim/physics'
import { findUnsupportedIslands } from '../src/sim/connectivity'
import { material, VOXEL_VOLUME } from '../src/sim/materials'

// T12 — island extraction → dynamic body. The Teardown moment: voxels leave
// the ChunkStore, become a rigid body with correct mass, and fall. If voxels
// were duplicated (in world AND body) or mass were wrong, physics and
// multiplayer hashes would drift (V3, V8, V12).

beforeAll(async () => {
  await loadJolt()
}, 30000)

const WOOD = 4
const BRICK = 5

function makeSim(): Sim {
  const sim = new Sim(1)
  registerEditOps(sim)
  sim.world.fillBox(0, 0, 0, 63, 7, 63, 3) // ground slab
  return sim
}

describe('island extraction → LOCAL debris body (T12→T86, V17)', () => {
  it('extractIsland moves voxels world → debris-layer body with correct mass', async () => {
    const sim = makeSim()
    const phys = await createPhysics(sim)
    // free-floating wood blob 3×2×2 = 12 voxels
    sim.world.fillBox(20, 20, 20, 22, 21, 21, WOOD)
    const islands = findUnsupportedIslands(sim.world, { x0: 10, y0: 10, z0: 10, x1: 30, y1: 30, z1: 30 })
    expect(islands.length).toBe(1)

    const idBefore = sim.nextEntityId
    const body = phys.extractIsland(sim, islands[0])
    expect(body).not.toBeNull()

    // V17c — debris ids are LOCAL: the deterministic sim entity counter is
    // untouched (local body counts must never influence hashed sim state)
    expect(sim.nextEntityId).toBe(idBefore)
    expect(phys.debris!.bodies.size).toBe(1)
    expect(phys.bodies.size).toBe(0) // no Jolt body — debris is layer-side

    // voxels removed from the world…
    for (let y = 20; y <= 21; y++)
      for (let z = 20; z <= 21; z++)
        for (let x = 20; x <= 22; x++) expect(sim.world.getVoxel(x, y, z)).toBe(0)

    // …and present in the body's mini grid (3×2×2, all wood)
    expect([body!.sx, body!.sy, body!.sz]).toEqual([3, 2, 2])
    expect(body!.count).toBe(12)
    expect([...body!.grid].filter((v) => v === WOOD).length).toBe(12)

    // mass = voxel count × wood density × voxel volume
    expect(body!.mass).toBeCloseTo(12 * material(WOOD).density * VOXEL_VOLUME, 10)

    // spawn transform = grid origin corner, in meters
    expect(body!.px).toBeCloseTo(2.0, 6)
    expect(body!.py).toBeCloseTo(2.0, 6)
    phys.dispose()
  }, 30000)

  it('dig cutting a beam spawns a falling dynamic body via the command path (V1)', async () => {
    const sim = makeSim()
    const phys = await createPhysics(sim)
    // brick column on the ground + wood beam sticking out from its top
    sim.world.fillBox(30, 8, 30, 31, 15, 31, BRICK)
    sim.world.fillBox(32, 14, 30, 40, 15, 31, WOOD)
    // pre-edit content becomes static collision on the next structural pass
    sim.step()
    expect(phys.bodies.size).toBe(0)

    // cut the beam right after the column
    sim.queue.push({ tick: 1, playerId: 1, seq: 0, op: { kind: 'dig', x: 33, y: 15, z: 30, r: 2 } })
    sim.step() // tick 1: dig applied, structural pass extracts the island

    // T86 — the freed beam is a LOCAL debris-layer body, not a Jolt body
    expect(phys.bodies.size).toBe(0)
    expect(phys.debris!.bodies.size).toBeGreaterThanOrEqual(1)
    const body = [...phys.debris!.bodies.values()][0]
    expect(body.count).toBeGreaterThan(0)
    expect(body.mass).toBeCloseTo(body.count * material(WOOD).density * VOXEL_VOLUME, 10)
    // far end of the beam is no longer world voxels
    expect(sim.world.getVoxel(40, 15, 30)).toBe(0)
    expect(sim.world.getVoxel(40, 14, 31)).toBe(0)

    // body is dynamic: it falls under gravity over subsequent ticks
    const y0 = body.py
    for (let i = 0; i < 30; i++) sim.step()
    expect(body.py).toBeLessThan(y0)
    phys.dispose()
  }, 30000)

  it('supported structures spawn no bodies when edited non-destructively', async () => {
    const sim = makeSim()
    const phys = await createPhysics(sim)
    sim.world.fillBox(30, 8, 30, 31, 15, 31, BRICK) // column on ground
    sim.step()
    // dig air next to the column — nothing becomes unsupported
    sim.queue.push({ tick: 1, playerId: 1, seq: 0, op: { kind: 'dig', x: 40, y: 20, z: 40, r: 3 } })
    for (let i = 0; i < 5; i++) sim.step()
    expect(phys.bodies.size).toBe(0)
    expect(phys.debris!.bodies.size).toBe(0)
    phys.dispose()
  }, 30000)
})
