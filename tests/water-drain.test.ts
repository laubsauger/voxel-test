import { describe, expect, it } from 'vitest'
import { ChunkStore } from '../src/world/chunks'
import { WaterSim } from '../src/sim/water/water-sim'
import { FLOW_CAP, MAX_LEVEL, SURFACE_DEADBAND, columnFlow } from '../src/sim/water/rules'

// T62/B21 — the pool-never-drains regression, reproduced LIVE-style: a
// world-scale pool crossing a chunk border, filled and fully SETTLED
// (sleeping enabled — the wake/active-set machinery is part of the system
// under test), then breached through one wall via plain voxel edits wired
// through onVoxelChanged exactly like game.ts does. The B21 promise the old
// 3D CA never delivered: a breached pool must VISIBLY drain on gameplay
// timescales, conserve mass exactly while doing it, and fully settle after
// (no endless trickle keeping the sim awake / the surface mesh rebuilding).

function buildBreachScenario() {
  const world = new ChunkStore()
  world.fillBox(8, 0, 4, 55, 7, 27, 2) // yard floor
  // yard containment walls (bound the outflow so full settle stays testable)
  world.fillBox(8, 8, 4, 55, 16, 4, 2)
  world.fillBox(8, 8, 27, 55, 16, 27, 2)
  world.fillBox(8, 8, 4, 8, 16, 27, 2)
  world.fillBox(55, 8, 4, 55, 16, 27, 2)
  // pool shell CROSSING the x=32 chunk border, interior x 26..37, z 10..21, y 8..12
  world.fillBox(25, 8, 9, 38, 13, 22, 2)
  world.fillBox(26, 8, 10, 37, 13, 21, 0)

  const w = new WaterSim(world)
  // live wiring (game.ts): every voxel edit notifies the water sim
  world.onVoxelChanged = (x, y, z) => w.notifyVoxelChanged(x, y, z)

  let poured = 0
  for (let y = 8; y <= 12; y++)
    for (let z = 10; z <= 21; z++)
      for (let x = 26; x <= 37; x++) poured += w.addWater(x, y, z, MAX_LEVEL)

  const basinSum = () => {
    let s = 0
    for (let y = 8; y <= 13; y++)
      for (let z = 10; z <= 21; z++)
        for (let x = 26; x <= 37; x++) s += w.levelAt(x, y, z)
    return s
  }
  return { world, w, poured, basinSum }
}

describe('B21 — breached pool drains at world scale (T62, V9)', () => {
  it('drains fast, water exits the pool, mass conserves exactly, and it fully settles', () => {
    const { world, w, poured, basinSum } = buildBreachScenario()

    // pool settles and SLEEPS before the breach (live pools are asleep)
    for (let i = 0; i < 200 && w.activeChunkCount > 0; i++) w.step()
    expect(w.activeChunkCount).toBe(0)
    expect(basinSum()).toBe(poured)

    // breach the west wall full height — plain edits, hook does the waking
    for (let y = 8; y <= 12; y++)
      for (let z = 14; z <= 17; z++) world.setVoxel(25, y, z, 0)
    expect(w.activeChunkCount).toBeGreaterThan(0)

    // drain RATE (the B21 promise): the level must move on gameplay
    // timescales. 300 steps = 2.5s of game time — the basin must be more
    // than half empty by then, and water must be OUTSIDE the pool.
    let settledAt = -1
    for (let step = 1; step <= 6000; step++) {
      w.step()
      if (step === 300) {
        expect(w.totalMass(), `mass drifted by step ${step}`).toBe(poured)
        expect(basinSum() / poured, 'basin did not visibly drain in 2.5s').toBeLessThan(0.5)
        // outflow is real water in the yard, not vanished mass
        let outside = 0
        for (let y = 8; y <= 12; y++)
          for (let z = 5; z <= 26; z++)
            for (let x = 9; x <= 24; x++) outside += w.levelAt(x, y, z)
        expect(outside, 'no water left the pool through the breach').toBeGreaterThan(0)
      }
      if (w.activeChunkCount === 0) {
        settledAt = step
        break
      }
    }

    // guaranteed settle (the deadband): no endless bucket-brigade trickle
    expect(settledAt, 'water never settled after the breach').toBeGreaterThan(0)
    // near-empty basin: pool level equalized with the yard outside
    expect(basinSum() / poured).toBeLessThan(0.25)
    // V9: every drop that left the basin still exists somewhere in the yard
    expect(w.totalMass()).toBe(poured)
  })
})

describe('T62 — column flow rule (rules.ts contract)', () => {
  const U = MAX_LEVEL // 255 units per voxel

  it('never moves more than the donor holds above the sill, never over the cap', () => {
    for (const surfA of [10, 300, 1000, 5000])
      for (const surfB of [0, 5, 299, 900])
        for (const sill of [0, 255, 765])
          for (const wet of [false, true]) {
            if (surfB >= surfA) continue
            const t = columnFlow(surfA, surfB, sill, wet)
            expect(t).toBeGreaterThanOrEqual(0)
            expect(t).toBeLessThanOrEqual(FLOW_CAP) // rate-limited (reads as flow)
            expect(t).toBeLessThanOrEqual(Math.max(0, surfA - sill)) // sill holds what's below it
            expect(surfA - t).toBeGreaterThanOrEqual(surfB) // donor never ends below receiver
          }
  })

  it('deadband: settled wet pairs are a fixpoint, steeper ones flow', () => {
    expect(columnFlow(10 * U, 10 * U - SURFACE_DEADBAND, 8 * U, true)).toBe(0)
    expect(columnFlow(10 * U, 10 * U - SURFACE_DEADBAND - 2, 8 * U, true)).toBeGreaterThan(0)
    // dry receivers have NO deadband — residue still rolls over a ledge
    expect(columnFlow(8 * U + 2, 5 * U, 8 * U, false)).toBe(2)
  })

  it('a wall with no opening blocks all flow (sill above the surface)', () => {
    expect(columnFlow(10 * U, 2 * U, 10 * U, false)).toBe(0) // sill at surface: nothing above it
    expect(columnFlow(10 * U, 2 * U, 12 * U, false)).toBe(0) // sill above surface
  })

  it('a breach below the surface advects everything above the sill (capped)', () => {
    // deep drop into an empty yard: full cap per visit, not a diffusion trickle
    expect(columnFlow(12 * U, 8 * U, 8 * U, false)).toBe(FLOW_CAP)
    // nearly drained to the sill: the remaining head keeps halving out
    expect(columnFlow(8 * U + 40, 8 * U, 8 * U, false)).toBe(20)
  })

  it('connected columns equalize by half the difference', () => {
    expect(columnFlow(10 * U, 10 * U - 100, 8 * U, true)).toBe(50)
    expect(columnFlow(10 * U, 10 * U - 100, 9 * U, true)).toBe(50)
  })
})
