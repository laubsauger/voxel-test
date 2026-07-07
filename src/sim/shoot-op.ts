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
import { damagePlayerHp, damagePlayersSphere, raycastPlayers } from './player'
import { MAT_FLESH } from './materials'
import type { IPhysicsWorld } from './iphysics'

/** max hitscan range, voxels (= 120 m) */
export const SHOOT_RANGE_VOX = 1200
/** destruction radius at the impact point, voxels */
export const SHOOT_RADIUS = 1.5
/** destruction power — kills soft materials (strength ≤ 3 near center), dents nothing structural */
export const SHOOT_POWER = 3
/** B17 — impulse (kg·m/s) a shot puts into a hit dynamic body */
export const SHOOT_BODY_IMPULSE = 120
/** player combat — hp per direct hit, default weapon: the hotbar gun is an
 *  auto rifle/MG (160 ms cooldown in src/ui/tools.ts) */
export const SHOOT_DMG_MG = 12
/** player combat — hp per direct hit for a slower pistol-class shot (senders
 *  put it in ShootOp.dmg; no hotbar weapon uses it yet) */
export const SHOOT_DMG_PISTOL = 20

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
export function registerShootOp(sim: Sim, phys: IPhysicsWorld): void {
  sim.onOp('shoot', (s, cmd) => {
    // player combat — dead players ignore input ops (no shooting from a corpse)
    const shooter = phys.players.get(cmd.playerId)
    if (shooter && !shooter.alive) return
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

    // player combat — deterministic ray vs player capsules (pure TS math, NOT
    // a Jolt query), capped at the world hit: a player strictly in front of
    // the voxel surface absorbs the shot INSTEAD of the world edit. Dead
    // players neither take damage nor block shots (raycastPlayers skips them).
    const worldLenM = (hit ? hit.dist : SHOOT_RANGE_VOX) * VOXEL_SIZE
    const playerHit = raycastPlayers(phys, ox, oy, oz, nx, ny, nz, worldLenM, cmd.playerId)

    // B17 — the ray also tests Jolt dynamic bodies (vehicle wrecks). Those are
    // DETERMINISTIC sim state, so a wreck hit may gate the world edit exactly as
    // before. Ray length is capped at the nearest deterministic surface (world
    // hit, or the player in front of it), so a returned body hit is strictly
    // in front of both.
    const rayLenM = playerHit ? playerHit.dist : worldLenM
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

    // T86/V17b — LOCAL debris hit. Emits the impact FX event (spark/tracer stop
    // at the rubble — events are render-only, V6, so divergent FX are fine) and
    // damages/impulses the piece. World-edit gating splits by mode:
    //   SP (sim.lockstep=false): rubble OCCLUDES the shot — no wall marking
    //     behind it (old feel). Safe: no peers to diverge from.
    //   MP (lockstep=true on every peer): the deterministic world edit still
    //     applies — local debris may never gate a hashed world mutation (V17b).
    const debrisHit = phys.castRayDebris?.(ox, oy, oz, nx, ny, nz, rayLenM)
    if (debrisHit) {
      s.emit({
        kind: 'shot',
        ox, oy, oz,
        dx: nx, dy: ny, dz: nz,
        hit: 1,
        x: debrisHit.px, y: debrisHit.py, z: debrisHit.pz,
        nx: debrisHit.nx, ny: debrisHit.ny, nz: debrisHit.nz,
        mat: debrisHit.body.mat,
      })
      phys.impulseBodyAt(
        debrisHit.body,
        nx * SHOOT_BODY_IMPULSE, ny * SHOOT_BODY_IMPULSE, nz * SHOOT_BODY_IMPULSE,
        debrisHit.px, debrisHit.py, debrisHit.pz,
      )
      phys.damageBodySphere(
        debrisHit.body,
        debrisHit.px + nx * VOXEL_SIZE * 0.6,
        debrisHit.py + ny * VOXEL_SIZE * 0.6,
        debrisHit.pz + nz * VOXEL_SIZE * 0.6,
        SHOOT_RADIUS * VOXEL_SIZE,
        SHOOT_POWER,
        true,
      )
      if (!s.lockstep) return // SP: rubble blocks the shot entirely
    }

    // player combat — direct player hit: weapon damage INSTEAD of the world
    // edit (the bullet stopped in the player). This is a DETERMINISTIC
    // decision (V17b): local debris may occlude it in SP only (the
    // `!s.lockstep` return above), never in MP.
    if (playerHit) {
      const dmg = cmd.op.dmg ?? SHOOT_DMG_MG
      if (!debrisHit) {
        // one impact FX per shot — same rule as the world path below
        s.emit({
          kind: 'shot',
          ox, oy, oz,
          dx: nx, dy: ny, dz: nz,
          hit: 1,
          x: playerHit.px, y: playerHit.py, z: playerHit.pz,
          nx: -nx, ny: -ny, nz: -nz,
          mat: MAT_FLESH,
        })
      }
      // T22 — carve the victim's segmented voxel body at the entry point
      // (nudged into the capsule along the ray, same rule as the body paths)
      damagePlayersSphere(
        phys,
        (playerHit.px + nx * VOXEL_SIZE * 0.6) / VOXEL_SIZE,
        (playerHit.py + ny * VOXEL_SIZE * 0.6) / VOXEL_SIZE,
        (playerHit.pz + nz * VOXEL_SIZE * 0.6) / VOXEL_SIZE,
        SHOOT_RADIUS,
        SHOOT_POWER,
      )
      damagePlayerHp(s, phys, playerHit.player, dmg, cmd.playerId)
      return
    }

    if (!hit) {
      if (debrisHit) return // spark already emitted at the rubble

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
    if (!debrisHit) {
      // one impact FX per shot — when rubble sparked (MP fall-through), the
      // world edit below still applies but silently (no second tracer/impact)
      s.emit({
        kind: 'shot',
        ox, oy, oz,
        dx: nx, dy: ny, dz: nz,
        hit: 1,
        x: cx * VOXEL_SIZE, y: cy * VOXEL_SIZE, z: cz * VOXEL_SIZE,
        nx: hit.nx, ny: hit.ny, nz: hit.nz,
        mat: hit.mat,
      })
    }
    destroySphere(s, cx, cy, cz, SHOOT_RADIUS, SHOOT_POWER)
    damagePlayersSphere(phys, cx, cy, cz, SHOOT_RADIUS, SHOOT_POWER)
    // same connectivity/island path explode uses (T11/T12)
    phys.structuralPass(s)
  })
}
