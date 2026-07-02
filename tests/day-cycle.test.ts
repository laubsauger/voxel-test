/**
 * T58 — day/night cycle math. These tests encode the WHY of the cycle:
 * time must derive deterministically from the sim tick (V2/V6: same tick ⇒
 * same sky on every lockstep peer), the default boot look must stay the
 * golden afternoon the smoke gate screenshots, and the sun→moon shadow-light
 * handoff must be invisible (intensity ≈ 0 while the direction snaps).
 */
import { describe, expect, it } from 'vitest'
import { DayCycle, computeCycleState, createCycleState } from '../src/render/atmosphere'

describe('DayCycle time source', () => {
  it('defaults to 15:00 golden afternoon at tick 0 (smoke-gate look)', () => {
    expect(new DayCycle().hoursAt(0)).toBe(15)
  })

  it('derives time deterministically from tick (lockstep peers agree)', () => {
    const a = new DayCycle()
    const b = new DayCycle()
    for (const tick of [0, 1, 999, 123456]) {
      expect(a.hoursAt(tick)).toBe(b.hoursAt(tick))
    }
  })

  it('completes a 24h day in cycleLengthSec of sim time and wraps', () => {
    const c = new DayCycle()
    const fullDayTicks = c.cycleLengthSec * 60 // 60 Hz sim
    expect(c.hoursAt(fullDayTicks)).toBeCloseTo(c.hoursAt(0), 10)
    // default: 20 min per day
    expect(c.cycleLengthSec).toBe(1200)
  })

  it('override freezes the clock regardless of tick (dev fixed-time)', () => {
    const c = new DayCycle()
    c.overrideHours = 23.5
    expect(c.hoursAt(0)).toBe(23.5)
    expect(c.hoursAt(1e6)).toBe(23.5)
  })
})

describe('computeCycleState', () => {
  const state = createCycleState()

  it('noon sun is high, midnight sun is down and moon is up', () => {
    computeCycleState(12, state)
    expect(state.sunDir.y).toBeGreaterThan(0.8) // 90° − 32° tilt
    expect(state.moonIsLight).toBe(false)
    computeCycleState(0, state)
    expect(state.sunDir.y).toBeLessThan(-0.8)
    expect(state.moonDir.y).toBeGreaterThan(0.2)
    expect(state.moonIsLight).toBe(true)
  })

  it('sun→moon shadow handoff happens while the light is ~dark (no visible snap)', () => {
    let prevMoon = computeCycleState(0, state).moonIsLight
    let prevI = state.lightIntensity
    for (let h = 0.01; h < 24; h += 0.01) {
      computeCycleState(h, state)
      if (state.moonIsLight !== prevMoon) {
        // both sides of the swap must be dim enough that the direction jump
        // cannot read as a shadow pop
        expect(prevI).toBeLessThan(0.2)
        expect(state.lightIntensity).toBeLessThan(0.2)
      }
      prevMoon = state.moonIsLight
      prevI = state.lightIntensity
    }
  })

  it('night dims ambient, boosts lamps + exposure; day restores baseline', () => {
    computeCycleState(1, state) // deep night
    expect(state.hemiIntensity).toBeLessThan(0.2)
    expect(state.lampBoost).toBeGreaterThan(2.5)
    expect(state.exposure).toBeGreaterThan(1.2)
    expect(state.starVis).toBe(1)
    computeCycleState(12, state) // noon
    expect(state.hemiIntensity).toBeGreaterThan(0.9)
    expect(state.lampBoost).toBe(1)
    expect(state.exposure).toBe(1)
    expect(state.starVis).toBe(0)
  })

  it('palette and light evolve continuously (no pops across the whole day)', () => {
    const prev = createCycleState()
    computeCycleState(0, prev)
    for (let h = 0.01; h < 24.001; h += 0.01) {
      computeCycleState(h, state)
      // any sky channel jumping >0.05 per 36 sim-seconds would read as a pop
      for (const key of ['zenith', 'horizon', 'horizonWarm', 'ground'] as const) {
        expect(Math.abs(state[key].r - prev[key].r)).toBeLessThan(0.05)
        expect(Math.abs(state[key].g - prev[key].g)).toBeLessThan(0.05)
        expect(Math.abs(state[key].b - prev[key].b)).toBeLessThan(0.05)
      }
      expect(Math.abs(state.lightIntensity - prev.lightIntensity)).toBeLessThan(0.12)
      expect(Math.abs(state.exposure - prev.exposure)).toBeLessThan(0.02)
      computeCycleState(h, prev)
    }
  })

  it('15:00 default matches the pre-T58 static sun direction (~(85,62,38))', () => {
    computeCycleState(15, state)
    const legacy = { x: 85, y: 62, z: 38 }
    const len = Math.hypot(legacy.x, legacy.y, legacy.z)
    const dot =
      (state.sunDir.x * legacy.x + state.sunDir.y * legacy.y + state.sunDir.z * legacy.z) / len
    expect(dot).toBeGreaterThan(0.98) // within ~11°
  })
})
