/**
 * P19 — remote-detonated TNT charges. Two ops (I.cmd, V1):
 *   'tnt_place'    — drop a charge entity at the aim point (place several).
 *   'tnt_detonate' — remote trigger: blow EVERY placed charge at once. Each is
 *                    a big zoned T55 boom, and a detonation chain-triggers any
 *                    still-live charge within TNT_CHAIN_RADIUS (co-located
 *                    charges cascade). NOT a fuse timer.
 *
 * Deterministic (V2): charges carry only a position; detonation processes them
 * in a fixed order (ascending entity id, chained neighbours enqueued in id
 * order) so every peer removes voxels in the identical sequence. Charge state
 * lives in phys.charges (Map keyed by entity id, V8) and is folded into
 * hashPhysics (V3). Render draws them via src/render/tnt-meshes.ts (V6).
 */
import type { Sim } from './loop'
import { VOXEL_SIZE } from '../world/chunks'
import { runExplosion } from './destruction'
import type { PhysicsWorld } from './physics'

export interface Charge {
  /** entity id via sim.allocEntityId() (V8) */
  id: number
  /** position, world meters */
  x: number
  y: number
  z: number
  /** player combat — placer playerId (kill attribution, 0 = world); hashed.
   *  Chain detonations credit each charge's own placer. */
  owner: number
}

/** destruction radius per charge, voxels — a big zoned boom (bomb is 15) */
export const TNT_RADIUS = 16
/** destruction power per charge — between bomb (9) and rocket (12) */
export const TNT_POWER = 11
/** a detonation chain-triggers live charges within this many meters */
export const TNT_CHAIN_RADIUS = 6

export function registerTntOps(sim: Sim, phys: PhysicsWorld): void {
  sim.onOp('tnt_place', (s, cmd) => {
    // player combat — dead players ignore input ops
    const placer = phys.players.get(cmd.playerId)
    if (placer && !placer.alive) return
    const { x, y, z } = cmd.op
    const id = s.allocEntityId()
    phys.charges.set(id, { id, x, y, z, owner: cmd.playerId })
  })

  sim.onOp('tnt_detonate', (s, _cmd) => {
    if (phys.charges.size === 0) return
    // remote detonate ALL: seed the worklist with every charge in ascending id
    // order; each explosion cascades to still-live neighbours (also id-ordered)
    const queue = [...phys.charges.keys()].sort((a, b) => a - b)
    while (queue.length > 0) {
      const id = queue.shift()!
      const c = phys.charges.get(id)
      if (!c) continue // already consumed by an earlier chain step
      phys.charges.delete(id)
      runExplosion(s, phys, c.x / VOXEL_SIZE, c.y / VOXEL_SIZE, c.z / VOXEL_SIZE, TNT_RADIUS, TNT_POWER, c.owner)
      // chain: enqueue every still-live charge within reach, ascending id, so
      // the cascade order is fully determined by sim state (V2)
      const r2 = TNT_CHAIN_RADIUS * TNT_CHAIN_RADIUS
      const chained: number[] = []
      for (const [oid, o] of phys.charges) {
        const dx = o.x - c.x, dy = o.y - c.y, dz = o.z - c.z
        if (dx * dx + dy * dy + dz * dz <= r2) chained.push(oid)
      }
      chained.sort((a, b) => a - b)
      for (const cid of chained) queue.unshift(cid)
    }
  })
}
