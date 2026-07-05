import { describe, expect, it } from 'vitest'
import { Vector3 } from 'three/webgpu'
import {
  ALT_MAX,
  ALT_MIN,
  birdOffset,
  createFlocks,
  flockCenter,
  flockYaw,
  type BirdDef,
  type FlockDef,
} from '../src/render/birds'

// T74 — birds are a render-only cosmetic; these tests pin the PATH CONTRACT
// (altitude band, lazy speeds, orbit breathing, determinism) so a tuning
// tweak that silently breaks "circling over the town at 40–70 m" fails here.

const v = new Vector3()

describe('T74 bird flocks — layout contract', () => {
  it('is deterministic per seed (render salt, but stable across boots)', () => {
    const a = createFlocks(74)
    const b = createFlocks(74)
    expect(b).toEqual(a)
    // different seed actually changes the layout (PRNG is wired through)
    expect(createFlocks(75)).not.toEqual(a)
  })

  it('spawns 2-3 small flocks of 5-9 birds each', () => {
    const { flocks, birds } = createFlocks(74)
    expect(flocks.length).toBeGreaterThanOrEqual(2)
    expect(flocks.length).toBeLessThanOrEqual(3)
    expect(birds.length).toBe(flocks.length)
    for (const flock of birds) {
      expect(flock.length).toBeGreaterThanOrEqual(5)
      expect(flock.length).toBeLessThanOrEqual(9)
    }
  })

  it('every bird stays inside the 40-70 m altitude band at all times', () => {
    // worst case = flock bob extreme + bird slot + wander extreme; sample a
    // long window densely instead of trusting the analytic budget comment
    const { flocks, birds } = createFlocks(74)
    for (let fi = 0; fi < flocks.length; fi++) {
      for (const bird of birds[fi]) {
        for (let t = 0; t < 600; t += 0.7) {
          const y = flockCenter(t, flocks[fi], v).y + birdOffset(t, bird, v).y
          expect(y).toBeGreaterThanOrEqual(ALT_MIN)
          expect(y).toBeLessThanOrEqual(ALT_MAX)
        }
      }
    }
  })

  it('orbit radius breathes in and out without sweeping huge sky bands', () => {
    const { flocks } = createFlocks(74)
    for (const f of flocks) {
      let rMin = Infinity
      let rMax = -Infinity
      for (let t = 0; t < 400; t += 0.5) {
        flockCenter(t, f, v)
        const r = Math.hypot(v.x - f.centerX, v.z - f.centerZ)
        rMin = Math.min(rMin, r)
        rMax = Math.max(rMax, r)
      }
      // visible drift, but compact enough that birds don't smear across sky
      expect(rMax - rMin).toBeGreaterThan(20)
      expect(rMax - rMin).toBeLessThan(42)
      expect(rMin).toBeGreaterThan(5) // never spirals into the town center
    }
  })
})

describe('T74 bird path math', () => {
  const f: FlockDef = {
    centerX: 100,
    centerZ: 100,
    baseRadius: 60,
    radiusSwing: 0,
    driftSpeed: 0.05,
    driftPhase: 0,
    angSpeed: 0.1,
    angPhase: 0,
    altBase: 55,
    altSwing: 3,
    altSpeed: 0.07,
    altPhase: 0,
  }

  it('flockCenter orbits the flock center at the given radius', () => {
    for (const t of [0, 3, 17, 120]) {
      flockCenter(t, f, v)
      expect(Math.hypot(v.x - 100, v.z - 100)).toBeCloseTo(60, 6)
    }
  })

  it('paths are continuous — lazy motion, no teleports frame to frame', () => {
    const a = new Vector3()
    for (let t = 0; t < 60; t += 1 / 30) {
      flockCenter(t, f, a)
      flockCenter(t + 1 / 30, f, v)
      // 60 m radius @ 0.1 rad/s ⇒ ~6 m/s ⇒ ~0.2 m per 30 Hz frame
      expect(a.distanceTo(v)).toBeLessThan(0.5)
    }
  })

  it('flockYaw faces along the direction of travel (velocity tangent)', () => {
    const dt = 1e-4
    const a = new Vector3()
    for (const t of [0, 2, 9, 40]) {
      flockCenter(t, f, a)
      flockCenter(t + dt, f, v)
      const travelYaw = Math.atan2(v.x - a.x, v.z - a.z) // nose = +z
      expect(flockYaw(t, f)).toBeCloseTo(travelYaw, 3)
    }
    // reversed orbit direction flips the heading by ~pi
    const rev = { ...f, angSpeed: -f.angSpeed }
    const d = Math.abs(flockYaw(0, f) - flockYaw(0, rev))
    expect(Math.abs(d - Math.PI)).toBeLessThan(1e-6)
  })

  it('birdOffset wanders around the slot within its amplitudes', () => {
    const b: BirdDef = {
      ox: 4, oy: 1, oz: -3,
      wx: 2, wy: 0.5, wz: 1.5,
      sx: 0.3, sy: 0.4, sz: 0.35,
      px: 1, py: 2, pz: 3,
      scale: 1,
    }
    let moved = 0
    const first = birdOffset(0, b, new Vector3())
    for (let t = 0; t < 100; t += 0.5) {
      birdOffset(t, b, v)
      expect(Math.abs(v.x - b.ox)).toBeLessThanOrEqual(b.wx + 1e-9)
      expect(Math.abs(v.y - b.oy)).toBeLessThanOrEqual(b.wy + 1e-9)
      expect(Math.abs(v.z - b.oz)).toBeLessThanOrEqual(b.wz + 1e-9)
      moved = Math.max(moved, v.distanceTo(first))
    }
    expect(moved).toBeGreaterThan(1) // it actually wanders, not a static slot
  })
})
