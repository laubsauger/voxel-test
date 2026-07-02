/**
 * T54 [P] — bomb projectile entities. Spawned by the 'throw' op (I.cmd, V1),
 * integrated by a sim system registered in createPhysics (fixed order, V2):
 * point-mass gravity, DDA voxel collision with a small collision radius,
 * bounce (restitution 0.4, tangential damping), rest detection, 3s fuse
 * (BOMB_FUSE_TICKS) → runs the T55 zoned explosion wherever the bomb lies.
 *
 * Deterministic: pure math from sim state, no prng needed. Projectile state
 * lives in phys.projectiles (Map keyed by entity id, V8) and is folded into
 * hashPhysics (V3). Render draws them via src/render/projectile-meshes.ts
 * (reads the map, writes nothing — V6).
 */
import { DT, type Sim } from './loop'
import { VOXEL_SIZE } from '../world/chunks'
import { ddaRaycast } from './shoot-op'
import { BOMB_POWER, BOMB_RADIUS, runExplosion } from './destruction'
import { GRAVITY_Y, KILL_PLANE_Y, type PhysicsWorld } from './physics'

export interface Projectile {
  /** entity id via sim.allocEntityId() (V8) */
  id: number
  /** position, world meters */
  x: number
  y: number
  z: number
  /** velocity, m/s */
  vx: number
  vy: number
  vz: number
  /** ticks until detonation */
  fuse: number
  /** settled on a surface (render: no spin/trail) */
  resting: boolean
}

/** 3 s at 60 Hz */
export const BOMB_FUSE_TICKS = 180
export const BOMB_RESTITUTION = 0.4
/** tangential velocity kept per bounce */
export const BOMB_TANGENT_DAMP = 0.82
/** below this speed a ground contact puts the bomb to rest (m/s) */
export const BOMB_REST_SPEED = 0.9
/** collision radius, meters — keeps the visual bomb out of surfaces */
export const BOMB_COLLISION_RADIUS = 0.18
/** max bounce resolutions per tick */
const MAX_BOUNCES = 3

export function registerProjectileOps(sim: Sim, phys: PhysicsWorld): void {
  sim.onOp('throw', (s, cmd) => {
    const { ox, oy, oz, vx, vy, vz } = cmd.op
    const id = s.allocEntityId()
    phys.projectiles.set(id, { id, x: ox, y: oy, z: oz, vx, vy, vz, fuse: BOMB_FUSE_TICKS, resting: false })
  })
}

/** Sim system: integrate all projectiles, detonate expired fuses. */
export function tickProjectiles(sim: Sim, phys: PhysicsWorld): void {
  if (phys.projectiles.size === 0) return
  let detonate: Projectile[] | undefined
  let dead: number[] | undefined
  // map iteration = insertion = entity-id allocation order (deterministic)
  for (const p of phys.projectiles.values()) {
    integrate(sim, p)
    p.fuse--
    if (p.fuse <= 0) (detonate ??= []).push(p)
    else if (p.y < KILL_PLANE_Y) (dead ??= []).push(p.id)
  }
  if (dead) for (const id of dead) phys.projectiles.delete(id)
  if (detonate) {
    for (const p of detonate) {
      phys.projectiles.delete(p.id)
      runExplosion(sim, phys, p.x / VOXEL_SIZE, p.y / VOXEL_SIZE, p.z / VOXEL_SIZE, BOMB_RADIUS, BOMB_POWER)
    }
  }
}

function integrate(sim: Sim, p: Projectile): void {
  p.vy += GRAVITY_Y * DT
  if (p.resting) {
    // stay asleep while supported; wake when the floor is dug/blown away
    const bx = Math.floor(p.x / VOXEL_SIZE)
    const by = Math.floor((p.y - BOMB_COLLISION_RADIUS - 0.06) / VOXEL_SIZE)
    const bz = Math.floor(p.z / VOXEL_SIZE)
    if (sim.world.getVoxel(bx, by, bz) !== 0) {
      p.vy = 0
      return
    }
    p.resting = false
  }

  const radiusVox = BOMB_COLLISION_RADIUS / VOXEL_SIZE
  let remaining = DT
  for (let b = 0; b < MAX_BOUNCES && remaining > 1e-6; b++) {
    const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy + p.vz * p.vz)
    if (speed < 1e-6) break
    const distVox = (speed * remaining) / VOXEL_SIZE + radiusVox
    const hit = ddaRaycast(sim.world, p.x / VOXEL_SIZE, p.y / VOXEL_SIZE, p.z / VOXEL_SIZE, p.vx, p.vy, p.vz, distVox)
    if (!hit) {
      p.x += p.vx * remaining
      p.y += p.vy * remaining
      p.z += p.vz * remaining
      return
    }
    if (hit.dist === 0) {
      // spawned/pushed inside solid: freeze in place, fuse keeps burning
      p.vx = p.vy = p.vz = 0
      p.resting = true
      return
    }
    const travelVox = Math.max(hit.dist - radiusVox, 0)
    if (travelVox >= (speed * remaining) / VOXEL_SIZE) {
      // contact lies beyond this tick's travel (radius padding) — no bounce yet
      p.x += p.vx * remaining
      p.y += p.vy * remaining
      p.z += p.vz * remaining
      return
    }
    // advance to the contact point, keeping the collision radius off the face
    const tHit = (travelVox * VOXEL_SIZE) / speed
    p.x += p.vx * tHit
    p.y += p.vy * tHit
    p.z += p.vz * tHit
    remaining -= tHit
    // reflect: normal component × restitution, tangential × damping
    const vn = p.vx * hit.nx + p.vy * hit.ny + p.vz * hit.nz
    const tx = p.vx - vn * hit.nx
    const ty = p.vy - vn * hit.ny
    const tz = p.vz - vn * hit.nz
    p.vx = tx * BOMB_TANGENT_DAMP - vn * BOMB_RESTITUTION * hit.nx
    p.vy = ty * BOMB_TANGENT_DAMP - vn * BOMB_RESTITUTION * hit.ny
    p.vz = tz * BOMB_TANGENT_DAMP - vn * BOMB_RESTITUTION * hit.nz
    const after = Math.sqrt(p.vx * p.vx + p.vy * p.vy + p.vz * p.vz)
    if (hit.ny > 0 && after < BOMB_REST_SPEED) {
      p.vx = p.vy = p.vz = 0
      p.resting = true
      return
    }
  }
}
