/**
 * T80 — map voxel clusters to Box3D static colliders, two ways, to compare the
 * body/shape-count lever (T83 q3):
 *   'per-voxel' — one static box body per solid voxel (worst case, many bodies)
 *   'greedy'    — greedyBoxes() merges runs into big boxes; one body per box
 *
 * box3d-wasm 0.2.0 has no shape-local offset (verified), so the greedy result
 * can't be a single-body compound — each merged box is its own static body at
 * its center. Both mappings therefore route through SpikeWorld.addStaticBox and
 * differ only in count/size, which is exactly the perf variable being measured.
 *
 * Coordinates: voxel v in a cluster with world origin O → world-center =
 * O + (v + 0.5)*VOXEL_SIZE, half-extent VOXEL_SIZE/2. A greedy box spanning
 * voxels [x, x+sx) → center O + (x + sx/2)*VOXEL_SIZE, half (sx/2)*VOXEL_SIZE.
 */
import { greedyBoxes } from '../sim/greedy-boxes'
import { MAT_AIR } from '../sim/materials'
import { VOXEL_SIZE } from '../world/chunks'
import type { SpikeWorld } from './box3d-bridge'
import type { VoxelCluster } from './houses'

export type ColliderMode = 'per-voxel' | 'greedy'

export interface ColliderStats {
  mode: ColliderMode
  /** static bodies created (= box colliders, one shape each) */
  bodyCount: number
  /** total solid voxels across clusters (per-voxel body count / greedy input) */
  solidVoxels: number
  /** wall-clock ms to build all colliders (performance.now — spike is V14-exempt) */
  buildMs: number
}

const H = VOXEL_SIZE / 2

function addPerVoxel(phys: SpikeWorld, c: VoxelCluster): number {
  let n = 0
  const { grid, sx, sy, sz, origin } = c
  for (let y = 0; y < sy; y++)
    for (let z = 0; z < sz; z++)
      for (let x = 0; x < sx; x++) {
        if (grid[x + z * sx + y * sx * sz] === MAT_AIR) continue
        phys.addStaticBox(
          { x: origin.x + (x + 0.5) * VOXEL_SIZE, y: origin.y + (y + 0.5) * VOXEL_SIZE, z: origin.z + (z + 0.5) * VOXEL_SIZE },
          { x: H, y: H, z: H },
        )
        n++
      }
  return n
}

function addGreedy(phys: SpikeWorld, c: VoxelCluster): number {
  const { grid, sx, sy, sz, origin } = c
  const boxes = greedyBoxes(grid, sx, sy, sz)
  for (const b of boxes) {
    phys.addStaticBox(
      {
        x: origin.x + (b.x + b.sx / 2) * VOXEL_SIZE,
        y: origin.y + (b.y + b.sy / 2) * VOXEL_SIZE,
        z: origin.z + (b.z + b.sz / 2) * VOXEL_SIZE,
      },
      { x: (b.sx / 2) * VOXEL_SIZE, y: (b.sy / 2) * VOXEL_SIZE, z: (b.sz / 2) * VOXEL_SIZE },
    )
  }
  return boxes.length
}

/** build static colliders for every cluster under the chosen mapping */
export function buildColliders(phys: SpikeWorld, clusters: VoxelCluster[], mode: ColliderMode): ColliderStats {
  const t0 = performance.now()
  let bodyCount = 0
  let solidVoxels = 0
  for (const c of clusters) {
    for (let i = 0; i < c.grid.length; i++) if (c.grid[i] !== MAT_AIR) solidVoxels++
    bodyCount += mode === 'per-voxel' ? addPerVoxel(phys, c) : addGreedy(phys, c)
  }
  return { mode, bodyCount, solidVoxels, buildMs: performance.now() - t0 }
}
