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
import { findStressCollapses } from '../sim/structure'
import { CoarseSupport } from '../sim/coarse-support'
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

/** ticks a debris body must rest before it FREEZES (dynamic → static, keeping its
 *  exact shape + orientation — NOT rasterised back to voxels, which scattered
 *  rotated pieces into axis-aligned sprinkle and evicted whatever was there). */
const FREEZE_TICKS = 55 // ~0.9 s settle
const REST_SPEED_SQ = 0.09 // (0.3 m/s)²
/** cap on live ACTIVE (non-frozen) dynamic bodies — stress collapse pauses above
 *  this so one building can't spawn thousands of moving fragments in a tick.
 *  Frozen rubble is cheap (no step/readback) and doesn't count against it. */
const BODY_CAP = 500
/** ejecta launch speed is full at/below this mass (kg) and falls off ∝ 1/mass
 *  above it — a ~10 kg brick flies, a 400 kg slab barely lurches. */
const MASS_REF = 12
/** island bigger than this is fragmented into chunks instead of one hull body */
const MONOLITH_MAX = 220

export interface PhysProfile {
  structuralMs: number
  stepMs: number
  readbackMs: number
  reweldMs: number
  bodies: number
  awake: number
  weldedThisTick: number
}

export class Box3DPhysicsWorld implements IPhysicsWorld {
  readonly bodies = new Map<number, DynamicBody>()
  readonly players = new Map<number, PlayerEntity>() // empty — B30 gap
  private readonly world: B3World
  private readonly chunkBodies = new Map<number, B3Body[]>()
  private readonly remesh = new Set<number>()
  private pendingConnectivity: number[] = []
  /** freeze-settled-debris toggle (perf A/B) + last-tick profile */
  freezeEnabled = true
  /** T56 weak-neck stress collapse toggle */
  stressEnabled = true
  /** ids of settled bodies frozen to static (kept in `bodies` + mesh, skip readback) */
  private readonly frozen = new Set<number>()
  readonly prof: PhysProfile = { structuralMs: 0, stepMs: 0, readbackMs: 0, reweldMs: 0, bodies: 0, awake: 0, weldedThisTick: 0 }

  private constructor(world: B3World) {
    this.world = world
  }

  static async create(): Promise<Box3DPhysicsWorld> {
    const b3 = await Box3D()
    const world = new b3.World({ gravity: { x: 0, y: GRAVITY_Y, z: 0 } })
    world.enableContinuous(true)
    world.enableSleeping(true)
    return new Box3DPhysicsWorld(world)
  }

  // --- static chunk colliders ------------------------------------------------

  /**
   * Build static colliders for non-empty chunks. `region` (chunk-space AABB,
   * inclusive) bounds the active area so the spike can stamp the whole real
   * suburb but only simulate/collide a slice of it (the game streams; the spike
   * just clips). Omit region = whole world.
   */
  initStatic(world: ChunkStore, region?: { cx0: number; cy0: number; cz0: number; cx1: number; cy1: number; cz1: number }): void {
    world.drainDirty() // clear world-gen dirty; we build the region's chunks below
    const r = region ?? { cx0: 0, cy0: 0, cz0: 0, cx1: WORLD_CX - 1, cy1: WORLD_CY - 1, cz1: WORLD_CZ - 1 }
    this.region = r
    this.coarse = new CoarseSupport(r)
    this.coarse.rebuild(world)
    for (let cy = r.cy0; cy <= r.cy1; cy++)
      for (let cz = r.cz0; cz <= r.cz1; cz++)
        for (let cx = r.cx0; cx <= r.cx1; cx++) {
          const ci = chunkIndex(cx, cy, cz)
          if (world.chunkAt(ci).kind === ChunkKind.Empty) continue
          this.rebuildChunkBody(world, ci)
        }
  }

  private region: { cx0: number; cy0: number; cz0: number; cx1: number; cy1: number; cz1: number } | null = null
  private coarse: CoarseSupport | null = null
  private inRegion(ci: number): boolean {
    if (!this.region) return true
    const cx = ci % WORLD_CX
    const cz = ((ci / WORLD_CX) | 0) % WORLD_CZ
    const cy = (ci / (WORLD_CX * WORLD_CZ)) | 0
    const r = this.region
    return cx >= r.cx0 && cx <= r.cx1 && cy >= r.cy0 && cy <= r.cy1 && cz >= r.cz0 && cz <= r.cz1
  }

  private rebuildChunkBody(world: ChunkStore, ci: number): void {
    if (!this.inRegion(ci)) return // spike clips to its active region
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
    const t0 = performance.now()
    this.structuralPass(sim)
    const t1 = performance.now()
    this.world.step(DT, SUB_STEPS)
    const t2 = performance.now()
    this.readbackBodies()
    const t3 = performance.now()
    const welded = this.freezeEnabled ? this.freezePass() : 0
    const t4 = performance.now()
    this.killPlanePass(sim)
    const p = this.prof
    p.structuralMs = t1 - t0
    p.stepMs = t2 - t1
    p.readbackMs = t3 - t2
    p.reweldMs = t4 - t3
    p.bodies = this.bodies.size
    p.weldedThisTick = welded
  }

  /** settled debris (rested REWELD_TICKS) rasterises back to the static world +
   *  despawns — bounds live body/mesh count so perf stays flat under repeated
   *  destruction (the parity feature the Jolt backend has).
   *
   *  CRITICAL: reweld is a SETTLING op, not a destructive edit. Debris scatters
   *  far from the impact, so if its welds fed the normal edit pipeline they would
   *  re-run stress + connectivity at every spot rubble lands and topple unrelated
   *  structures (trees, neighbours) far away. So reweld drains its OWN dirty here
   *  and updates only colliders + render for those chunks — it never reaches
   *  structuralPass, so a settling pile never triggers a collapse elsewhere. */
  private freezePass(): number {
    let n = 0
    for (const b of this.bodies.values()) {
      if (this.frozen.has(b.id) || b.restTicks < FREEZE_TICKS) continue
      // glue it in place as it rests: keep its convex-hull shape + orientation,
      // just stop simulating it. No world writes → no shape distortion, no
      // eviction, no distant re-collapse. A later blast unfreezes it (impulse/damage).
      ;(b.body as B3Body).setType('static')
      this.frozen.add(b.id)
      n++
    }
    return n
  }

  /** wake a frozen rubble piece back to dynamic (a fresh blast dislodges it) */
  private unfreeze(b: DynamicBody): void {
    if (!this.frozen.delete(b.id)) return
    ;(b.body as B3Body).setType('dynamic')
    b.restTicks = 0
  }

  /** active (non-frozen) dynamic body count — the collapse budget */
  private get activeCount(): number {
    return this.bodies.size - this.frozen.size
  }


  structuralPass(sim: Sim): void {
    // capture the FINE edit AABB before draining — the stress pass triggers on the
    // actual edited voxels, not the coarse chunk union (a blast straddling a chunk
    // boundary must not reach a tree in the neighbouring chunk).
    const editBounds = sim.world.peekDirtyBounds()
    const drained = sim.world.drainDirty()
    for (const ci of drained) this.rebuildChunkBody(sim.world, ci)
    const check = this.pendingConnectivity.concat(drained)
    this.pendingConnectivity = []
    if (check.length === 0) return
    const region = chunkUnionRegion(check, CONNECTIVITY_MARGIN)
    for (const island of findUnsupportedIslands(sim.world, region)) this.extractIsland(sim, island)

    // FLOATING-STRUCTURE catch (coarse global support). The local region misses a
    // tall structure whose base was just severed — its top hangs in the air. The
    // coarse grid floods the WHOLE active region from the ground cheaply; any
    // solid coarse cell it can't reach is floating, and its voxel region is
    // fine-extracted. Catches severed tops of any size, anywhere.
    if (this.coarse && editBounds) {
      this.coarse.update(sim.world, drained)
      const floating = this.coarse.findFloating()
      if (floating) for (const island of findUnsupportedIslands(sim.world, floating)) this.extractIsland(sim, island)
    }
    // T56 — weak-neck stress collapse. Expand the region UP (to see the mass a
    // low edit must still support) and out (to enclose the building footprint),
    // else a thin base neck never sees its true load. Clamped in findStressCollapses.
    // T56 — run stress collapse ONLY on THIS edit (drained), not the accumulated
    // connectivity cascade, so a hole in one wall can't re-judge and topple
    // untouched neighbours. edit = the changed chunks; analysis expands UP so the
    // undermined column sees the mass it must still hold.
    if (this.stressEnabled && this.activeCount < BODY_CAP && editBounds) {
      // pad the edit box slightly so a neck right at the blast rim counts as touched
      const edit = { x0: editBounds.x0 - 1, y0: editBounds.y0 - 1, z0: editBounds.z0 - 1, x1: editBounds.x1 + 1, y1: editBounds.y1 + 1, z1: editBounds.z1 + 1 }
      const analysis = { x0: edit.x0 - 6, y0: edit.y0, z0: edit.z0 - 6, x1: edit.x1 + 6, y1: edit.y1 + 44, z1: edit.z1 + 6 }
      const budget = BODY_CAP - this.activeCount
      for (const island of findStressCollapses(sim.world, analysis, edit, { maxIslands: budget })) this.extractIsland(sim, island)
    }
    const dirtied = sim.world.drainDirty()
    for (const ci of dirtied) {
      this.rebuildChunkBody(sim.world, ci)
      this.pendingConnectivity.push(ci)
    }
  }

  private readbackBodies(): void {
    for (const b of this.bodies.values()) {
      if (this.frozen.has(b.id)) continue // static rubble: transform fixed, skip
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
    this.frozen.delete(id)
  }

  // --- dynamic island / debris bodies ---------------------------------------

  extractIsland(sim: Sim, island: Island): DynamicBody {
    for (const v of island.voxels) sim.world.setVoxel(v.x, v.y, v.z, 0)
    // a big severed section (e.g. a whole floating top) crumbles into chunks
    // rather than falling as one giant convex-hull monolith (wrong shape + heavy).
    if (island.voxels.length <= MONOLITH_MAX) return this.buildVoxelBody(sim, island.voxels)
    const F = 6
    const frags = new Map<number, IslandVoxel[]>()
    for (const v of island.voxels) {
      const key = ((v.x / F) | 0) | (((v.z / F) | 0) << 10) | (((v.y / F) | 0) << 20)
      let a = frags.get(key)
      if (!a) { a = []; frags.set(key, a) }
      a.push(v)
    }
    let first: DynamicBody | undefined
    for (const a of frags.values()) {
      if (this.activeCount >= BODY_CAP) break
      const b = this.buildVoxelBody(sim, a)
      first ??= b
    }
    return first ?? this.buildVoxelBody(sim, island.voxels)
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
    // WEIGHT: the ejecta launch speed is a target for a light chunk; scale it down
    // by mass so a big stone block barely lurches while a pebble still flies (a
    // fixed impulse gives v = p/m). A really strong blast raises the input speed,
    // so heavy chunks still move a bit. Shockwave (applyRadialImpulse) is already
    // impulse/mass, so it stays consistent with this.
    const heavy = Math.min(1, MASS_REF / Math.max(b.mass, MASS_REF))
    vx *= heavy; vy *= heavy; vz *= heavy
    wx *= heavy; wy *= heavy; wz *= heavy
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
      this.unfreeze(b) // a blast wakes settled rubble in range so it reacts
      ;(b.body as B3Body).applyLinearImpulseToCenter(
        { x: (dx / d) * mag, y: d2 < 1e-6 ? mag : (dy / d) * mag, z: (dz / d) * mag },
        true,
      )
    }
  }

  /** carve a body's voxel grid in a world sphere; rebuild hull (destroy+recreate) or despawn */
  damageBodySphere(b: DynamicBody, wx: number, wy: number, wz: number, rMeters: number, power: number, snapToVoxel = false): number {
    void power; void snapToVoxel
    this.unfreeze(b) // shooting settled rubble wakes it so it can be broken further
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

  /** nearest collider hit along a ray — static walls AND dynamic/frozen bodies.
   *  Returns the world hit point (so a shot stops at the first real surface, not
   *  tunnelling through fallen rubble to the wall behind it). */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): { x: number; y: number; z: number } | null {
    const hit = this.world.castRayClosest({ x: ox, y: oy, z: oz }, { x: dx * maxDist, y: dy * maxDist, z: dz * maxDist })
    if (!hit.hit) return null
    if (hit.point) return { x: hit.point.x, y: hit.point.y, z: hit.point.z }
    const f = hit.fraction ?? 0
    return { x: ox + dx * maxDist * f, y: oy + dy * maxDist * f, z: oz + dz * maxDist * f }
  }

  castRayBody(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): BodyRayHit | null {
    const hit = this.world.castRayClosest(
      { x: ox, y: oy, z: oz },
      { x: dx * maxDist, y: dy * maxDist, z: dz * maxDist },
    )
    if (!hit.hit || !hit.bodyUserData) return null
    const body = this.bodies.get(hit.bodyUserData)
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
export async function createBox3DPhysics(
  sim: Sim,
  region?: { cx0: number; cy0: number; cz0: number; cx1: number; cy1: number; cz1: number },
): Promise<Box3DPhysicsWorld> {
  const phys = await Box3DPhysicsWorld.create()
  registerDestructionOps(sim, phys)
  attachEditPhysics(sim, phys)
  sim.addSystem(() => phys.tick(sim))
  phys.initStatic(sim.world, region)
  return phys
}
