import type { Sim } from './loop'

/**
 * T5 — world edit ops. The only writers of voxel state (V1): dig and place
 * stamp spheres through I.chunk; dirty tracking rides on ChunkStore.
 * shoot/explode get real implementations in T13/T28 (need raycast + physics).
 */
export function registerEditOps(sim: Sim): void {
  sim.onOp('dig', (s, cmd) => {
    s.world.stampSphere(cmd.op.x, cmd.op.y, cmd.op.z, cmd.op.r, 0)
  })
  sim.onOp('place', (s, cmd) => {
    s.world.stampSphere(cmd.op.x, cmd.op.y, cmd.op.z, cmd.op.r, cmd.op.mat)
  })
}
