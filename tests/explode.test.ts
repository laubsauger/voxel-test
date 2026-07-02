import { beforeAll, describe, expect, it } from 'vitest'
import { Sim } from '../src/sim/loop'
import { hashSim } from '../src/sim/hash'
import { registerEditOps } from '../src/sim/edit-ops'
import { createPhysics, hashPhysics, loadJolt, type PhysicsWorld } from '../src/sim/physics'
import {
  EJECTA_CLUMP_MAX,
  EXPLOSION_SAMPLE_CAP,
  MAX_EJECTA_BODIES,
  explodeSphere,
} from '../src/sim/destruction'
import { registerShootOp } from '../src/sim/shoot-op'
import type { ExplosionEvent } from '../src/sim/events'

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

  it('severing a column spawns island + ejecta bodies in the same tick (T55)', async () => {
    const { sim, phys } = await setup()
    sim.world.fillBox(109, 8, 100, 109, 55, 100, DIRT)
    sim.step()
    expect(phys.bodies.size).toBe(0)

    sim.queue.push({ tick: 1, playerId: 1, seq: 0, op: { kind: 'explode', x: 103.5, y: 50.5, z: 100.5, r: 8, power: 4 } })
    sim.step()

    // T55: removed voxels near the kill threshold become ejecta bodies, and
    // the column above the cut loses support → island body. The severed
    // upper column is the LARGEST body (≥4 voxels — outer-zone loosening may
    // nibble its bottom voxel, seeded but semantically a rim detail).
    expect(phys.bodies.size).toBeGreaterThanOrEqual(2)
    const largest = [...phys.bodies.values()].reduce((a, b) => (b.count > a.count ? b : a))
    expect(largest.count).toBeGreaterThanOrEqual(4)
    expect(sim.world.getVoxel(109, 53, 100)).toBe(0) // upper column left the world
    // column base is far outside every zone: fully intact
    expect(sim.world.getVoxel(109, 45, 100)).toBe(DIRT)
    phys.dispose()
  }, 30000)

  it('applies a radial impulse to nearby dynamic bodies', async () => {
    const { sim, phys } = await setup()
    sim.world.fillBox(109, 8, 100, 109, 55, 100, DIRT)
    sim.step()
    // first explode severs the column → island body (largest of the spawned set)
    sim.queue.push({ tick: 1, playerId: 1, seq: 0, op: { kind: 'explode', x: 103.5, y: 50.5, z: 100.5, r: 8, power: 4 } })
    sim.step()
    const body = [...phys.bodies.values()].reduce((a, b) => (b.count > a.count ? b : a))

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

// T55 (B14/B16) — graduated falloff zones: crumble is the default, vaporize
// is the tight core only, rubble persists as interactive bodies.
describe('explosion falloff zones (T55, B14, B16)', () => {
  const BRICK = 5
  const CONCRETE = 4

  it('bomb into a brick wall: ≤20% vaporized, the rest crumbles (B16)', async () => {
    const { sim, phys } = await setup()
    // 3-voxel-thick brick wall
    sim.world.fillBox(90, 8, 100, 120, 30, 102, BRICK)
    sim.step()
    // bomb-grade blast centered on the wall face (r 14 vox, power 5)
    const stats = explodeSphere(sim, phys, 105, 18, 101, 14, 5)
    expect(stats.removed).toBeGreaterThan(50)
    // B16 ratio contract: vaporization is a rounding error for brick
    // (strength 3 never reaches q ≥ VAPORIZE_RATIO with power 5)
    expect(stats.vaporized / stats.removed).toBeLessThanOrEqual(0.2)
    // rubble persists: ejecta bodies spawned, capped, clump-sized
    expect(stats.ejectaBodies).toBeGreaterThan(0)
    expect(stats.ejectaBodies).toBeLessThanOrEqual(MAX_EJECTA_BODIES)
    for (const b of phys.bodies.values()) {
      expect(b.count).toBeGreaterThanOrEqual(1)
      expect(b.count).toBeLessThanOrEqual(EJECTA_CLUMP_MAX)
    }
    phys.dispose()
  }, 30000)

  it('ejecta velocities radiate FROM the blast center with upward bias (B13)', async () => {
    const { sim, phys } = await setup()
    sim.world.fillBox(90, 8, 100, 120, 30, 102, BRICK)
    sim.step()
    explodeSphere(sim, phys, 105, 18, 99, 14, 5) // blast in front of the wall
    expect(phys.bodies.size).toBeGreaterThan(3)
    const cx = 105 * 0.1, cy = 18 * 0.1, cz = 99 * 0.1
    let outward = 0
    let total = 0
    for (const b of phys.bodies.values()) {
      const v = b.body.GetLinearVelocity()
      const rx = b.px - cx, ry = b.py - cy, rz = b.pz - cz
      const dot = v.GetX() * rx + v.GetY() * ry + v.GetZ() * rz
      total++
      if (dot > 0) outward++
    }
    // radial + upward bias: the overwhelming majority must fly away from center
    expect(outward / total).toBeGreaterThan(0.8)
    phys.dispose()
  }, 30000)

  it('ejecta body count is capped for huge blasts', async () => {
    const { sim, phys } = await setup()
    sim.world.fillBox(60, 8, 60, 120, 40, 120, 1) // big dirt block
    sim.step()
    const stats = explodeSphere(sim, phys, 90, 25, 90, 16, 12)
    expect(stats.ejectaBodies).toBe(MAX_EJECTA_BODIES)
    expect(phys.bodies.size).toBe(MAX_EJECTA_BODIES)
    phys.dispose()
  }, 30000)

  it('outer zone: hard material below the kill threshold gets loosened singles, wall survives', async () => {
    const { sim, phys } = await setup()
    sim.world.fillBox(95, 8, 100, 115, 30, 101, CONCRETE)
    sim.step()
    // power 4 < concrete strength 5 → q < 1 everywhere: nothing vaporizes,
    // no clumps — only probabilistic knockouts near the center (cracked rim)
    const stats = explodeSphere(sim, phys, 105, 18, 100, 10, 4)
    expect(stats.vaporized).toBe(0)
    expect(stats.ejectaBodies).toBe(0)
    expect(stats.removed).toBeGreaterThan(0) // it DID scar the wall
    expect(stats.removed).toBeLessThan(120) // …but the wall stands
    phys.dispose()
  }, 30000)

  it('emits an explosion event with material counts and a capped voxel sample', async () => {
    const { sim, phys } = await setup()
    sim.world.fillBox(90, 8, 100, 120, 30, 102, BRICK)
    sim.step()
    sim.drainEvents() // clear anything from setup
    sim.queue.push({ tick: sim.tick, playerId: 1, seq: 0, op: { kind: 'explode', x: 105, y: 18, z: 101, r: 14, power: 5 } })
    sim.step()
    const events = sim.drainEvents()
    const ex = events.find((e) => e.kind === 'explosion') as ExplosionEvent
    expect(ex).toBeDefined()
    expect(ex.x).toBeCloseTo(10.5, 6) // meters
    expect(ex.r).toBeCloseTo(1.4, 6)
    // flat [mat, count] pairs, brick among them
    expect(ex.removedByMat.length % 2).toBe(0)
    const mats = ex.removedByMat.filter((_, i) => i % 2 === 0)
    expect(mats).toContain(BRICK)
    // flat [x,y,z,mat] quads, capped
    expect(ex.sample.length % 4).toBe(0)
    expect(ex.sample.length / 4).toBeLessThanOrEqual(EXPLOSION_SAMPLE_CAP)
    expect(ex.sample.length).toBeGreaterThan(0)
    // sampled voxels really left the world
    for (let i = 0; i < Math.min(ex.sample.length, 40); i += 4) {
      expect(sim.world.getVoxel(ex.sample[i], ex.sample[i + 1], ex.sample[i + 2])).toBe(0)
    }
    // a second drain is empty (outbox semantics)
    expect(sim.drainEvents().length).toBe(0)
    phys.dispose()
  }, 30000)

  it('zoned explosion is deterministic: two runs → identical sim+phys hash sequences (V2/V3)', async () => {
    const run = async () => {
      const { sim, phys } = await setup()
      sim.world.fillBox(90, 8, 100, 120, 30, 102, BRICK)
      sim.queue.push({ tick: 1, playerId: 1, seq: 0, op: { kind: 'explode', x: 105, y: 18, z: 101, r: 14, power: 5 } })
      const hashes: number[] = []
      for (let i = 0; i < 40; i++) {
        sim.step()
        hashes.push(hashSim(sim), hashPhysics(phys))
      }
      phys.dispose()
      return hashes
    }
    const a = await run()
    const b = await run()
    expect(b).toEqual(a)
  }, 60000)
})

// B15 — fragments crossing the connectivity region boundary must not get
// stuck mid-air as static world (escape-hatch false positive).
describe('boundary-crossing fragments become bodies (B15)', () => {
  it('severed beam extending past the region margin is extracted, not stuck', async () => {
    const { sim, phys } = await setup()
    const BRICK = 5
    // column on the ground + long beam off its top: x 100..140 at y 41
    sim.world.fillBox(100, 8, 100, 100, 40, 100, BRICK)
    sim.world.fillBox(100, 41, 100, 140, 41, 100, BRICK)
    sim.step()
    expect(phys.bodies.size).toBe(0)

    // sever the beam right at the column. Dirty chunks stay in x ≤ 127, so
    // the old region (chunks + margin 8) ends at x=135 — the fragment
    // (x ~106..140) crosses it and pre-B15 stayed static mid-air forever.
    sim.queue.push({ tick: 1, playerId: 1, seq: 0, op: { kind: 'explode', x: 103, y: 41.5, z: 100.5, r: 3, power: 20 } })
    for (let i = 0; i < 3; i++) sim.step()

    // the far beam end must have LEFT the static world…
    for (let x = 130; x <= 140; x++) expect(sim.world.getVoxel(x, 41, 100)).toBe(0)
    // …and live on as one big dynamic body (rim loosening may trim a voxel or two)
    const largest = [...phys.bodies.values()].reduce((a, b) => (b.count > a.count ? b : a))
    expect(largest.count).toBeGreaterThanOrEqual(25)
    phys.dispose()
  }, 30000)
})

// B17 — dynamic bodies react to shooting, blasts and digging.
describe('bodies react to tools (B17)', () => {
  const WOOD = 6

  /** floating 4×4×4 wood blob → extracted island on the first step */
  async function setupBody(): Promise<{ sim: Sim; phys: PhysicsWorld }> {
    const sim = new Sim(1)
    registerEditOps(sim)
    sim.world.fillBox(0, 0, 0, 127, 7, 127, 3)
    const phys = await createPhysics(sim)
    registerShootOp(sim, phys)
    sim.world.fillBox(60, 40, 60, 63, 43, 63, WOOD)
    sim.step()
    expect(phys.bodies.size).toBe(1)
    return { sim, phys }
  }

  it('shooting a body: impulse + voxels shot out; empty body despawns', async () => {
    const { sim, phys } = await setupBody()
    const body = [...phys.bodies.values()][0]
    const count0 = body.count
    const version0 = body.version
    // shoot from -x, straight at the blob center (world meters)
    sim.queue.push({
      tick: sim.tick, playerId: 1, seq: 0,
      op: { kind: 'shoot', ox: 3.0, oy: body.py + 0.2, oz: body.pz + 0.2, dx: 1, dy: 0, dz: 0 },
    })
    sim.step()
    expect(body.count).toBeLessThan(count0) // voxels removed from the grid
    expect(body.version).toBeGreaterThan(version0) // render rebuild trigger
    const v = body.body.GetLinearVelocity()
    expect(v.GetX()).toBeGreaterThan(0.05) // shoved along the shot
    // shot event reports the body hit with a surface normal facing the shooter
    const shot = sim.drainEvents().find((e) => e.kind === 'shot')
    expect(shot && shot.hit).toBe(1)
    if (shot?.kind === 'shot') {
      expect(shot.mat).toBe(WOOD)
      expect(shot.nx).toBeLessThan(0) // -x face
    }
    phys.dispose()
  }, 30000)

  it('blast damages body voxels, not just impulse (B17.2)', async () => {
    const { sim, phys } = await setupBody()
    const body = [...phys.bodies.values()][0]
    const count0 = body.count
    // power 4 blast right next to the blob (wood strength 2 → q > 1 close in)
    sim.queue.push({
      tick: sim.tick, playerId: 1, seq: 0,
      op: { kind: 'explode', x: 58, y: 42, z: 62, r: 8, power: 4 },
    })
    sim.step()
    expect(body.count).toBeLessThan(count0)
    phys.dispose()
  }, 30000)

  it('digging near a body pushes it (rubble is clearable, B17.3)', async () => {
    const { sim, phys } = await setupBody()
    const body = [...phys.bodies.values()][0]
    sim.queue.push({
      tick: sim.tick, playerId: 1, seq: 0,
      op: { kind: 'dig', x: 57, y: 42, z: 62, r: 4 },
    })
    sim.step()
    const v = body.body.GetLinearVelocity()
    expect(v.GetX()).toBeGreaterThan(0.02) // pushed away in +x
    phys.dispose()
  }, 30000)

  it('body interactions are deterministic: two runs → identical hashes', async () => {
    const run = async () => {
      const { sim, phys } = await setupBody()
      const body = [...phys.bodies.values()][0]
      sim.queue.push({
        tick: sim.tick, playerId: 1, seq: 0,
        op: { kind: 'shoot', ox: 3.0, oy: body.py + 0.2, oz: body.pz + 0.2, dx: 1, dy: 0, dz: 0 },
      })
      const hashes: number[] = []
      for (let i = 0; i < 20; i++) {
        sim.step()
        hashes.push(hashPhysics(phys))
      }
      phys.dispose()
      return hashes
    }
    const a = await run()
    const b = await run()
    expect(b).toEqual(a)
  }, 60000)
})
