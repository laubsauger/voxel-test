import { describe, expect, it } from 'vitest'
import { ChunkStore } from '../src/world/chunks'
import { WaterSim } from '../src/sim/water/water-sim'
import { MAX_LEVEL, SURFACE_DEADBAND } from '../src/sim/water/rules'

// T15/T62 v3 — column-heightfield water behavior. These tests encode the
// *physics contract*: gravity pulls water to the floor, it spreads to a flat
// equilibrium, solids block it, and opening a hole drains it. If a rule
// change breaks any of these, the water no longer behaves like water.

/** step until fully settled; fail loud if it never settles (convergence is a rule guarantee) */
function settle(w: WaterSim, maxSteps: number): number {
  for (let i = 0; i < maxSteps; i++) {
    w.step()
    if (w.activeChunkCount === 0) return i + 1
  }
  throw new Error(`water did not settle within ${maxSteps} steps (active=${w.activeChunkCount})`)
}

describe('water columns — gravity (T15)', () => {
  it('water poured into a 1×1 pit comes to rest at the pit floor, no lateral drift', () => {
    const world = new ChunkStore()
    world.fillBox(0, 0, 0, 31, 9, 31, 2) // solid slab y0..9
    world.fillBox(16, 5, 16, 16, 9, 16, 0) // carve 1×1 pit down to y5
    const w = new WaterSim(world)
    expect(w.addWater(16, 20, 16, MAX_LEVEL)).toBe(MAX_LEVEL)

    settle(w, 60)
    expect(w.levelAt(16, 5, 16)).toBe(MAX_LEVEL) // full cell at pit bottom
    // pit walls held: nothing beside or above
    expect(w.levelAt(15, 10, 16)).toBe(0)
    expect(w.levelAt(16, 6, 16)).toBe(0)
    expect(w.totalMass()).toBe(MAX_LEVEL)
  })

  it('a span falls when its floor is removed (1 voxel per step)', () => {
    const world = new ChunkStore()
    world.fillBox(0, 0, 0, 31, 9, 31, 2) // slab y0..9
    world.fillBox(15, 10, 15, 17, 10, 17, 2) // 1×1 pocket ring on top…
    world.fillBox(16, 10, 16, 16, 10, 16, 0) // …holding the cell in place
    const w = new WaterSim(world)
    world.onVoxelChanged = (x, y, z) => w.notifyVoxelChanged(x, y, z)
    w.addWater(16, 10, 16, MAX_LEVEL) // rests in the pocket
    settle(w, 60)
    // carve a 1×1 shaft under it down to y5
    for (let y = 5; y <= 9; y++) world.setVoxel(16, y, 16, 0)
    expect(w.activeChunkCount).toBeGreaterThan(0)
    w.step() // falls exactly one voxel per step — bounded, visible descent
    expect(w.levelAt(16, 9, 16)).toBe(MAX_LEVEL)
    settle(w, 60)
    expect(w.levelAt(16, 5, 16)).toBe(MAX_LEVEL)
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

describe('water columns — lateral spread (T15)', () => {
  it('a stacked column spreads to a flat equilibrium on an open floor', () => {
    const world = new ChunkStore()
    world.fillBox(0, 0, 0, 31, 4, 31, 2) // flat floor, top at y=4
    const w = new WaterSim(world)
    for (let y = 5; y <= 12; y++) w.addWater(16, y, 16, MAX_LEVEL) // 8-cell column
    settle(w, 3000)

    expect(w.totalMass()).toBe(8 * MAX_LEVEL)
    // every drop rests on the floor plane, spread over many columns
    let massAtRest = 0
    const wet: Array<[number, number]> = []
    for (let x = 0; x < 32; x++) {
      for (let z = 0; z < 32; z++) {
        const l = w.levelAt(x, 5, z)
        massAtRest += l
        if (l > 0) wet.push([x, z])
        expect(w.levelAt(x, 6, z)).toBe(0) // nothing stacked above the sheet
      }
    }
    expect(massAtRest).toBe(8 * MAX_LEVEL)
    expect(wet.length).toBeGreaterThan(10) // actually spread out, not a single column
    // equilibrium: no adjacent pair differs by more than the settle deadband —
    // anything steeper still flowing means the surface never went flat
    for (const [x, z] of wet) {
      const l = w.levelAt(x, 5, z)
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        expect(Math.abs(l - w.levelAt(x + dx, 5, z + dz))).toBeLessThanOrEqual(SURFACE_DEADBAND)
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

  it('drains through a floor breach with an exit path (edge of an elevated tank)', () => {
    // elevated tank over a walled yard: plate at y9 spanning (11..20)², rim
    // walls y10..14, open air beneath the plate down to the yard floor (y4).
    // Single-span-per-column fidelity limits (rules.ts): water cannot travel
    // UNDER columns that still hold pool water above, so an interior pinhole
    // only relocates/equalizes the breached columns (level dips). A breach at
    // the basin EDGE has an under-rim exit column — that one must fully
    // drain, which is what this asserts.
    const world = new ChunkStore()
    world.fillBox(0, 0, 0, 31, 4, 31, 2) // yard floor
    world.fillBox(0, 5, 0, 31, 8, 0, 2) // yard containment walls
    world.fillBox(0, 5, 31, 31, 8, 31, 2)
    world.fillBox(0, 5, 0, 0, 8, 31, 2)
    world.fillBox(31, 5, 0, 31, 8, 31, 2)
    world.fillBox(11, 9, 11, 20, 9, 20, 2) // tank plate
    world.fillBox(11, 10, 11, 20, 14, 20, 2) // rim block…
    world.fillBox(12, 10, 12, 19, 14, 19, 0) // …carved to a basin
    const w = new WaterSim(world)
    world.onVoxelChanged = (x, y, z) => w.notifyVoxelChanged(x, y, z)
    let poured = 0
    for (let x = 12; x <= 19; x++)
      for (let z = 12; z <= 19; z++) {
        poured += w.addWater(x, 10, z, MAX_LEVEL)
      }
    settle(w, 3000)
    expect(w.totalMass()).toBe(poured)

    // blow a 2×2 hole in the plate at the basin edge (next to the rim) —
    // the edit-op contract: plain setVoxel, ChunkStore hook does the waking
    expect(w.activeChunkCount).toBe(0) // asleep before the breach
    for (const [hx, hz] of [[12, 15], [12, 16], [13, 15], [13, 16]] as const) world.setVoxel(hx, 9, hz, 0)
    expect(w.activeChunkCount).toBeGreaterThan(0) // hook did the waking
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
    // nearly everything drained to the yard; only residue films remain
    expect(below).toBeGreaterThan(poured * 0.9)
    expect(above).toBeLessThanOrEqual(poured * 0.05)
  })
})

describe('water columns — source/sink API (T15)', () => {
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

  it('a solid placed mid-span keeps the surface and reports everything below it (V9 sink accounting)', () => {
    const world = new ChunkStore()
    world.fillBox(0, 0, 0, 31, 4, 31, 2)
    const w = new WaterSim(world)
    // 3-deep column y5..7
    for (let y = 5; y <= 7; y++) w.addWater(5, y, 5, MAX_LEVEL)
    world.setVoxel(5, 5, 5, 7) // block at the span bottom
    // single-span model: water below/at the block is released and REPORTED —
    // mass may only ever decrease via this reported sink, never silently
    const displaced = w.notifyVoxelChanged(5, 5, 5)
    expect(displaced).toBe(MAX_LEVEL)
    expect(w.totalMass()).toBe(3 * MAX_LEVEL - displaced)
    expect(w.levelAt(5, 5, 5)).toBe(0) // solid cell holds no water
    expect(w.levelAt(5, 6, 5)).toBe(MAX_LEVEL) // surface part kept
    expect(w.levelAt(5, 7, 5)).toBe(MAX_LEVEL)
  })
})
