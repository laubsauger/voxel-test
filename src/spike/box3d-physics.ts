/**
 * T84 — Box3DPhysicsWorld: a Box3D-backed drop-in for the Jolt PhysicsWorld,
 * scoped to the DESTRUCTION surface (IPhysicsWorld). It drives the SAME real
 * game pipeline unchanged — edit-ops → structuralPass → connectivity.findUnsupportedIslands
 * → extractIsland/buildVoxelBody → debris — with box3d-wasm instead of Jolt.
 *
 * Body model (box3d 0.2.0 has no offset/non-convex compound, V16/B30):
 *   - static chunk colliders: one static box body per greedy box (no compound).
 *   - dynamic island/debris bodies: ONE body with a CONVEX HULL of the island's
 *     voxel corners (concave rubble → convex approx — the documented fidelity gap).
 *
 * Out of scope (B30): players (CharacterVirtual) + vehicles (VehicleConstraint)
 * are unportable to 0.2.0; `players` stays an empty map so the shared
 * damagePlayersSphere call is a safe no-op.
 */
import Box3D, { type B3World, type B3Body } from 'box3d-wasm/standard'
import { DT, type Sim } from '../sim/loop'
import {
  CHUNK,
  ChunkKind,
  VOXEL_SIZE,
  WORLD_CX,
  WORLD_CY,
  WORLD_CZ,
  chunkIndex,
  type ChunkStore,
} from '../world/chunks'
import { greedyBoxes } from '../sim/greedy-boxes'
import { findUnsupportedIslands, type Island, type IslandVoxel } from '../sim/connectivity'
import { material, VOXEL_VOLUME } from '../sim/materials'
import { registerDestructionOps } from '../sim/destruction'
import { attachEditPhysics } from '../sim/edit-ops'
import type { IPhysicsWorld, DynamicBody, BodyRayHit } from '../sim/iphysics'
import type { PlayerEntity } from '../sim/player'

const GRAVITY_Y = -9.81
const MAX_LIN = 60
const MAX_ANG = 25
const KILL_PLANE_Y = -10
const SUB_STEPS = 4
const CONNECTIVITY_MARGIN = 8
/** hull point-cloud cap — beyond this, fall back to the island bbox corners */
const MAX_HULL_POINTS = 1600

/** union voxel-space region of chunk indices, expanded by margin (port of physics.chunkUnionRegion, Jolt-free) */
function chunkUnionRegion(chunkIndices: number[], margin: number) {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity
  let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
  for (const ci of chunkIndices) {
    const cx = ci % WORLD_CX
    const cz = ((ci / WORLD_CX) | 0) % WORLD_CZ
    const cy = (ci / (WORLD_CX * WORLD_CZ)) | 0
    x0 = Math.min(x0, cx * CHUNK); y0 = Math.min(y0, cy * CHUNK); z0 = Math.min(z0, cz * CHUNK)
    x1 = Math.max(x1, cx * CHUNK + CHUNK - 1); y1 = Math.max(y1, cy * CHUNK + CHUNK - 1); z1 = Math.max(z1, cz * CHUNK + CHUNK - 1)
  }
  return { x0: x0 - margin, y0: y0 - margin, z0: z0 - margin, x1: x1 + margin, y1: y1 + margin, z1: z1 + margin }
}

export class Box3DPhysicsWorld implements IPhysicsWorld {
  readonly bodies = new Map<number, DynamicBody>()
  readonly players = new Map<number, PlayerEntity>() // empty — B30 gap
  private readonly world: B3World
  private readonly chunkBodies = new Map<number, B3Body[]>()
  private readonly remesh = new Set<number>()
  private pendingConnectivity: number[] = []

  private constructor(world: B3World) {
    this.world = world
  }

  static async create(): Promise<Box3DPhysicsWorld> {
    const b3 = await Box3D()
    const world = new b3.World({ gravity: { x: 0, y: GRAVITY_Y, z: 0 } })
    world.enableContinuous(true)
    return new Box3DPhysicsWorld(world)
  }

  // --- static chunk colliders ------------------------------------------------

  initStatic(world: ChunkStore): void {
    world.drainDirty() // clear world-gen dirty; we build every non-empty chunk below
    for (let cy = 0; cy < WORLD_CY; cy++)
      for (let cz = 0; cz < WORLD_CZ; cz++)
        for (let cx = 0; cx < WORLD_CX; cx++) {
          const ci = chunkIndex(cx, cy, cz)
          if (world.chunkAt(ci).kind === ChunkKind.Empty) continue
          this.rebuildChunkBody(world, ci)
        }
  }

  private rebuildChunkBody(world: ChunkStore, ci: number): void {
    const old = this.chunkBodies.get(ci)
    if (old) {
      for (const b of old) b.destroy()
      this.chunkBodies.delete(ci)
    }
    const cx = ci % WORLD_CX
    const cz = ((ci / WORLD_CX) | 0) % WORLD_CZ
    const cy = (ci / (WORLD_CX * WORLD_CZ)) | 0
    if (world.chunkAt(ci).kind === ChunkKind.Empty) {
      this.remesh.add(ci)
      return
    }
    const ox = cx * CHUNK, oy = cy * CHUNK, oz = cz * CHUNK
    const grid = new Uint8Array(CHUNK * CHUNK * CHUNK)
    let any = false
    for (let ly = 0; ly < CHUNK; ly++)
      for (let lz = 0; lz < CHUNK; lz++)
        for (let lx = 0; lx < CHUNK; lx++) {
          const m = world.getVoxel(ox + lx, oy + ly, oz + lz)
          if (m !== 0) {
            grid[lx + lz * CHUNK + ly * CHUNK * CHUNK] = m
            any = true
          }
        }
    if (any) {
      const bodies: B3Body[] = []
      for (const b of greedyBoxes(grid, CHUNK, CHUNK, CHUNK)) {
        const body = this.world.createBody({
          type: 'static',
          position: {
            x: (ox + b.x + b.sx / 2) * VOXEL_SIZE,
            y: (oy + b.y + b.sy / 2) * VOXEL_SIZE,
            z: (oz + b.z + b.sz / 2) * VOXEL_SIZE,
          },
        })
        body.createBox({
          halfExtents: { x: (b.sx / 2) * VOXEL_SIZE, y: (b.sy / 2) * VOXEL_SIZE, z: (b.sz / 2) * VOXEL_SIZE },
        })
        bodies.push(body)
      }
      this.chunkBodies.set(ci, bodies)
    }
    this.remesh.add(ci)
  }

  get staticColliderCount(): number {
    let n = 0
    for (const b of this.chunkBodies.values()) n += b.length
    return n
  }

  // --- per-tick driver -------------------------------------------------------

  tick(sim: Sim): void {
    this.structuralPass(sim)
    this.world.step(DT, SUB_STEPS)
    this.readbackBodies()
    this.killPlanePass(sim)
  }

  structuralPass(sim: Sim): void {
    const drained = sim.world.drainDirty()
    for (const ci of drained) this.rebuildChunkBody(sim.world, ci)
    const check = this.pendingConnectivity.concat(drained)
    this.pendingConnectivity = []
    if (check.length === 0) return
    const region = chunkUnionRegion(check, CONNECTIVITY_MARGIN)
    for (const island of findUnsupportedIslands(sim.world, region)) this.extractIsland(sim, island)
    const dirtied = sim.world.drainDirty()
    for (const ci of dirtied) {
      this.rebuildChunkBody(sim.world, ci)
      this.pendingConnectivity.push(ci)
    }
  }

  private readbackBodies(): void {
    for (const b of this.bodies.values()) {
      const body = b.body as B3Body
      const p = body.getPosition()
      b.px = p.x; b.py = p.y; b.pz = p.z
      const q = body.getRotation()
      b.qx = q.x; b.qy = q.y; b.qz = q.z; b.qw = q.w
      const lv = body.getLinearVelocity()
      const sp2 = lv.x * lv.x + lv.y * lv.y + lv.z * lv.z
      b.restTicks = sp2 < 0.09 ? b.restTicks + 1 : 0
    }
  }

  private killPlanePass(sim: Sim): void {
    let dead: number[] | undefined
    for (const b of this.bodies.values()) if (b.py < KILL_PLANE_Y) (dead ??= []).push(b.id)
    if (!dead) return
    dead.sort((a, b) => a - b)
    for (const id of dead) this.despawnBody(id)
    void sim
  }

  private despawnBody(id: number): void {
    const b = this.bodies.get(id)
    if (!b) return
    ;(b.body as B3Body).destroy()
    this.bodies.delete(id)
  }

  // --- dynamic island / debris bodies ---------------------------------------

  extractIsland(sim: Sim, island: Island): DynamicBody {
    for (const v of island.voxels) sim.world.setVoxel(v.x, v.y, v.z, 0)
    return this.buildVoxelBody(sim, island.voxels)
  }

  spawnDebrisBody(sim: Sim, voxels: IslandVoxel[]): DynamicBody {
    return this.buildVoxelBody(sim, voxels)
  }

  private buildVoxelBody(sim: Sim, vs: IslandVoxel[]): DynamicBody {
    if (vs.length === 0) throw new Error('buildVoxelBody: empty voxel set')
    let x0 = vs[0].x, y0 = vs[0].y, z0 = vs[0].z
    let x1 = x0, y1 = y0, z1 = z0
    for (const v of vs) {
      if (v.x < x0) x0 = v.x; if (v.y < y0) y0 = v.y; if (v.z < z0) z0 = v.z
      if (v.x > x1) x1 = v.x; if (v.y > y1) y1 = v.y; if (v.z > z1) z1 = v.z
    }
    const sx = x1 - x0 + 1, sy = y1 - y0 + 1, sz = z1 - z0 + 1
    const grid = new Uint8Array(sx * sy * sz)
    let mass = 0
    const matCounts = new Uint32Array(256)
    for (const v of vs) {
      grid[v.x - x0 + (v.z - z0) * sx + (v.y - y0) * sx * sz] = v.mat
      mass += material(v.mat).density * VOXEL_VOLUME
      matCounts[v.mat]++
    }
    let mat = 0, best = 0
    for (let m = 1; m < 256; m++) if (matCounts[m] > best) { best = matCounts[m]; mat = m }

    const body = this.world.createBody({
      type: 'dynamic',
      position: { x: x0 * VOXEL_SIZE, y: y0 * VOXEL_SIZE, z: z0 * VOXEL_SIZE },
    })
    const density = Math.max(0.2, material(mat).density)
    body.createHull({ points: this.hullPoints(grid, sx, sy, sz), density })
    body.applyMassFromShapes()

    const id = sim.allocEntityId()
    body.setUserData(id)
    const entity: DynamicBody = {
      id, sx, sy, sz, grid, count: vs.length, mass, mat,
      px: x0 * VOXEL_SIZE, py: y0 * VOXEL_SIZE, pz: z0 * VOXEL_SIZE,
      qx: 0, qy: 0, qz: 0, qw: 1,
      body, version: 0, restTicks: 0,
    }
    this.bodies.set(id, entity)
    return entity
  }

  /** convex-hull point cloud = unique solid-voxel corners in body-local metres */
  private hullPoints(grid: Uint8Array, sx: number, sy: number, sz: number): Array<{ x: number; y: number; z: number }> {
    const seen = new Set<number>()
    const pts: Array<{ x: number; y: number; z: number }> = []
    const add = (x: number, y: number, z: number): void => {
      const key = x + (sx + 1) * (z + (sz + 1) * y)
      if (seen.has(key)) return
      seen.add(key)
      pts.push({ x: x * VOXEL_SIZE, y: y * VOXEL_SIZE, z: z * VOXEL_SIZE })
    }
    for (let y = 0; y < sy; y++)
      for (let z = 0; z < sz; z++)
        for (let x = 0; x < sx; x++) {
          if (grid[x + z * sx + y * sx * sz] === 0) continue
          for (let dz = 0; dz <= 1; dz++) for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) add(x + dx, y + dy, z + dz)
        }
    if (pts.length > MAX_HULL_POINTS) {
      // too many — a convex hull only needs the extremes; use the bbox corners
      const out: Array<{ x: number; y: number; z: number }> = []
      for (let dz = 0; dz <= 1; dz++) for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++)
        out.push({ x: dx * sx * VOXEL_SIZE, y: dy * sy * VOXEL_SIZE, z: dz * sz * VOXEL_SIZE })
      return out
    }
    return pts
  }

  setBodyVelocity(b: DynamicBody, vx: number, vy: number, vz: number, wx: number, wy: number, wz: number): void {
    const vlen = Math.hypot(vx, vy, vz)
    if (vlen > MAX_LIN) { const s = MAX_LIN / vlen; vx *= s; vy *= s; vz *= s }
    const wlen = Math.hypot(wx, wy, wz)
    if (wlen > MAX_ANG) { const s = MAX_ANG / wlen; wx *= s; wy *= s; wz *= s }
    const body = b.body as B3Body
    body.setLinearVelocity({ x: vx, y: vy, z: vz })
    body.setAngularVelocity({ x: wx, y: wy, z: wz })
  }

  impulseBodyAt(b: DynamicBody, ix: number, iy: number, iz: number, px: number, py: number, pz: number): void {
    ;(b.body as B3Body).applyLinearImpulse({ x: ix, y: iy, z: iz }, { x: px, y: py, z: pz }, true)
  }

  applyRadialImpulse(cx: number, cy: number, cz: number, radius: number, strength: number): void {
    const r2 = radius * radius
    for (const b of this.bodies.values()) {
      const dx = b.px - cx, dy = b.py - cy, dz = b.pz - cz
      const d2 = dx * dx + dy * dy + dz * dz
      if (d2 > r2) continue
      const d = Math.sqrt(d2) || 1e-6
      const mag = strength * (1 - Math.sqrt(d2) / radius)
      if (mag <= 0) continue
      ;(b.body as B3Body).applyLinearImpulseToCenter(
        { x: (dx / d) * mag, y: d2 < 1e-6 ? mag : (dy / d) * mag, z: (dz / d) * mag },
        true,
      )
    }
  }

  /** carve a body's voxel grid in a world sphere; rebuild hull (destroy+recreate) or despawn */
  damageBodySphere(b: DynamicBody, wx: number, wy: number, wz: number, rMeters: number, power: number, snapToVoxel = false): number {
    void power; void snapToVoxel
    const body = b.body as B3Body
    const p = body.getPosition()
    const q = body.getRotation()
    // world→body-local (inverse rotate), then to voxel grid coords
    const inv = { x: -q.x, y: -q.y, z: -q.z, w: q.w }
    const rel = rotate(inv, { x: wx - p.x, y: wy - p.y, z: wz - p.z })
    const cx = rel.x / VOXEL_SIZE, cy = rel.y / VOXEL_SIZE, cz = rel.z / VOXEL_SIZE
    const rv = rMeters / VOXEL_SIZE
    const rv2 = rv * rv
    let removed = 0
    for (let y = 0; y < b.sy; y++)
      for (let z = 0; z < b.sz; z++)
        for (let x = 0; x < b.sx; x++) {
          const idx = x + z * b.sx + y * b.sx * b.sz
          if (b.grid[idx] === 0) continue
          const dx = x + 0.5 - cx, dy = y + 0.5 - cy, dz = z + 0.5 - cz
          if (dx * dx + dy * dy + dz * dz <= rv2) { b.grid[idx] = 0; removed++ }
        }
    if (removed === 0) return 0
    b.count -= removed
    if (b.count <= 0) { this.despawnBody(b.id); return removed }
    // rebuild body: preserve transform + velocity, swap to the carved hull
    const lv = body.getLinearVelocity()
    const av = body.getAngularVelocity()
    const density = Math.max(0.2, material(b.mat).density)
    const nb = this.world.createBody({ type: 'dynamic', position: p })
    nb.createHull({ points: this.hullPoints(b.grid, b.sx, b.sy, b.sz), density })
    nb.applyMassFromShapes()
    nb.setTransform({ position: p, rotation: q })
    nb.setLinearVelocity(lv)
    nb.setAngularVelocity(av)
    nb.setUserData(b.id)
    body.destroy()
    b.body = nb
    b.version++
    return removed
  }

  damageBodiesSphere(wx: number, wy: number, wz: number, rMeters: number, power: number, onlyIds?: number[]): void {
    const ids = onlyIds ?? [...this.bodies.keys()]
    for (const id of ids) {
      const b = this.bodies.get(id)
      if (!b) continue
      const dx = b.px - wx, dy = b.py - wy, dz = b.pz - wz
      const reach = rMeters + Math.max(b.sx, b.sy, b.sz) * VOXEL_SIZE
      if (dx * dx + dy * dy + dz * dz > reach * reach) continue
      this.damageBodySphere(b, wx, wy, wz, rMeters, power)
    }
  }

  castRayBody(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): BodyRayHit | null {
    const hit = this.world.castRayClosest(
      { x: ox, y: oy, z: oz },
      { x: dx * maxDist, y: dy * maxDist, z: dz * maxDist },
    )
    if (!hit.hit || !hit.body) return null
    const id = hit.body.getUserData()
    const body = this.bodies.get(id)
    if (!body) return null
    const f = hit.fraction ?? 0
    const pt = hit.point ?? { x: ox + dx * maxDist * f, y: oy + dy * maxDist * f, z: oz + dz * maxDist * f }
    const n = hit.normal ?? { x: 0, y: 1, z: 0 }
    return { body, fraction: f, px: pt.x, py: pt.y, pz: pt.z, nx: n.x, ny: n.y, nz: n.z }
  }

  drainRemesh(): number[] {
    const out = [...this.remesh].sort((a, b) => a - b)
    this.remesh.clear()
    return out
  }

  dispose(): void {
    for (const b of this.bodies.values()) (b.body as B3Body).destroy()
    this.bodies.clear()
    for (const arr of this.chunkBodies.values()) for (const b of arr) b.destroy()
    this.chunkBodies.clear()
    this.world.destroy()
  }
}

/** rotate a vec by a quaternion (v' = q * v * q⁻¹) */
function rotate(q: { x: number; y: number; z: number; w: number }, v: { x: number; y: number; z: number }) {
  const { x: qx, y: qy, z: qz, w: qw } = q
  const ix = qw * v.x + qy * v.z - qz * v.y
  const iy = qw * v.y + qz * v.x - qx * v.z
  const iz = qw * v.z + qx * v.y - qy * v.x
  const iw = -qx * v.x - qy * v.y - qz * v.z
  return {
    x: ix * qw + iw * -qx + iy * -qz - iz * -qy,
    y: iy * qw + iw * -qy + iz * -qx - ix * -qz,
    z: iz * qw + iw * -qz + ix * -qy - iy * -qx,
  }
}

/**
 * Construct + wire the Box3D destruction world into a Sim: registers the REAL
 * destruction + edit ops and the physics tick system, then seeds static
 * colliders. Mirror of createPhysics (physics.ts) minus the unportable
 * player/vehicle/aircraft/projectile subsystems (B30).
 */
export async function createBox3DPhysics(sim: Sim): Promise<Box3DPhysicsWorld> {
  const phys = await Box3DPhysicsWorld.create()
  registerDestructionOps(sim, phys)
  attachEditPhysics(sim, phys)
  sim.addSystem(() => phys.tick(sim))
  phys.initStatic(sim.world)
  return phys
}
