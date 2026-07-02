import { describe, expect, it } from 'vitest'
import { ChunkStore } from '../src/world/chunks'
import { WaterSim } from '../src/sim/water/water-sim'
import { DonorMode, LATERAL_DEADBAND, MAX_LEVEL, lateralNext } from '../src/sim/water/rules'

// T62/B21 — the pool-never-drains regression, reproduced LIVE-style: a
// world-scale pool crossing a chunk border, filled and fully SETTLED
// (sleeping enabled — the wake/active-set machinery is part of the system
// under test), then breached through one wall via plain voxel edits wired
// through onVoxelChanged exactly like game.ts does. The original failure
// mode was not a mass leak: transport was pure half-diff diffusion and
// diff-2 residue ramps sustained a bucket-brigade trickle for O(area)
// steps, so the breach "ran forever" while the basin level barely moved and
// the sim never slept (which also rebuilt the surface mesh every frame —
// B20 flicker). These assertions pin all three fixes: drain RATE
// (waterfall leg), guaranteed SETTLE (lateral deadband), and V9 mass
// exactness throughout.

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
  it('drains fast, conserves mass exactly, and fully settles', { timeout: 60000 }, () => {
    const { world, w, poured, basinSum } = buildBreachScenario()

    // pool settles and SLEEPS before the breach (live pools are asleep)
    for (let i = 0; i < 200 && w.activeChunkCount > 0; i++) w.step()
    expect(w.activeChunkCount).toBe(0)
    expect(basinSum()).toBe(poured)

    // breach the west wall full height — plain edits, hook does the waking
    for (let y = 8; y <= 12; y++)
      for (let z = 14; z <= 17; z++) world.setVoxel(25, y, z, 0)
    expect(w.activeChunkCount).toBeGreaterThan(0)

    // drain RATE: the level must move on gameplay timescales, not just
    // asymptotically. (Pre-fix: >60% left at 2000 steps and still trickling.)
    let prev = poured
    let settledAt = -1
    for (let step = 1; step <= 12000; step++) {
      w.step()
      if (step === 500 || step === 2000) {
        expect(w.totalMass(), `mass drifted by step ${step}`).toBe(poured)
        const b = basinSum()
        expect(b, `basin did not drain by step ${step}`).toBeLessThan(prev)
        expect(b / poured).toBeLessThan(step === 500 ? 0.5 : 0.3)
        prev = b
      }
      if (w.activeChunkCount === 0) {
        settledAt = step
        break
      }
    }

    // guaranteed settle (the deadband): no endless bucket-brigade trickle
    expect(settledAt, 'water never settled after the breach').toBeGreaterThan(0)
    // near-empty basin: only sub-voxel residue films remain
    expect(basinSum() / poured).toBeLessThan(0.25)
    // V9: every drop that left the basin still exists somewhere in the yard
    expect(w.totalMass()).toBe(poured)
  })
})

describe('T62 — lateral rule legs (rules.ts contract)', () => {
  it('lateralNext is pairwise mass-exact for every mode/level combination', () => {
    const levels = [0, 1, 2, 3, 4, 5, 17, 100, 127, 128, 254, 255]
    const modes = [DonorMode.Falling, DonorMode.Splashing, DonorMode.Supported]
    for (const a of levels)
      for (const b of levels)
        for (const mode of modes)
          for (const ru of [false, true]) {
            const na = lateralNext(a, b, mode, ru)
            const nb = lateralNext(b, a, mode, ru)
            expect(na + nb, `mass broke for (${a},${b},${mode},${ru})`).toBe(a + b)
            expect(na).toBeGreaterThanOrEqual(0)
            expect(na).toBeLessThanOrEqual(MAX_LEVEL)
          }
  })

  it('supported deadband: small differences are a fixpoint, larger ones flow', () => {
    expect(lateralNext(100, 100 - LATERAL_DEADBAND, DonorMode.Supported, false)).toBe(100)
    expect(lateralNext(100, 100 - LATERAL_DEADBAND - 1, DonorMode.Supported, false)).not.toBe(100)
  })

  it('waterfall leg: an empty falling receiver takes everything from a supported donor', () => {
    expect(lateralNext(200, 0, DonorMode.Supported, true)).toBe(0)
    expect(lateralNext(0, 200, DonorMode.Supported, true)).toBe(200)
    // receiver on solid ground: normal equalization instead
    expect(lateralNext(200, 0, DonorMode.Supported, false)).toBe(100)
    // even sub-deadband residue rolls over a ledge (no stranded films at lips)
    expect(lateralNext(2, 0, DonorMode.Supported, true)).toBe(0)
  })

  it('splashing donor spills a quarter of the difference; falling donor holds', () => {
    expect(lateralNext(100, 0, DonorMode.Splashing, false)).toBe(75)
    expect(lateralNext(0, 100, DonorMode.Splashing, false)).toBe(25)
    expect(lateralNext(3, 0, DonorMode.Splashing, false)).toBe(3) // diff>>2 == 0
    expect(lateralNext(255, 0, DonorMode.Falling, false)).toBe(255)
  })

  it('a column landing on rising water sloshes outward (rolling, not stacking)', () => {
    const world = new ChunkStore()
    world.fillBox(0, 0, 0, 31, 4, 31, 2) // floor at y=4
    const w = new WaterSim(world)
    // seed a shallow pool so the fall lands on partial water (splash regime)
    for (let x = 12; x <= 20; x++) for (let z = 12; z <= 20; z++) w.addWater(x, 5, z, 60)
    // heavy column pouring onto the center
    for (let y = 8; y <= 12; y++) w.addWater(16, y, 16, MAX_LEVEL)
    // within a few steps the impact cell's neighbors ABOVE the pool surface
    // must have received water sideways — pre-T62 the column could only
    // stack straight up (levels moved strictly vertically while falling)
    let sloshed = false
    for (let i = 0; i < 12 && !sloshed; i++) {
      w.step()
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        if (w.levelAt(16 + dx, 6, 16 + dz) > 0) sloshed = true
      }
    }
    expect(sloshed, 'falling column never spilled sideways at the impact').toBe(true)
    // and it still settles + conserves mass
    for (let i = 0; i < 4000 && w.activeChunkCount > 0; i++) w.step()
    expect(w.activeChunkCount).toBe(0)
    expect(w.totalMass()).toBe(9 * 9 * 60 + 5 * MAX_LEVEL)
  })
})
