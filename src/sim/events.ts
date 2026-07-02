/**
 * T53/T55 — sim → render event outbox types.
 *
 * The sim appends events while handling ops/systems (explosions, shots);
 * the render layer drains them once per frame AFTER the tick(s) ran
 * (Sim.drainEvents). This is the same one-way handoff pattern as
 * ChunkStore.dirty / PhysicsWorld.drainRemesh (V6): sim writes, render
 * consumes, nothing flows back. Events are NOT sim state — they are never
 * read by sim logic and never hashed (V3 unaffected). They must stay
 * JSON-plain (no Maps/typed arrays) so a future replay/net layer could
 * carry them if ever needed.
 */

export interface ExplosionEvent {
  kind: 'explosion'
  /** blast center, world meters */
  x: number
  y: number
  z: number
  /** destruction radius, meters */
  r: number
  power: number
  /** flat [matId, count, matId, count, ...] over ALL removed voxels (incl. ejecta bodies) */
  removedByMat: number[]
  /**
   * capped sample of removed voxels that did NOT become ejecta bodies —
   * flat [vx, vy, vz, mat, ...] integer voxel coords. Render spawns
   * ballistic debris particles from these (velocity FROM the blast center).
   */
  sample: number[]
}

export interface ShotEvent {
  kind: 'shot'
  /** ray origin, world meters (muzzle flash + tracer start) */
  ox: number
  oy: number
  oz: number
  /** normalized ray direction */
  dx: number
  dy: number
  dz: number
  /** 1 = hit a voxel, 0 = flew the full range */
  hit: number
  /** tracer end point, world meters (hit voxel center or max-range point) */
  x: number
  y: number
  z: number
  /** hit face normal (0,0,0 on miss) */
  nx: number
  ny: number
  nz: number
  /** material id at the hit voxel (0 on miss) */
  mat: number
}

import type { VehicleEvent } from './vehicle'

export type SimEvent = ExplosionEvent | ShotEvent | VehicleEvent
