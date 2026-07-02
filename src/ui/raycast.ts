/**
 * T28 — render-layer tool raycast: camera (meters) → voxel hit.
 *
 * Thin meters-space wrapper over the canonical DDA in src/sim/shoot-op.ts —
 * one traversal implementation for both layers, so what the tool HUD targets
 * is exactly what a 'shoot' command would hit (V6-safe: read-only).
 */
import type { ChunkStore } from '../world/chunks'
import { VOXEL_SIZE } from '../world/chunks'
import { ddaRaycast, type VoxelHit } from '../sim/shoot-op'

export type { VoxelHit }

export interface ToolHit extends VoxelHit {
  /** hit point in world meters (center of the hit voxel) */
  mx: number
  my: number
  mz: number
  /** voxel just outside the hit face — where 'place' builds */
  px: number
  py: number
  pz: number
}

/** ray from a world-space origin (meters) along dir; maxDist in meters */
export function raycastWorld(
  world: ChunkStore,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number,
): ToolHit | null {
  const hit = ddaRaycast(
    world,
    ox / VOXEL_SIZE,
    oy / VOXEL_SIZE,
    oz / VOXEL_SIZE,
    dx,
    dy,
    dz,
    maxDist / VOXEL_SIZE,
  )
  if (!hit) return null
  return {
    ...hit,
    mx: (hit.x + 0.5) * VOXEL_SIZE,
    my: (hit.y + 0.5) * VOXEL_SIZE,
    mz: (hit.z + 0.5) * VOXEL_SIZE,
    px: hit.x + hit.nx,
    py: hit.y + hit.ny,
    pz: hit.z + hit.nz,
  }
}
