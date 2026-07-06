/**
 * Backend-agnostic physics contract (2026-07-06, Box3D spike B30).
 *
 * The destruction/edit/shoot ops (destruction.ts, edit-ops.ts, shoot-op.ts) and
 * the render body meshes only ever call PhysicsWorld's METHOD surface + read
 * DynamicBody's mirrored scalar fields — they never touch the underlying engine
 * body directly. Extracting that surface here lets the Jolt PhysicsWorld and the
 * spike's Box3DPhysicsWorld both drive the SAME real destruction pipeline.
 *
 * This file is engine-free (no jolt-physics / box3d import) so a backend can
 * depend on it without dragging the other engine in. DynamicBody.body is
 * `unknown`: each backend stores its own body handle there and casts internally.
 */
import type { Sim } from './loop'
import type { ChunkStore } from '../world/chunks'
import type { Island, IslandVoxel } from './connectivity'
import type { PlayerEntity } from './player'

/** T12/T55 — a dynamic voxel-island body. `body` = backend handle (Jolt.Body | B3Body). */
export interface DynamicBody {
  /** entity id via sim.allocEntityId() (V8) */
  id: number
  sx: number
  sy: number
  sz: number
  grid: Uint8Array
  /** live voxel count */
  count: number
  /** kg — voxel count × material density × voxel volume */
  mass: number
  /** dominant material id (most voxels, ties → lowest id) — feel + buoyancy */
  mat: number
  px: number
  py: number
  pz: number
  qx: number
  qy: number
  qz: number
  qw: number
  /** backend body handle — cast per backend (V16: Jolt.Body or box3d B3Body) */
  body: unknown
  /** bumped when grid content changes — render rebuild trigger */
  version: number
  /** B37 — ticks the body has been at rest; ≥ REWELD_TICKS ⇒ re-weld to static */
  restTicks: number
}

/** B17 — result of a ray cast against dynamic island bodies */
export interface BodyRayHit {
  body: DynamicBody
  fraction: number
  /** hit point, world meters */
  px: number
  py: number
  pz: number
  /** surface normal at the hit */
  nx: number
  ny: number
  nz: number
}

/**
 * The physics surface the destruction pipeline drives. Jolt PhysicsWorld and the
 * spike Box3DPhysicsWorld both implement this; destruction.ts/edit-ops.ts/
 * shoot-op.ts are typed to it so the SAME ops run on either backend.
 */
export interface IPhysicsWorld {
  readonly bodies: Map<number, DynamicBody>
  /** player entities the destruction blast carves (empty on backends w/o players) */
  readonly players: Map<number, PlayerEntity>
  initStatic(world: ChunkStore): void
  tick(sim: Sim): void
  structuralPass(sim: Sim): void
  extractIsland(sim: Sim, island: Island): DynamicBody
  spawnDebrisBody(sim: Sim, voxels: IslandVoxel[]): DynamicBody
  setBodyVelocity(b: DynamicBody, vx: number, vy: number, vz: number, wx: number, wy: number, wz: number): void
  castRayBody(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDist: number,
  ): BodyRayHit | null
  impulseBodyAt(b: DynamicBody, ix: number, iy: number, iz: number, px: number, py: number, pz: number): void
  damageBodySphere(
    b: DynamicBody,
    wx: number,
    wy: number,
    wz: number,
    rMeters: number,
    power: number,
    snapToVoxel?: boolean,
  ): number
  damageBodiesSphere(wx: number, wy: number, wz: number, rMeters: number, power: number, onlyIds?: number[]): void
  applyRadialImpulse(cx: number, cy: number, cz: number, radius: number, strength: number): void
  drainRemesh(): number[]
}
