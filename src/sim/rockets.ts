/**
 * P19 — rocket-launcher projectiles. Spawned by the 'rocket' op (I.cmd, V1),
 * integrated by a sim system registered in createPhysics (fixed order, V2):
 * NO gravity, NO bounce — a fast straight dart along the launch direction that
 * detonates a punchy T55 explosion the instant it meets a world voxel or a
 * dynamic island body (whichever is nearer within a tick's travel). Misses
 * despawn silently at the end of range (like the gun).
 *
 * Deterministic: pure math from sim state + the same DDA / Jolt narrow-phase
 * queries the hitscan gun uses (V2). Rocket state lives in phys.rockets (Map
 * keyed by entity id, V8) and is folded into hashPhysics (V3). Render draws
 * them via src/render/rocket-meshes.ts (reads the map, writes nothing — V6).
 */
import { DT, type Sim } from './loop'
import { VOXEL_SIZE } from '../world/chunks'
import { ddaRaycast } from './shoot-op'
import { runExplosion } from './destruction'
import type { PhysicsWorld } from './physics'

export interface Rocket {
  /** entity id via sim.allocEntityId() (V8) */
  id: number
  /** position, world meters */
  x: number
  y: number
  z: number
  /** velocity, m/s (constant — no gravity) */
  vx: number
  vy: number
  vz: number
  /** ticks of life left before it fizzles out at max range */
  ttl: number
  /** player combat — shooter playerId (kill attribution, 0 = world); hashed */
  owner: number
}

/** rocket cruise speed, m/s — fast enough to read as hitscan-ish */
export const ROCKET_SPEED = 80
/** destruction radius at impact, voxels — larger than the bomb (BOMB_RADIUS 15) */
export const ROCKET_RADIUS = 18
/** destruction power — harder than the bomb (BOMB_POWER 9): craters concrete/metal */
export const ROCKET_POWER = 12
/** max flight time before a miss fizzles: 90 ticks × 80 m/s × DT ≈ 120 m range */
export const ROCKET_TTL_TICKS = 90
/** nudge the spawn out of the muzzle so it never detonates in the shooter's face */
export const ROCKET_SPAWN_OFFSET = 0.6

export function registerRocketOps(sim: Sim, phys: PhysicsWorld): void {
  sim.onOp('rocket', (s, cmd) => {
    // player combat — dead players ignore input ops
    const shooter = phys.players.get(cmd.playerId)
    if (shooter && !shooter.alive) return
    const { ox, oy, oz, dx, dy, dz } = cmd.op
    // normalize defensively — the op ships a camera direction (already unit,
    // but a bad client must not desync the flight integration)
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1
    const nx = dx / len, ny = dy / len, nz = dz / len
    const id = s.allocEntityId()
    phys.rockets.set(id, {
      id,
      x: ox + nx * ROCKET_SPAWN_OFFSET,
      y: oy + ny * ROCKET_SPAWN_OFFSET,
      z: oz + nz * ROCKET_SPAWN_OFFSET,
      vx: nx * ROCKET_SPEED,
      vy: ny * ROCKET_SPEED,
      vz: nz * ROCKET_SPEED,
      ttl: ROCKET_TTL_TICKS,
      owner: cmd.playerId,
    })
  })
}

/** Sim system: fly every rocket one tick, detonate on the first contact. */
export function tickRockets(sim: Sim, phys: PhysicsWorld): void {
  if (phys.rockets.size === 0) return
  let detonate: { r: Rocket; x: number; y: number; z: number }[] | undefined
  let dead: number[] | undefined
  // map iteration = insertion = entity-id allocation order (deterministic, V2)
  for (const r of phys.rockets.values()) {
    const speed = Math.sqrt(r.vx * r.vx + r.vy * r.vy + r.vz * r.vz)
    const travel = speed * DT // meters this tick
    const nx = r.vx / speed, ny = r.vy / speed, nz = r.vz / speed

    // world voxels: DDA in voxel units (shared traversal, V6/V2)
    const worldHit = ddaRaycast(
      sim.world,
      r.x / VOXEL_SIZE, r.y / VOXEL_SIZE, r.z / VOXEL_SIZE,
      nx, ny, nz,
      travel / VOXEL_SIZE,
    )
    const worldDist = worldHit ? worldHit.dist * VOXEL_SIZE : Infinity

    // dynamic island bodies: narrow-phase ray, capped at the world hit so a
    // body only wins when it is strictly in front of the voxel surface (B17)
    const bodyHit = phys.castRayBody(r.x, r.y, r.z, nx, ny, nz, Math.min(travel, worldDist))
    const bodyDist = bodyHit ? bodyHit.fraction * Math.min(travel, worldDist) : Infinity

    // T95b/V17b — LOCAL debris (frozen rubble walls!) must stop rockets in SP:
    // a collapsed wall remnant is debris, not world voxels — without this test
    // rockets sailed straight through visually-solid rubble. Same dual-mode
    // rule as shoot-op: in MP lockstep the detonation position must stay
    // deterministic, so local debris never redirects it there (peers may see a
    // rocket pass through rubble — consistent on every machine).
    if (!sim.lockstep) {
      const debrisHit = phys.castRayDebris?.(r.x, r.y, r.z, nx, ny, nz, Math.min(travel, worldDist, bodyDist))
      if (debrisHit) {
        ;(detonate ??= []).push({
          r,
          x: (debrisHit.px + nx * VOXEL_SIZE * 0.5) / VOXEL_SIZE,
          y: (debrisHit.py + ny * VOXEL_SIZE * 0.5) / VOXEL_SIZE,
          z: (debrisHit.pz + nz * VOXEL_SIZE * 0.5) / VOXEL_SIZE,
        })
        continue
      }
    }

    if (bodyHit && bodyDist <= worldDist) {
      // detonate at the body impact point (nudged a touch into the surface so
      // the sphere bites the grid, mirroring the world path's +0.5 centering)
      ;(detonate ??= []).push({
        r,
        x: (bodyHit.px + nx * VOXEL_SIZE * 0.5) / VOXEL_SIZE,
        y: (bodyHit.py + ny * VOXEL_SIZE * 0.5) / VOXEL_SIZE,
        z: (bodyHit.pz + nz * VOXEL_SIZE * 0.5) / VOXEL_SIZE,
      })
    } else if (worldHit) {
      // detonate centered on the struck voxel (same rule as the gun/bomb)
      ;(detonate ??= []).push({ r, x: worldHit.x + 0.5, y: worldHit.y + 0.5, z: worldHit.z + 0.5 })
    } else {
      // free flight this tick
      r.x += r.vx * DT
      r.y += r.vy * DT
      r.z += r.vz * DT
      r.ttl--
      if (r.ttl <= 0) (dead ??= []).push(r.id)
      // T95b — prewarm handled generically in phys.prewarmHotspots
    }
  }
  if (dead) for (const id of dead) phys.rockets.delete(id)
  if (detonate) {
    for (const d of detonate) {
      phys.rockets.delete(d.r.id)
      runExplosion(sim, phys, d.x, d.y, d.z, ROCKET_RADIUS, ROCKET_POWER, d.r.owner)
    }
  }
}
