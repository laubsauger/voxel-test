import { describe, expect, it } from 'vitest'
import { VOXEL_SIZE } from '../src/world/chunks'
import { MAX_LEVEL } from '../src/sim/water/rules'
import {
  FRESH_WATER_DENSITY,
  STANDARD_GRAVITY,
  computeBuoyancy,
  type BuoyancyBody,
  type WaterLevelSampler,
} from '../src/sim/water/buoyancy'
import { ChunkStore } from '../src/world/chunks'
import { WaterSim } from '../src/sim/water/water-sim'

// T17 — buoyancy is the sim-side half of the water↔physics coupling. It must
// be a pure function of (water field, body descriptor): submerged fraction
// scales the lift, offset submersion produces righting torque, drag opposes
// motion. The physics track applies the result to Jolt bodies unchanged, so
// wrong numbers here mean wood that sinks or catapults.

/** synthetic field: everything below waterY is full, else dry */
const flatWater =
  (waterY: number): WaterLevelSampler =>
  (_x, y) =>
    y < waterY ? MAX_LEVEL : 0

const still = { x: 0, y: 0, z: 0 }

function boxBody(cx: number, cy: number, cz: number): BuoyancyBody {
  // 2×2×2 voxel cube of sample points centered on (cx, cy, cz), meters
  const samples = []
  for (const dx of [-0.5, 0.5])
    for (const dy of [-0.5, 0.5])
      for (const dz of [-0.5, 0.5]) {
        samples.push({ x: cx + dx * VOXEL_SIZE, y: cy + dy * VOXEL_SIZE, z: cz + dz * VOXEL_SIZE })
      }
  return {
    samples,
    sampleVolume: VOXEL_SIZE ** 3,
    centerOfMass: { x: cx, y: cy, z: cz },
    velocity: { ...still },
  }
}

describe('computeBuoyancy (T17)', () => {
  it('fully submerged: lift = ρ·V·g, no torque for a symmetric body', () => {
    const body = boxBody(1.0, 0.5, 1.0)
    const r = computeBuoyancy(flatWater(100), body)
    const totalVolume = 8 * VOXEL_SIZE ** 3
    expect(r.force.y).toBeCloseTo(FRESH_WATER_DENSITY * STANDARD_GRAVITY * totalVolume, 9)
    expect(r.force.x).toBe(0)
    expect(r.force.z).toBe(0)
    expect(r.torque.x).toBeCloseTo(0, 9)
    expect(r.torque.z).toBeCloseTo(0, 9)
    expect(r.submergedFraction).toBe(1)
  })

  it('half submerged: half the lift (submerged fraction → force)', () => {
    // waterline slices the cube between its lower and upper sample rows
    const waterYVox = 10
    const body = boxBody(1.0, waterYVox * VOXEL_SIZE, 1.0)
    const r = computeBuoyancy(flatWater(waterYVox), body)
    const totalVolume = 8 * VOXEL_SIZE ** 3
    expect(r.force.y).toBeCloseTo((FRESH_WATER_DENSITY * STANDARD_GRAVITY * totalVolume) / 2, 9)
    expect(r.submergedFraction).toBeCloseTo(0.5, 9)
  })

  it('dry body: zero everything', () => {
    const r = computeBuoyancy(flatWater(0), boxBody(1, 5, 1))
    expect(r.force).toEqual({ x: 0, y: 0, z: 0 })
    expect(r.torque).toEqual({ x: 0, y: 0, z: 0 })
    expect(r.submergedFraction).toBe(0)
  })

  it('asymmetric submersion produces righting torque', () => {
    // only samples at x < 1.0 m are in water → lift acts left of COM →
    // torque about z must be negative (r × F with r=-x̂, F=+ŷ)
    const halfWater: WaterLevelSampler = (x, _y) => (x < 10 ? MAX_LEVEL : 0)
    const r = computeBuoyancy(halfWater, boxBody(1.0, 0.5, 1.0))
    expect(r.force.y).toBeGreaterThan(0)
    expect(r.torque.z).toBeLessThan(0)
    expect(Math.abs(r.torque.x)).toBeLessThan(1e-12) // no roll about x
  })

  it('drag opposes velocity, scaled by submersion', () => {
    const body = { ...boxBody(1.0, 0.5, 1.0), velocity: { x: 2, y: 0, z: -1 } }
    const wet = computeBuoyancy(flatWater(100), body)
    expect(wet.force.x).toBeLessThan(0)
    expect(wet.force.z).toBeGreaterThan(0)
    expect(wet.force.x / wet.force.z).toBeCloseTo(-2, 9) // proportional to velocity
    const dry = computeBuoyancy(flatWater(0), body)
    expect(dry.force.x).toBe(0) // no drag out of water
  })

  it('partial cell water levels give partial lift', () => {
    const half: WaterLevelSampler = () => 128
    const full: WaterLevelSampler = () => MAX_LEVEL
    const body = boxBody(1, 0.5, 1)
    const a = computeBuoyancy(half, body)
    const b = computeBuoyancy(full, body)
    expect(a.force.y / b.force.y).toBeCloseTo(128 / MAX_LEVEL, 9)
  })

  it('samples straight from a real WaterSim field (integration shape)', () => {
    const world = new ChunkStore()
    world.fillBox(0, 0, 0, 31, 4, 31, 2)
    const w = new WaterSim(world)
    for (let x = 10; x <= 20; x++) for (let z = 10; z <= 20; z++) w.addWater(x, 5, z, MAX_LEVEL)
    // WaterSim.levelAt is directly usable as the sampler
    const body = boxBody(15 * VOXEL_SIZE, 5.5 * VOXEL_SIZE, 15 * VOXEL_SIZE)
    const r = computeBuoyancy((x, y, z) => w.levelAt(x, y, z), body)
    expect(r.force.y).toBeGreaterThan(0)
    expect(r.submergedFraction).toBeGreaterThan(0)
  })

  it('is pure: does not mutate the body descriptor', () => {
    const body = boxBody(1, 0.5, 1)
    const snapshot = JSON.parse(JSON.stringify(body))
    computeBuoyancy(flatWater(100), body)
    expect(body).toEqual(snapshot)
  })
})
