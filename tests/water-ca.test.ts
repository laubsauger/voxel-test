import { describe, expect, it } from 'vitest'
import { ChunkStore } from '../src/world/chunks'
import { WaterSim } from '../src/sim/water/water-sim'
import { LATERAL_DEADBAND, MAX_LEVEL } from '../src/sim/water/rules'

// T15 — CPU reference water CA behavior. These tests encode the *physics
// contract*: gravity pulls water down, it spreads to a flat equilibrium,
// solids block it, and opening a hole drains it. If a rule change breaks any
// of these, the water no longer behaves like water.

/** step until fully settled; fail loud if it never settles (convergence is a rule guarantee) */
function settle(w: WaterSim, maxSteps: number): number {
  for (let i = 0; i < maxSteps; i++) {
    w.step()
    if (w.activeChunkCount === 0) return i + 1
  }
  throw new Error(`water did not settle within ${maxSteps} steps (active=${w.activeChunkCount})`)
}

describe('water CA — gravity (T15)', () => {
  it('falls one cell per step and lands in a 1×1 pit', () => {
    const world = new ChunkStore()
    world.fillBox(0, 0, 0, 31, 9, 31, 2) // solid slab y0..9
    world.fillBox(16, 5, 16, 16, 9, 16, 0) // carve 1×1 pit down to y5
    const w = new WaterSim(world)
    expect(w.addWater(16, 20, 16, MAX_LEVEL)).toBe(MAX_LEVEL)

    // mid-air water must not spread laterally (unsupported donor rule)
    for (let i = 0; i < 5; i++) w.step()
    expect(w.levelAt(16, 15, 16)).toBe(MAX_LEVEL) // fell exactly 5 cells
    expect(w.levelAt(15, 15, 16)).toBe(0)
    expect(w.levelAt(16, 14, 16)).toBe(0)

    settle(w, 60)
    expect(w.levelAt(16, 5, 16)).toBe(MAX_LEVEL) // full cell at pit bottom
    expect(w.totalMass()).toBe(MAX_LEVEL)
  })

  it('does not fall through the world floor (y=0 blocked)', () => {
    const world = new ChunkStore() // no terrain at all
    const w = new WaterSim(world)
    w.addWater(10, 8, 10, MAX_LEVEL)
    settle(w, 1500)
    // all mass still present, all of it resting at y=0
    expect(w.totalMass()).toBe(MAX_LEVEL)
    let massAtFloor = 0
    for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) massAtFloor += w.levelAt(x, 0, z)
    expect(massAtFloor).toBe(MAX_LEVEL)
  })
})

describe('water CA — lateral spread (T15)', () => {
  it('falls then spreads to equilibrium on a flat floor', () => {
    const world = new ChunkStore()
    world.fillBox(0, 0, 0, 31, 4, 31, 2) // flat floor, top at y=4
    const w = new WaterSim(world)
    w.addWater(16, 12, 16, MAX_LEVEL)
    settle(w, 3000)

    expect(w.totalMass()).toBe(MAX_LEVEL)
    // every drop rests on the floor plane
    let massAtRest = 0
    const wet: Array<[number, number]> = []
    for (let x = 0; x < 32; x++) {
      for (let z = 0; z < 32; z++) {
        const l = w.levelAt(x, 5, z)
        massAtRest += l
        if (l > 0) wet.push([x, z])
      }
    }
    expect(massAtRest).toBe(MAX_LEVEL)
    expect(wet.length).toBeGreaterThan(10) // actually spread out, not a single column
    // equilibrium: no adjacent pair differs by more than LATERAL_DEADBAND —
    // the settle deadband (B21) makes diff<=2 a fixpoint; anything steeper
    // still flowing means the surface never went flat
    for (const [x, z] of wet) {
      const l = w.levelAt(x, 5, z)
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        expect(Math.abs(l - w.levelAt(x + dx, 5, z + dz))).toBeLessThanOrEqual(LATERAL_DEADBAND)
      }
    }
  })

  it('is blocked by solid walls (pool holds water)', () => {
    const world = new ChunkStore()
    world.fillBox(0, 0, 0, 31, 5, 31, 2) // ground
    // basin walls y6..10 around interior (9..22)²
    world.fillBox(8, 6, 8, 23, 10, 8, 2)
    world.fillBox(8, 6, 23, 23, 10, 23, 2)
    world.fillBox(8, 6, 8, 8, 10, 22, 2)
    world.fillBox(23, 6, 9, 23, 10, 22, 2)
    const w = new WaterSim(world)
    let poured = 0
    for (let x = 12; x <= 19; x++)
      for (let z = 12; z <= 19; z++) {
        poured += w.addWater(x, 8, z, MAX_LEVEL)
      }
    settle(w, 3000)
    expect(w.totalMass()).toBe(poured)
    // nothing escaped the basin footprint
    for (let x = 0; x < 32; x++)
      for (let z = 0; z < 32; z++) {
        if (x >= 9 && x <= 22 && z >= 9 && z <= 22) continue
        for (let y = 0; y < 16; y++) {
          expect(w.levelAt(x, y, z), `leak at ${x},${y},${z}`).toBe(0)
        }
      }
    // water never entered solid cells
    expect(w.levelAt(8, 6, 12)).toBe(0)
    expect(w.levelAt(12, 5, 12)).toBe(0)
  })

  it('drains through a hole when a floor voxel is removed', () => {
    const world = new ChunkStore()
    // sealed tank: outer walls y0..14 around interior (12..19)², with a floor
    // plate at y=9 splitting it into a basin (above) and a cavity (below)
    world.fillBox(11, 0, 11, 20, 14, 11, 2)
    world.fillBox(11, 0, 20, 20, 14, 20, 2)
    world.fillBox(11, 0, 11, 11, 14, 19, 2)
    world.fillBox(20, 0, 12, 20, 14, 19, 2)
    world.fillBox(12, 9, 12, 19, 9, 19, 2) // floor plate
    const w = new WaterSim(world)
    let poured = 0
    for (let x = 12; x <= 19; x++)
      for (let z = 12; z <= 19; z++) {
        poured += w.addWater(x, 10, z, MAX_LEVEL)
      }
    settle(w, 3000)
    expect(w.totalMass()).toBe(poured)

    // knock out one floor voxel — the edit-op contract: notifyVoxelChanged
    world.setVoxel(15, 9, 15, 0)
    expect(w.activeChunkCount).toBe(0) // still asleep until notified
    w.notifyVoxelChanged(15, 9, 15)
    expect(w.activeChunkCount).toBeGreaterThan(0)
    settle(w, 8000)

    expect(w.totalMass()).toBe(poured) // drain moved water, no mass event
    let below = 0
    let above = 0
    for (let x = 0; x < 32; x++)
      for (let z = 0; z < 32; z++)
        for (let y = 0; y < 16; y++) {
          const l = w.levelAt(x, y, z)
          if (y <= 9) below += l
          else above += l
        }
    expect(below + above).toBe(poured)
    // nearly everything drained. A thin residue film stays up top: pairs with
    // level diff ≤1 are a fixpoint, so a shallow gradient sloping to the hole
    // (levels 0..~manhattan-distance) is stable — a puddle, not a leak.
    expect(below).toBeGreaterThan(poured * 0.9)
    expect(above).toBeLessThanOrEqual(poured * 0.05)
  })
})

describe('water CA — source/sink API (T15)', () => {
  it('addWater clamps to cell capacity and refuses solids', () => {
    const world = new ChunkStore()
    world.fillBox(0, 0, 0, 31, 4, 31, 2)
    const w = new WaterSim(world)
    expect(w.addWater(5, 2, 5, 100)).toBe(0) // solid cell
    expect(w.addWater(5, 5, 5, 200)).toBe(200)
    expect(w.addWater(5, 5, 5, 200)).toBe(55) // clamped to MAX_LEVEL
    expect(w.levelAt(5, 5, 5)).toBe(MAX_LEVEL)
    expect(w.addWater(-1, 5, 5, 10)).toBe(0) // OOB
  })

  it('removeWater returns what it actually removed', () => {
    const world = new ChunkStore()
    world.fillBox(0, 0, 0, 31, 4, 31, 2)
    const w = new WaterSim(world)
    w.addWater(5, 5, 5, 40)
    expect(w.removeWater(5, 5, 5, 100)).toBe(40)
    expect(w.removeWater(5, 5, 5, 100)).toBe(0)
    expect(w.totalMass()).toBe(0)
  })

  it('placing a solid voxel into water displaces it (explicit sink, reported)', () => {
    const world = new ChunkStore()
    world.fillBox(0, 0, 0, 31, 4, 31, 2)
    const w = new WaterSim(world)
    w.addWater(5, 5, 5, 123)
    world.setVoxel(5, 5, 5, 7)
    expect(w.notifyVoxelChanged(5, 5, 5)).toBe(123)
    expect(w.levelAt(5, 5, 5)).toBe(0)
    expect(w.totalMass()).toBe(0)
  })
})
