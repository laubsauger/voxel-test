import { beforeAll, describe, expect, it } from 'vitest'
import { Sim } from '../src/sim/loop'
import { registerEditOps } from '../src/sim/edit-ops'
import { createPhysics, loadJolt, STRESS_INTERVAL } from '../src/sim/physics'
import { findUnsupportedIslands } from '../src/sim/connectivity'
import { CoarseSupport } from '../src/sim/coarse-support'
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
    phys.extractIsland(sim, islands[0])
    // B23/T88 — island hulls materialize via the layer's budgeted queue (same
    // tick in-game: layer.step runs as a sim system). Advance one step here.
    sim.step()
    const body = [...phys.debris!.bodies.values()][0]
    expect(body).toBeDefined()

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
    expect(body!.py).toBeCloseTo(2.0, 1) // fell ~3mm during the deferred-spawn step
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

describe('zero-support catch (T92, B33): fully severed structure MUST fall', () => {
  // The bug: region-limited connectivity (boundary escape) and the D=4 coarse
  // grid (thin gaps alias away) both missed fully-severed slim towers — upper
  // floors floated forever. findStressCollapses spans the full ground→top
  // column: a component grounded NOWHERE and clipped by NO boundary is
  // provably floating and must collapse regardless of stress ratios.
  it('slim tower severed by a thin cut collapses (coarse-grid aliasing case)', async () => {
    const sim = makeSim()
    sim.world.fillBox(0, 0, 0, 63, 3, 63, 3) // terrain slab
    sim.world.fillBox(30, 4, 30, 32, 60, 32, BRICK) // 3x3 slim tower
    const phys = await createPhysics(sim)
    sim.step()
    // r=2 dig = ~3-voxel gap: too thin for an empty D=4 coarse layer
    sim.queue.push({ tick: 1, playerId: 1, seq: 0, op: { kind: 'dig', x: 31, y: 10, z: 31, r: 2 } })
    for (let i = 0; i < 30; i++) sim.step()
    // everything above the cut must be GONE from the world (debris now)
    let topmost = -1
    for (let y = 70; y >= 12; y--)
      for (let z = 30; z <= 32; z++)
        for (let x = 30; x <= 32; x++) if (sim.world.getVoxel(x, y, z) !== 0) topmost = Math.max(topmost, y)
    expect(topmost).toBe(-1)
    expect(phys.debris!.bodies.size).toBeGreaterThan(0)
    phys.dispose()
  }, 30000)
})

describe('building-scale collapse (B38): coarse floaters extract directly, no caps', () => {
  // WHY: every fine detector conservatively keeps ANY over-cap component static
  // (region clamp 128/axis → boundary escape; PROVISIONAL_MAX_VOXELS=2048;
  // ground-check 120k-visit abort). A severed highrise trips ALL of them and
  // hung in the air forever. The coarse grid's global ground flood over-connects
  // the fine graph, so its unreached cells are PROVABLY floating — B38 extracts
  // their voxels directly, in budgeted bottom-up slices (demolition cascade).

  it('collectFloatingVoxels enumerates exactly the floating voxels (unit)', () => {
    const sim = new Sim(1)
    sim.world.fillBox(0, 0, 0, 63, 3, 63, 3) // ground
    sim.world.fillBox(20, 30, 20, 27, 37, 27, BRICK) // floating 8³ cube (512 vox)
    sim.world.fillBox(40, 4, 40, 43, 20, 43, BRICK) // grounded column — must NOT collect
    const coarse = new CoarseSupport({ cx0: 0, cy0: 0, cz0: 0, cx1: 1, cy1: 1, cz1: 1 })
    coarse.rebuild(sim.world)
    expect(coarse.findFloating(true)).not.toBeNull()
    const cut = coarse.collectFloatingVoxels(sim.world, 100000)!
    expect(cut.truncated).toBe(false)
    expect(cut.voxels.length).toBe(512)
    for (const v of cut.voxels) {
      expect(v.x >= 20 && v.x <= 27 && v.y >= 30 && v.y <= 37 && v.z >= 20 && v.z <= 27).toBe(true)
      expect(v.mat).toBe(BRICK)
    }
  })

  it('budget truncates at a cell boundary, bottom-up, and the rest survives to a second call', () => {
    const sim = new Sim(1)
    sim.world.fillBox(0, 0, 0, 63, 3, 63, 3)
    sim.world.fillBox(20, 30, 20, 27, 45, 27, BRICK) // floating 8×16×8 pillar
    const coarse = new CoarseSupport({ cx0: 0, cy0: 0, cz0: 0, cx1: 1, cy1: 1, cz1: 1 })
    coarse.rebuild(sim.world)
    coarse.findFloating(true)
    const first = coarse.collectFloatingVoxels(sim.world, 300)!
    expect(first.truncated).toBe(true)
    // bottom-up: everything collected sits below everything not collected
    const maxTaken = Math.max(...first.voxels.map((v) => v.y))
    expect(maxTaken).toBeLessThan(45)
    // clear the taken slice, re-run: the remainder is found and finishes
    sim.world.clearVoxels(first.voxels)
    coarse.update(sim.world, [...sim.world.drainDirty()])
    coarse.findFloating(true)
    const rest = coarse.collectFloatingVoxels(sim.world, 100000)!
    expect(rest.truncated).toBe(false)
    expect(first.voxels.length + rest.voxels.length).toBe(8 * 16 * 8)
  })

  it('severed highrise (bigger than every fine cap) fully collapses via the cascade', async () => {
    const sim = makeSim()
    sim.world.fillBox(0, 0, 0, 120, 3, 120, 3) // terrain
    // hollow tower: 48×48 footprint, 3-thick walls, 250 tall, slabs every 26 —
    // ~140k voxels: > PROVISIONAL_MAX (2048), > region extent (128/axis),
    // > GROUND_CHECK_MAX_VISITS (120k). Every pre-B38 detector keeps it static.
    const x0 = 30, z0 = 30, x1 = 77, z1 = 77, yb = 4, yt = 253
    sim.world.fillBox(x0, yb, z0, x1, yt, z1, BRICK)
    sim.world.fillBox(x0 + 3, yb, z0 + 3, x1 - 3, yt, z1 - 3, 0) // hollow core
    for (let y = yb + 26; y < yt; y += 26) sim.world.fillBox(x0 + 3, y, z0 + 3, x1 - 3, y + 1, z1 - 3, BRICK)
    const phys = await createPhysics(sim)
    sim.step() // initial dirty drain settles as "build"
    for (let i = 0; i < STRESS_INTERVAL * 3; i++) sim.step() // flush initial stress queue: tower stands
    let preCut = 0
    for (let y = 60; y <= 62; y++)
      for (let z = z0; z <= z1; z += 4)
        for (let x = x0; x <= x1; x += 4) if (sim.world.getVoxel(x, y, z) !== 0) preCut++
    expect(preCut).toBeGreaterThan(0) // sanity: intact before the cut

    // yoink the bottom two floors clean (y 4..55): the user's exact scenario
    sim.world.fillBox(x0 - 1, yb, z0 - 1, x1 + 1, yb + 51, z1 + 1, 0)
    // cascade: 12k voxels per stress flush (6 ticks) — give it ample ticks
    for (let i = 0; i < 160; i++) sim.step()

    // EVERYTHING above the cut must have left the world (extracted to debris)
    let remaining = 0
    for (let y = yb + 52; y <= yt; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) if (sim.world.getVoxel(x, y, z) !== 0) remaining++
    expect(remaining).toBe(0)
    expect(phys.debris!.bodies.size).toBeGreaterThan(0) // it fell as debris, not vanished silently
    phys.dispose()
  }, 60000)

  it('wide structure severed by a SMALL local edit collapses (adaptive region growth)', async () => {
    // The kill case for a fixed ±2-chunk coarse region: a 200-wide slab crosses
    // the region sides, side-seeding marks it supported, and at 160k voxels the
    // ground-check aborts (>120k visits). Only the B38 growth loop — enlarge the
    // region until the floater is fully enclosed — catches it.
    const sim = makeSim()
    sim.world.fillBox(0, 0, 0, 260, 3, 260, 3) // terrain
    sim.world.fillBox(126, 4, 126, 129, 40, 129, BRICK) // single 4×4 column
    sim.world.fillBox(30, 41, 30, 229, 44, 229, BRICK) // 200×200×4 slab = 160k vox
    const phys = await createPhysics(sim)
    sim.step()
    for (let i = 0; i < STRESS_INTERVAL * 3; i++) sim.step() // settles standing
    // sever the column with a small dig — edit box is tiny, slab is 200 wide.
    // r=6 → ~12-voxel gap: clears a full D=4 coarse cell layer (thinner cuts
    // alias in the coarse grid — that pre-existing T92 limitation is out of
    // scope here; a "two floors gone" gameplay cut is 50+ voxels tall).
    sim.queue.push({ tick: sim.tick + 1, playerId: 1, seq: 0, op: { kind: 'dig', x: 127, y: 20, z: 127, r: 6 } })
    for (let i = 0; i < 200; i++) sim.step()
    let remaining = 0
    for (let y = 41; y <= 44; y++)
      for (let z = 30; z <= 229; z += 2)
        for (let x = 30; x <= 229; x += 2) if (sim.world.getVoxel(x, y, z) !== 0) remaining++
    expect(remaining).toBe(0)
    phys.dispose()
  }, 60000)

  it('same tower NOT severed stays standing through stress flushes (no false collapse)', async () => {
    const sim = makeSim()
    sim.world.fillBox(0, 0, 0, 120, 3, 120, 3)
    const x0 = 30, z0 = 30, x1 = 77, z1 = 77, yb = 4, yt = 253
    sim.world.fillBox(x0, yb, z0, x1, yt, z1, BRICK)
    sim.world.fillBox(x0 + 3, yb, z0 + 3, x1 - 3, yt, z1 - 3, 0)
    for (let y = yb + 26; y < yt; y += 26) sim.world.fillBox(x0 + 3, y, z0 + 3, x1 - 3, y + 1, z1 - 3, BRICK)
    const phys = await createPhysics(sim)
    sim.step()
    // poke a small hole in one wall (normal gameplay dig) — tower must stand
    sim.queue.push({ tick: 1, playerId: 1, seq: 0, op: { kind: 'dig', x: x0 + 1, y: 80, z: 54, r: 3 } })
    for (let i = 0; i < 40; i++) sim.step()
    let wallLeft = 0
    for (let z = z0; z <= z1; z += 2) for (let x = x0; x <= x1; x += 2)
      if (sim.world.getVoxel(x, 200, z) !== 0) wallLeft++
    expect(wallLeft).toBeGreaterThan(50) // upper floors intact
    expect(phys.debris!.bodies.size).toBeLessThan(30) // only the dig's small spall, no cascade
    phys.dispose()
  }, 60000)
})

describe('ground-reachability check (T93, B34): no welded path to ground = fall', () => {
  // B34: every prior detector was locality-bounded — components crossing the
  // analysis region were ASSUMED supported ("boundary escape"), and the D=4
  // coarse grid aliased thin gaps. findGroundlessComponents floods the actual
  // component with no region boundary: terrain contact (early exit) or
  // provably floating. Runs on edit-adjacent candidates in the stress slot.
  it('wide slab severed from a tiny-footprint column falls (boundary-escape case)', async () => {
    const sim = makeSim()
    sim.world.fillBox(0, 0, 0, 63, 3, 63, 3) // terrain
    sim.world.fillBox(30, 4, 30, 31, 20, 31, BRICK) // 2x2 column
    sim.world.fillBox(14, 21, 14, 47, 23, 47, BRICK) // 34x34 slab on top — FAR wider than the ±6 stress box
    const phys = await createPhysics(sim)
    sim.step()
    // sever the column below the slab
    sim.queue.push({ tick: 1, playerId: 1, seq: 0, op: { kind: 'dig', x: 30, y: 12, z: 30, r: 3 } })
    for (let i = 0; i < 30; i++) sim.step()
    // the slab must be gone from the world (extracted to debris)
    let slabLeft = 0
    for (let y = 21; y <= 23; y++)
      for (let z = 14; z <= 47; z++)
        for (let x = 14; x <= 47; x++) if (sim.world.getVoxel(x, y, z) !== 0) slabLeft++
    expect(slabLeft).toBe(0)
    expect(phys.debris!.bodies.size).toBeGreaterThan(0)
    phys.dispose()
  }, 30000)

  it('grounded structure with the same shape stays standing (early-exit path)', async () => {
    const sim = makeSim()
    sim.world.fillBox(0, 0, 0, 63, 3, 63, 3)
    sim.world.fillBox(30, 4, 30, 31, 20, 31, BRICK)
    sim.world.fillBox(14, 21, 14, 47, 23, 47, BRICK)
    sim.world.fillBox(45, 4, 45, 46, 20, 46, BRICK) // SECOND leg under the slab corner
    const phys = await createPhysics(sim)
    sim.step()
    // sever only the first column — slab still welded to ground via leg 2
    sim.queue.push({ tick: 1, playerId: 1, seq: 0, op: { kind: 'dig', x: 30, y: 12, z: 30, r: 3 } })
    for (let i = 0; i < 30; i++) sim.step()
    let slabLeft = 0
    for (let y = 21; y <= 23; y++)
      for (let z = 14; z <= 47; z++)
        for (let x = 14; x <= 47; x++) if (sim.world.getVoxel(x, y, z) !== 0) slabLeft++
    expect(slabLeft).toBeGreaterThan(3000) // slab (34*34*3=3468 minus blast nicks) stands
    phys.dispose()
  }, 30000)
})
