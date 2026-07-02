import { beforeAll, describe, expect, it } from 'vitest'
import { Sim } from '../src/sim/loop'
import { registerEditOps } from '../src/sim/edit-ops'
import { createPhysics, loadJolt, type PhysicsWorld } from '../src/sim/physics'

// T13 — explode: strength-scaled destruction (harder materials survive the
// outer radius), synchronous island spawning, radial impulse. All through the
// command path (V1) — the test never pokes voxels after setup.

beforeAll(async () => {
  await loadJolt()
}, 30000)

const DIRT = 1
const METAL = 9 // V13 canonical id (physics track's pre-merge table had 7)

async function setup(): Promise<{ sim: Sim; phys: PhysicsWorld }> {
  const sim = new Sim(1)
  registerEditOps(sim)
  sim.world.fillBox(0, 0, 0, 127, 7, 127, 3) // ground slab
  const phys = await createPhysics(sim)
  return { sim, phys }
}

describe('explode op (T13, I.cmd, V1)', () => {
  it('destroys soft material at the outer radius while hard material survives', async () => {
    const { sim, phys } = await setup()
    // two 1-voxel-thick columns, equidistant (6 voxels) from the blast center
    sim.world.fillBox(97, 8, 100, 97, 55, 100, METAL)
    sim.world.fillBox(109, 8, 100, 109, 55, 100, DIRT)
    sim.step() // static bodies for the columns

    // power 4, r 8: dirt (strength 1) dies out to dist 6; metal (strength 8) never
    sim.queue.push({ tick: 1, playerId: 1, seq: 0, op: { kind: 'explode', x: 103.5, y: 50.5, z: 100.5, r: 8, power: 4 } })
    sim.step()

    expect(sim.world.getVoxel(109, 50, 100)).toBe(0) // dirt at dist 6: destroyed
    expect(sim.world.getVoxel(97, 50, 100)).toBe(METAL) // metal at dist 6: intact
    // dirt farther up the column is outside the kill distance: intact or extracted, not vaporized
    const cut = sim.world.getVoxel(109, 51, 100)
    expect(cut === DIRT || cut === 0).toBe(true)
    phys.dispose()
  }, 30000)

  it('severing a column spawns island bodies in the same tick', async () => {
    const { sim, phys } = await setup()
    sim.world.fillBox(109, 8, 100, 109, 55, 100, DIRT)
    sim.step()
    expect(phys.bodies.size).toBe(0)

    sim.queue.push({ tick: 1, playerId: 1, seq: 0, op: { kind: 'explode', x: 103.5, y: 50.5, z: 100.5, r: 8, power: 4 } })
    sim.step()

    // the column above the cut lost support → dynamic body, voxels out of the world
    expect(phys.bodies.size).toBe(1)
    const body = [...phys.bodies.values()][0]
    expect(body.count).toBe(5) // y 51..55
    expect(sim.world.getVoxel(109, 53, 100)).toBe(0)
    // still supported below the cut
    expect(sim.world.getVoxel(109, 49, 100)).toBe(DIRT)
    phys.dispose()
  }, 30000)

  it('applies a radial impulse to nearby dynamic bodies', async () => {
    const { sim, phys } = await setup()
    sim.world.fillBox(109, 8, 100, 109, 55, 100, DIRT)
    sim.step()
    // first explode severs the column → island body
    sim.queue.push({ tick: 1, playerId: 1, seq: 0, op: { kind: 'explode', x: 103.5, y: 50.5, z: 100.5, r: 8, power: 4 } })
    sim.step()
    const body = [...phys.bodies.values()][0]

    // second explode right next to the body: it must get shoved, not just keep falling
    const px = body.px
    const bx = Math.round(body.px / 0.1)
    const by = Math.round(body.py / 0.1)
    sim.queue.push({
      tick: 2,
      playerId: 1,
      seq: 1,
      // small power: no voxel destruction of note, pure shove from the -x side
      op: { kind: 'explode', x: bx - 4, y: by, z: 100, r: 6, power: 1 },
    })
    sim.step()
    for (let i = 0; i < 10; i++) sim.step()
    expect(body.px).toBeGreaterThan(px + 0.05) // pushed away in +x
    phys.dispose()
  }, 30000)

  it('same explode twice in identical sims → identical outcome (V2/V3)', async () => {
    const runOnce = async () => {
      const { sim, phys } = await setup()
      sim.world.fillBox(109, 8, 100, 109, 55, 100, DIRT)
      sim.queue.push({ tick: 1, playerId: 1, seq: 0, op: { kind: 'explode', x: 103.5, y: 50.5, z: 100.5, r: 8, power: 4 } })
      for (let i = 0; i < 30; i++) sim.step()
      const body = [...phys.bodies.values()][0]
      const out = body ? [body.px, body.py, body.pz, body.qx, body.qy, body.qz, body.qw] : []
      phys.dispose()
      return out
    }
    const a = await runOnce()
    const b = await runOnce()
    expect(a.length).toBeGreaterThan(0)
    expect(b).toEqual(a) // exact f64 bit equality via toEqual on numbers
  }, 30000)
})
