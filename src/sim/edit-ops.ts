import type { Sim } from './loop'
import { VOXEL_SIZE } from '../world/chunks'
import type { IPhysicsWorld } from './iphysics'

/**
 * T5 — world edit ops. The only writers of voxel state (V1): dig and place
 * stamp spheres through I.chunk; dirty tracking rides on ChunkStore.
 * shoot/explode get real implementations in T13/T28 (need raycast + physics).
 *
 * B17 — dig also shoves nearby dynamic bodies (rubble is clearable). The
 * physics world attaches per-sim after createPhysics (WeakMap: no stale
 * cross-test references, no handler re-registration). Sims without physics
 * (chunk-only tests) simply skip the push — same deterministic op semantics.
 */

/** impulse (kg·m/s) at the dig center pushing rubble out of the hole */
export const DIG_PUSH_IMPULSE = 60
/** push reach relative to the dig radius */
export const DIG_PUSH_RADIUS_SCALE = 2.5

const physBySim = new WeakMap<Sim, IPhysicsWorld>()

/** called by createPhysics — enables the dig push (B17) */
export function attachEditPhysics(sim: Sim, phys: IPhysicsWorld): void {
  physBySim.set(sim, phys)
}

export function registerEditOps(sim: Sim): void {
  sim.onOp('dig', (s, cmd) => {
    s.world.stampSphere(cmd.op.x, cmd.op.y, cmd.op.z, cmd.op.r, 0)
    const phys = physBySim.get(s)
    if (phys) {
      phys.applyRadialImpulse(
        cmd.op.x * VOXEL_SIZE,
        cmd.op.y * VOXEL_SIZE,
        cmd.op.z * VOXEL_SIZE,
        cmd.op.r * VOXEL_SIZE * DIG_PUSH_RADIUS_SCALE,
        DIG_PUSH_IMPULSE,
      )
    }
  })
  sim.onOp('place', (s, cmd) => {
    s.world.stampSphere(cmd.op.x, cmd.op.y, cmd.op.z, cmd.op.r, cmd.op.mat)
  })
}
