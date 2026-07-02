/**
 * T28 — 'shoot' op handler (I.cmd) + canonical DDA voxel raycaster.
 *
 * Hitscan: DDA through sim.world from origin along dir (both in the op,
 * meters), then a small strength-scaled destroySphere at the hit voxel and
 * the same connectivity path explode uses (phys.structuralPass). Player
 * segments in the blast radius take damage via damagePlayersSphere.
 *
 * Deterministic (V2): pure integer/float math from sim state only — no
 * randomness, no clocks. Registered by the boot module after createPhysics.
 * The DDA is exported for the render-layer tool raycaster (src/ui/raycast.ts)
 * so both layers march the exact same grid traversal.
 */
import type { Sim } from './loop'
import { VOXEL_SIZE } from '../world/chunks'
import { destroySphere } from './destruction'
import { damagePlayersSphere } from './player'
import type { PhysicsWorld } from './physics'

/** max hitscan range, voxels (= 120 m) */
export const SHOOT_RANGE_VOX = 1200
/** destruction radius at the impact point, voxels */
export const SHOOT_RADIUS = 1.5
/** destruction power — kills soft materials (strength ≤ 3 near center), dents nothing structural */
export const SHOOT_POWER = 3
/** B17 — impulse (kg·m/s) a shot puts into a hit dynamic body */
export const SHOOT_BODY_IMPULSE = 120

export interface VoxelHit {
  /** hit voxel coords (integer) */
  x: number
  y: number
  z: number
  /** material id at the hit voxel */
  mat: number
  /** distance along the ray, in the ray's own units */
  dist: number
  /** face normal the ray entered through (axis-aligned; 0,0,0 if origin voxel was solid) */
  nx: number
  ny: number
  nz: number
}

interface VoxelSource {
  getVoxel(x: number, y: number, z: number): number
}

/**
 * Amanatides & Woo DDA through the voxel grid. Origin and maxDist are in
 * voxel units (world meters / VOXEL_SIZE); dir need not be normalized but
 * must be non-zero. Returns the first non-air voxel or null.
 */
export function ddaRaycast(
  world: VoxelSource,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number,
): VoxelHit | null {
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
  if (len === 0) return null
  dx /= len
  dy /= len
  dz /= len

  let vx = Math.floor(ox)
  let vy = Math.floor(oy)
  let vz = Math.floor(oz)

  const startMat = world.getVoxel(vx, vy, vz)
  if (startMat !== 0) return { x: vx, y: vy, z: vz, mat: startMat, dist: 0, nx: 0, ny: 0, nz: 0 }

  const stepX = dx > 0 ? 1 : -1
  const stepY = dy > 0 ? 1 : -1
  const stepZ = dz > 0 ? 1 : -1
  // distance along the ray per one-voxel move on each axis
  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity
  const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity
  // distance to the first boundary crossing on each axis
  let tMaxX = dx !== 0 ? (dx > 0 ? vx + 1 - ox : ox - vx) * tDeltaX : Infinity
  let tMaxY = dy !== 0 ? (dy > 0 ? vy + 1 - oy : oy - vy) * tDeltaY : Infinity
  let tMaxZ = dz !== 0 ? (dz > 0 ? vz + 1 - oz : oz - vz) * tDeltaZ : Infinity

  let t = 0
  let nx = 0
  let ny = 0
  let nz = 0
  while (t <= maxDist) {
    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
      t = tMaxX
      tMaxX += tDeltaX
      vx += stepX
      nx = -stepX
      ny = 0
      nz = 0
    } else if (tMaxY <= tMaxZ) {
      t = tMaxY
      tMaxY += tDeltaY
      vy += stepY
      nx = 0
      ny = -stepY
      nz = 0
    } else {
      t = tMaxZ
      tMaxZ += tDeltaZ
      vz += stepZ
      nx = 0
      ny = 0
      nz = -stepZ
    }
    if (t > maxDist) return null
    const mat = world.getVoxel(vx, vy, vz)
    if (mat !== 0) return { x: vx, y: vy, z: vz, mat, dist: t, nx, ny, nz }
  }
  return null
}

/** Register the 'shoot' handler. Call after createPhysics (needs structuralPass). */
export function registerShootOp(sim: Sim, phys: PhysicsWorld): void {
  sim.onOp('shoot', (s, cmd) => {
    const { ox, oy, oz, dx, dy, dz } = cmd.op
    const hit = ddaRaycast(
      s.world,
      ox / VOXEL_SIZE,
      oy / VOXEL_SIZE,
      oz / VOXEL_SIZE,
      dx,
      dy,
      dz,
      SHOOT_RANGE_VOX,
    )
    // T53 — shot event for render FX (tracer/muzzle/impact); see events.ts
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1
    const nx = dx / len, ny = dy / len, nz = dz / len

    // B17 — the ray also tests dynamic island bodies; nearest hit wins.
    // Ray length is capped at the world hit, so a returned body hit is
    // strictly in front of any voxel surface.
    const rayLenM = (hit ? hit.dist : SHOOT_RANGE_VOX) * VOXEL_SIZE
    const bodyHit = phys.castRayBody(ox, oy, oz, nx, ny, nz, rayLenM)
    if (bodyHit) {
      s.emit({
        kind: 'shot',
        ox, oy, oz,
        dx: nx, dy: ny, dz: nz,
        hit: 1,
        x: bodyHit.px, y: bodyHit.py, z: bodyHit.pz,
        nx: bodyHit.nx, ny: bodyHit.ny, nz: bodyHit.nz,
        mat: bodyHit.body.mat,
      })
      phys.impulseBodyAt(
        bodyHit.body,
        nx * SHOOT_BODY_IMPULSE, ny * SHOOT_BODY_IMPULSE, nz * SHOOT_BODY_IMPULSE,
        bodyHit.px, bodyHit.py, bodyHit.pz,
      )
      // damage center: nudged INTO the entered voxel along the ray, then
      // snapped to that voxel's center (same rule as the world path — a
      // sphere centered on the surface point would only graze the grid)
      phys.damageBodySphere(
        bodyHit.body,
        bodyHit.px + nx * VOXEL_SIZE * 0.6,
        bodyHit.py + ny * VOXEL_SIZE * 0.6,
        bodyHit.pz + nz * VOXEL_SIZE * 0.6,
        SHOOT_RADIUS * VOXEL_SIZE,
        SHOOT_POWER,
        true,
      )
      return
    }

    if (!hit) {
      const range = SHOOT_RANGE_VOX * VOXEL_SIZE
      s.emit({
        kind: 'shot',
        ox, oy, oz,
        dx: nx, dy: ny, dz: nz,
        hit: 0,
        x: ox + nx * range, y: oy + ny * range, z: oz + nz * range,
        nx: 0, ny: 0, nz: 0,
        mat: 0,
      })
      return
    }
    const cx = hit.x + 0.5
    const cy = hit.y + 0.5
    const cz = hit.z + 0.5
    s.emit({
      kind: 'shot',
      ox, oy, oz,
      dx: nx, dy: ny, dz: nz,
      hit: 1,
      x: cx * VOXEL_SIZE, y: cy * VOXEL_SIZE, z: cz * VOXEL_SIZE,
      nx: hit.nx, ny: hit.ny, nz: hit.nz,
      mat: hit.mat,
    })
    destroySphere(s, cx, cy, cz, SHOOT_RADIUS, SHOOT_POWER)
    damagePlayersSphere(phys, cx, cy, cz, SHOOT_RADIUS, SHOOT_POWER)
    // same connectivity/island path explode uses (T11/T12)
    phys.structuralPass(s)
  })
}
