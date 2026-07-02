/**
 * T17 — buoyancy coupling, sim side. Pure function: water field + body
 * descriptor → force/torque. No Jolt types here — the physics track applies
 * the result through a thin adapter (see INTEGRATION-water.md for the exact
 * interface expected from a body).
 *
 * Model: the physics adapter distributes sample points over the body's
 * voxels (typically one per voxel or per 2×2×2 block), each representing
 * `sampleVolume` m³. A sample's submerged fraction is the water level of the
 * cell it falls in (level/255): archimedes lift = fraction · volume · ρ · g
 * upward, plus a linear drag term opposing the velocity of the sample point,
 * scaled by the same submerged fraction. Torque is accumulated about the
 * center of mass from per-sample forces.
 *
 * Floats are fine here (V4 constrains the GPU CA, not this): the inputs are
 * integer water levels and the arithmetic is plain IEEE-754 double ops,
 * deterministic across peers.
 */

import { VOXEL_SIZE } from '../../world/chunks'
import { MAX_LEVEL } from './rules'

export interface Vec3 {
  x: number
  y: number
  z: number
}

/** samples water level 0..255 at integer voxel coords — WaterSim.levelAt fits */
export type WaterLevelSampler = (vx: number, vy: number, vz: number) => number

/**
 * What the buoyancy solver needs from a floating body. The physics track owns
 * the real body; it builds this descriptor per tick from the body transform.
 */
export interface BuoyancyBody {
  /** world-space sample points, meters (voxel centers of the body's occupied cells) */
  samples: readonly Vec3[]
  /** volume represented by each sample, m³ */
  sampleVolume: number
  /** center of mass, world meters — torque reference */
  centerOfMass: Vec3
  /** linear velocity of the body at the COM, m/s (used for drag) */
  velocity: Vec3
}

export interface BuoyancyOptions {
  /** fluid density kg/m³ */
  fluidDensity?: number
  /** gravitational acceleration m/s² (positive number, lift acts +y) */
  gravity?: number
  /** linear drag coefficient, N·s/m per m³ of submerged volume */
  linearDrag?: number
}

export interface BuoyancyResult {
  /** net force, N — apply at the center of mass */
  force: Vec3
  /** net torque about the center of mass, N·m */
  torque: Vec3
  /** 0..1, submerged volume / total sample volume — handy for damping/audio */
  submergedFraction: number
}

export const FRESH_WATER_DENSITY = 1000
export const STANDARD_GRAVITY = 9.81

/**
 * Pure: no allocation of sim state, no mutation of inputs, deterministic.
 * Returns zero force/torque for a body entirely out of water.
 */
export function computeBuoyancy(
  waterLevelAt: WaterLevelSampler,
  body: BuoyancyBody,
  opts: BuoyancyOptions = {},
): BuoyancyResult {
  const rho = opts.fluidDensity ?? FRESH_WATER_DENSITY
  const g = opts.gravity ?? STANDARD_GRAVITY
  const drag = opts.linearDrag ?? 60

  let fx = 0
  let fy = 0
  let fz = 0
  let tx = 0
  let ty = 0
  let tz = 0
  let submerged = 0

  for (const p of body.samples) {
    const vx = Math.floor(p.x / VOXEL_SIZE)
    const vy = Math.floor(p.y / VOXEL_SIZE)
    const vz = Math.floor(p.z / VOXEL_SIZE)
    const fraction = waterLevelAt(vx, vy, vz) / MAX_LEVEL
    if (fraction === 0) continue
    submerged += fraction

    // Archimedes: displaced fluid weight, straight up
    const lift = fraction * body.sampleVolume * rho * g
    // linear drag opposing body velocity, scaled by submerged volume at this sample
    const dragScale = -drag * fraction * body.sampleVolume
    const sfx = dragScale * body.velocity.x
    const sfy = lift + dragScale * body.velocity.y
    const sfz = dragScale * body.velocity.z

    fx += sfx
    fy += sfy
    fz += sfz

    // torque about COM: r × F
    const rx = p.x - body.centerOfMass.x
    const ry = p.y - body.centerOfMass.y
    const rz = p.z - body.centerOfMass.z
    tx += ry * sfz - rz * sfy
    ty += rz * sfx - rx * sfz
    tz += rx * sfy - ry * sfx
  }

  return {
    force: { x: fx, y: fy, z: fz },
    torque: { x: tx, y: ty, z: tz },
    submergedFraction: body.samples.length > 0 ? submerged / body.samples.length : 0,
  }
}
