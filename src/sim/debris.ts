/**
 * T86 — DebrisLayer: LOCAL (non-authoritative) Box3D rigid-body layer for
 * voxel-destruction debris in the main game (V17).
 *
 * The determinism boundary: WHICH voxels leave the world is decided by the
 * deterministic sim side (connectivity/stress/coarse passes in physics.ts) and
 * is hashed/lockstep-safe. WHAT the freed voxels do afterwards — the debris
 * bodies here — is simulated per machine with box3d-wasm and may diverge
 * between peers. Nothing in this file writes sim/world state, its ids are a
 * local counter (not sim entity ids, V17c), and it is excluded from I.hash.
 *
 * Behaviour ported from the spike (src/spike/box3d-physics.ts):
 *  - convex-hull bodies per debris piece, big islands fragmented into chunks
 *  - per-material friction/restitution (materialFeel), air damping,
 *    per-tick velocity clamps (box3d has no per-body max velocity)
 *  - mass-scaled launch velocity (heavy slabs lurch, pebbles fly)
 *  - FREEZE: settled pieces flip dynamic→static keeping shape+orientation
 *    (render batches them); a blast/shot unfreezes
 *  - static chunk colliders streamed only near ACTIVE (moving) debris
 *  - kill plane + local body cap (visual-only cap — voxels are already gone)
 */
import Box3D, { type B3Body, type B3World } from 'box3d-wasm/standard'
import { CHUNK, ChunkKind, VOXEL_SIZE, WORLD_CX, WORLD_CZ, chunkIndex, type ChunkStore } from '../world/chunks'
import { greedyBoxes } from './greedy-boxes'
import { MAT_FLAG_FLOATS, material, VOXEL_VOLUME } from './materials'
import type { IslandVoxel } from './connectivity'
import type { DynamicBody, BodyRayHit } from './iphysics'
import { materialFeel } from './physics'
import { computeBuoyancy, type Vec3 } from './water/buoyancy'
import type { WaterSim } from './water/water-sim'

const GRAVITY_Y = -9.81
const MAX_LIN = 28 // m/s — clamped every tick
const MAX_ANG = 14 // rad/s
const LINEAR_DAMPING = 0.06
const ANGULAR_DAMPING = 0.25
const KILL_PLANE_Y = -10
const SUB_STEPS = 4
/** rest detection: BOTH linear and angular slow (a tipping tower is not at rest) */
const REST_SPEED_SQ = 0.09
const REST_ANG_SQ = 0.09
const FREEZE_TICKS = 55
/** launch speed is full at/below this mass (kg), falls off ∝ 1/mass above */
const MASS_REF = 12
/** islands bigger than this fragment into F³-ish chunks (no monolith hulls) */
const MONOLITH_MAX = 220
const FRAGMENT = 6
/** local cap on ACTIVE bodies — beyond it, freed voxels simply vanish (local-only,
 *  V17a: never gates a world mutation) */
const ACTIVE_CAP = 500
/** hull point cap — beyond it fall back to bbox corners */
const MAX_HULL_POINTS = 1600
/** collider streaming: chunks within this many chunks of an active body AABB */
const COLLIDER_MARGIN_CHUNKS = 1
const COLLIDER_BUILD_BUDGET = 8
/** evict colliders unneeded for this many ticks */
const COLLIDER_EVICT_TICKS = 240
/** B23/T88 — deferred island-piece hull creations per step */
const SPAWN_BUDGET = 24

/** counters only — no wall-clock in src/sim (V2 purity scan); render-layer
 *  profilers time the layer from outside if needed */
export interface DebrisProfile {
  active: number
  frozen: number
  chunkColliders: number
}

export class DebrisLayer {
  readonly bodies = new Map<number, DynamicBody>()
  readonly frozen = new Set<number>()
  readonly prof: DebrisProfile = { active: 0, frozen: 0, chunkColliders: 0 }
  private readonly owned = new WeakSet<DynamicBody>()
  private world!: B3World
  private nextId = 1
  private tickNo = 0
  private readonly chunkBodies = new Map<number, B3Body[]>()
  private readonly chunkLastNeeded = new Map<number, number>()
  /** spawn BATCH per body — damageBodiesSphere skips same-batch ejecta (a blast
   *  must not instantly re-carve the debris it just created). The batch bumps at
   *  step END, so last tick's spawns ARE damageable by this tick's ops. */
  private readonly spawnedAt = new Map<number, number>()
  private batch = 0
  /** B23/T88 — voxel sets awaiting budgeted hull creation (islands) */
  private readonly pendingSpawns: IslandVoxel[][] = []

  static async create(): Promise<DebrisLayer> {
    const layer = new DebrisLayer()
    const b3 = await Box3D()
    layer.world = new b3.World({ gravity: { x: 0, y: GRAVITY_Y, z: 0 } })
    layer.world.enableContinuous(true)
    layer.world.enableSleeping(true)
    return layer
  }

  owns(b: DynamicBody): boolean {
    return this.owned.has(b)
  }

  get activeCount(): number {
    return this.bodies.size - this.frozen.size
  }

  // --- spawning ---------------------------------------------------------------

  /**
   * Freed voxels → local debris bodies. Fragments big sets; silently drops
   * pieces beyond ACTIVE_CAP (voxels already left the world deterministically).
   * Returns the first spawned body or null (callers only use it for velocity).
   */
  spawnDebris(voxels: IslandVoxel[]): DynamicBody | null {
    if (voxels.length === 0) return null
    if (voxels.length <= MONOLITH_MAX) return this.spawnPiece(voxels)
    const frags = this.fragment(voxels)
    let first: DynamicBody | null = null
    for (const a of frags) {
      const b = this.spawnPiece(a)
      first ??= b
    }
    return first
  }

  /** B23/T88 — deferred spawn: pieces queue and materialize ≤ SPAWN_BUDGET per
   *  step (hull creation off the edit tick's critical path). For islands — no
   *  caller needs the body handle back (ejecta use spawnDebris for velocity). */
  spawnDeferred(voxels: IslandVoxel[]): void {
    if (voxels.length === 0) return
    if (voxels.length <= MONOLITH_MAX) {
      this.pendingSpawns.push(voxels)
      return
    }
    for (const a of this.fragment(voxels)) this.pendingSpawns.push(a)
  }

  private fragment(voxels: IslandVoxel[]): IslandVoxel[][] {
    const frags = new Map<number, IslandVoxel[]>()
    for (const v of voxels) {
      const key = ((v.x / FRAGMENT) | 0) | (((v.z / FRAGMENT) | 0) << 10) | (((v.y / FRAGMENT) | 0) << 20)
      let a = frags.get(key)
      if (!a) { a = []; frags.set(key, a) }
      a.push(v)
    }
    return [...frags.values()]
  }

  private spawnPiece(vs: IslandVoxel[]): DynamicBody | null {
    if (this.activeCount >= ACTIVE_CAP) return null // local visual cap (V17a)
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
    this.attachHull(body, grid, sx, sy, sz, mat)
    const id = this.nextId++
    body.setUserData(id) // raycast → body lookup

    const entity: DynamicBody = {
      id,
      sx, sy, sz, grid,
      count: vs.length,
      mass, mat,
      px: x0 * VOXEL_SIZE, py: y0 * VOXEL_SIZE, pz: z0 * VOXEL_SIZE,
      qx: 0, qy: 0, qz: 0, qw: 1,
      body,
      version: 0,
      restTicks: 0,
    }
    this.bodies.set(entity.id, entity)
    this.owned.add(entity)
    this.spawnedAt.set(entity.id, this.batch)
    return entity
  }

  private attachHull(body: B3Body, grid: Uint8Array, sx: number, sy: number, sz: number, mat: number): void {
    const density = Math.max(0.2, material(mat).density)
    const feel = materialFeel(mat)
    const shape = body.createHull({ points: hullPoints(grid, sx, sy, sz), density })
    shape.setFriction(Math.max(0.6, feel.friction)) // debris grips, never skates
    shape.setRestitution(Math.min(0.1, feel.restitution))
    body.applyMassFromShapes()
    body.setLinearDamping(LINEAR_DAMPING)
    body.setAngularDamping(ANGULAR_DAMPING)
  }

  /** launch velocity, scaled down by mass (fixed impulse feel) + clamped */
  setVelocity(b: DynamicBody, vx: number, vy: number, vz: number, wx: number, wy: number, wz: number): void {
    if (!this.owns(b)) return
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

  // --- buoyancy (T17→T86: local visual forces; reads water, writes nothing) -----

  /** ids buoyant this tick — a floater must keep floating, never freeze */
  private readonly wet = new Set<number>()

  /** apply buoyancy to floats-flagged debris. LOCAL (V17): reads the water field,
   *  mutates only layer bodies. Same FloatingBodyAdapter sampling as the Jolt
   *  path (buoyancy-coupling.ts), constants shared by copy. */
  applyBuoyancy(water: WaterSim): void {
    this.wet.clear()
    if (this.bodies.size === 0) return
    for (const b of this.bodies.values()) {
      if ((material(b.mat).flags & MAT_FLAG_FLOATS) === 0) continue
      const stride = b.count > 512 ? 2 : 1
      const sampleVolume = VOXEL_VOLUME * stride * stride * stride
      const { qx, qy, qz, qw, px, py, pz } = b
      const samples: Vec3[] = []
      for (let y = 0; y < b.sy; y += stride)
        for (let z = 0; z < b.sz; z += stride)
          for (let x = 0; x < b.sx; x += stride) {
            if (b.grid[x + z * b.sx + y * b.sx * b.sz] === 0) continue
            const lx = (x + 0.5) * VOXEL_SIZE
            const ly = (y + 0.5) * VOXEL_SIZE
            const lz = (z + 0.5) * VOXEL_SIZE
            const cx1 = qy * lz - qz * ly + qw * lx
            const cy1 = qz * lx - qx * lz + qw * ly
            const cz1 = qx * ly - qy * lx + qw * lz
            samples.push({
              x: px + lx + 2 * (qy * cz1 - qz * cy1),
              y: py + ly + 2 * (qz * cx1 - qx * cz1),
              z: pz + lz + 2 * (qx * cy1 - qy * cx1),
            })
          }
      if (samples.length === 0) continue
      const body = b.body as B3Body
      const com = body.getWorldCenterOfMass()
      const vel = body.getLinearVelocity()
      const r = computeBuoyancy(
        (x, y, z) => water.levelAt(x, y, z),
        { samples, sampleVolume, centerOfMass: com, velocity: vel },
        { linearDrag: 900 },
      )
      if (r.submergedFraction === 0) continue
      this.wet.add(b.id)
      this.unfreeze(b) // rising water re-floats settled wood
      body.applyForceToCenter({ x: r.force.x, y: r.force.y, z: r.force.z }, true)
      body.applyTorque({ x: r.torque.x, y: r.torque.y, z: r.torque.z }, true)
      const k = 1 - 0.08 * r.submergedFraction // bob, don't pirouette
      const av = body.getAngularVelocity()
      body.setAngularVelocity({ x: av.x * k, y: av.y * k, z: av.z * k })
    }
  }

  // --- freeze / wake ------------------------------------------------------------

  private freezePass(): void {
    for (const b of this.bodies.values()) {
      if (this.frozen.has(b.id) || b.restTicks < FREEZE_TICKS) continue
      if (this.wet.has(b.id)) continue // floating pieces keep floating
      ;(b.body as B3Body).setType('static')
      this.frozen.add(b.id)
    }
  }

  unfreeze(b: DynamicBody): void {
    if (!this.frozen.delete(b.id)) return
    ;(b.body as B3Body).setType('dynamic')
    b.restTicks = 0
  }

  // --- damage / impulses ---------------------------------------------------------

  applyRadialImpulse(cx: number, cy: number, cz: number, radius: number, strength: number): void {
    const r2 = radius * radius
    for (const b of this.bodies.values()) {
      const dx = b.px - cx, dy = b.py - cy, dz = b.pz - cz
      const d2 = dx * dx + dy * dy + dz * dz
      if (d2 > r2) continue
      const d = Math.sqrt(d2) || 1e-6
      const mag = strength * (1 - d / radius)
      if (mag <= 0) continue
      this.unfreeze(b)
      ;(b.body as B3Body).applyLinearImpulseToCenter(
        { x: (dx / d) * mag, y: d2 < 1e-6 ? mag : (dy / d) * mag, z: (dz / d) * mag },
        true,
      )
    }
  }

  impulseBodyAt(b: DynamicBody, ix: number, iy: number, iz: number, px: number, py: number, pz: number): void {
    if (!this.owns(b)) return
    this.unfreeze(b)
    ;(b.body as B3Body).applyLinearImpulse({ x: ix, y: iy, z: iz }, { x: px, y: py, z: pz }, true)
  }

  /** carve a body's voxel grid in a world sphere; rebuild hull or despawn */
  damageBodySphere(b: DynamicBody, wx: number, wy: number, wz: number, rMeters: number): number {
    if (!this.owns(b)) return 0
    this.unfreeze(b)
    const body = b.body as B3Body
    const p = body.getPosition()
    const q = body.getRotation()
    const inv = { x: -q.x, y: -q.y, z: -q.z, w: q.w }
    const rel = rotate(inv, { x: wx - p.x, y: wy - p.y, z: wz - p.z })
    const cx = rel.x / VOXEL_SIZE, cy = rel.y / VOXEL_SIZE, cz = rel.z / VOXEL_SIZE
    const rv = rMeters / VOXEL_SIZE
    const rv2 = rv * rv
    let removed = 0
    for (let y = 0; y < b.sy; y++)
      for (let z = 0; z < b.sz; z++)
        for (let x = 0; x < b.sx; x++) {
          const i = x + z * b.sx + y * b.sx * b.sz
          if (b.grid[i] === 0) continue
          const dx = x + 0.5 - cx, dy = y + 0.5 - cy, dz = z + 0.5 - cz
          if (dx * dx + dy * dy + dz * dz <= rv2) { b.grid[i] = 0; removed++ }
        }
    if (removed === 0) return 0
    b.count -= removed
    if (b.count <= 0) { this.despawn(b.id); return removed }
    const lv = body.getLinearVelocity()
    const av = body.getAngularVelocity()
    const nb = this.world.createBody({ type: 'dynamic', position: p })
    this.attachHull(nb, b.grid, b.sx, b.sy, b.sz, b.mat)
    nb.setUserData(b.id)
    nb.setTransform({ position: p, rotation: q })
    nb.setLinearVelocity(lv)
    nb.setAngularVelocity(av)
    body.destroy()
    b.body = nb
    b.version++
    return removed
  }

  damageBodiesSphere(wx: number, wy: number, wz: number, rMeters: number): void {
    for (const b of [...this.bodies.values()]) {
      if (this.spawnedAt.get(b.id) === this.batch) continue // same-batch (same-blast) ejecta
      const dx = b.px - wx, dy = b.py - wy, dz = b.pz - wz
      const reach = rMeters + Math.max(b.sx, b.sy, b.sz) * VOXEL_SIZE
      if (dx * dx + dy * dy + dz * dz > reach * reach) continue
      this.damageBodySphere(b, wx, wy, wz, rMeters)
    }
  }

  /** nearest debris body along a ray — LOCAL (V17b: never gates world edits) */
  castRayBody(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): BodyRayHit | null {
    const hit = this.world.castRayClosest({ x: ox, y: oy, z: oz }, { x: dx * maxDist, y: dy * maxDist, z: dz * maxDist })
    if (!hit.hit || !hit.bodyUserData) return null
    const body = this.bodies.get(hit.bodyUserData)
    if (!body) return null
    const f = hit.fraction ?? 0
    const pt = hit.point ?? { x: ox + dx * maxDist * f, y: oy + dy * maxDist * f, z: oz + dz * maxDist * f }
    const n = hit.normal ?? { x: 0, y: 1, z: 0 }
    return { body, fraction: f, px: pt.x, py: pt.y, pz: pt.z, nx: n.x, ny: n.y, nz: n.z }
  }

  // --- per-tick ------------------------------------------------------------------

  /** step the local world; call once per sim tick AFTER the deterministic sim */
  step(world: ChunkStore, dt: number): void {
    this.tickNo++
    // budgeted deferred spawns (island pieces) — hulls come up over a few ticks
    let spawned = 0
    while (this.pendingSpawns.length > 0 && spawned < SPAWN_BUDGET) {
      const vs = this.pendingSpawns.shift()!
      this.spawnPiece(vs)
      spawned++
    }
    this.streamColliders(world)
    if (this.activeCount > 0) this.world.step(dt, SUB_STEPS)
    this.readback()
    this.freezePass()
    this.killPlane()
    this.prof.active = this.activeCount
    this.prof.frozen = this.frozen.size
    this.prof.chunkColliders = this.chunkBodies.size
    this.batch++ // end-of-step: next tick's ops may damage this step's spawns
  }

  private readback(): void {
    for (const b of this.bodies.values()) {
      if (this.frozen.has(b.id)) continue
      const body = b.body as B3Body
      const p = body.getPosition()
      b.px = p.x; b.py = p.y; b.pz = p.z
      const q = body.getRotation()
      b.qx = q.x; b.qy = q.y; b.qz = q.z; b.qw = q.w
      let lv = body.getLinearVelocity()
      let av = body.getAngularVelocity()
      const sp2raw = lv.x * lv.x + lv.y * lv.y + lv.z * lv.z
      if (sp2raw > MAX_LIN * MAX_LIN) {
        const s = MAX_LIN / Math.sqrt(sp2raw)
        body.setLinearVelocity({ x: lv.x * s, y: lv.y * s, z: lv.z * s })
        lv = body.getLinearVelocity()
      }
      const asp2raw = av.x * av.x + av.y * av.y + av.z * av.z
      if (asp2raw > MAX_ANG * MAX_ANG) {
        const s = MAX_ANG / Math.sqrt(asp2raw)
        body.setAngularVelocity({ x: av.x * s, y: av.y * s, z: av.z * s })
        av = body.getAngularVelocity()
      }
      const sp2 = lv.x * lv.x + lv.y * lv.y + lv.z * lv.z
      const asp2 = av.x * av.x + av.y * av.y + av.z * av.z
      b.restTicks = sp2 < REST_SPEED_SQ && asp2 < REST_ANG_SQ ? b.restTicks + 1 : 0
    }
  }

  private killPlane(): void {
    let dead: number[] | undefined
    for (const b of this.bodies.values()) if (b.py < KILL_PLANE_Y) (dead ??= []).push(b.id)
    if (dead) for (const id of dead) this.despawn(id)
  }

  private despawn(id: number): void {
    const b = this.bodies.get(id)
    if (!b) return
    ;(b.body as B3Body).destroy()
    this.bodies.delete(id)
    this.frozen.delete(id)
    this.spawnedAt.delete(id)
  }

  // --- collider streaming ---------------------------------------------------------

  /** world chunks changed (deterministic side notifies) — rebuild if built */
  invalidateChunks(world: ChunkStore, chunkIndices: number[]): void {
    for (const ci of chunkIndices) if (this.chunkBodies.has(ci)) this.rebuildChunk(world, ci)
  }

  private streamColliders(world: ChunkStore): void {
    // needed = chunks overlapping any ACTIVE body's AABB (± margin)
    const needed = new Set<number>()
    for (const b of this.bodies.values()) {
      if (this.frozen.has(b.id)) continue
      const ex = Math.max(b.sx, Math.max(b.sy, b.sz)) * VOXEL_SIZE // rotated bound
      const c0x = Math.max(0, Math.floor((b.px - ex) / (CHUNK * VOXEL_SIZE)) - COLLIDER_MARGIN_CHUNKS)
      const c1x = Math.min(WORLD_CX - 1, Math.floor((b.px + ex) / (CHUNK * VOXEL_SIZE)) + COLLIDER_MARGIN_CHUNKS)
      const c0y = Math.max(0, Math.floor((b.py - ex) / (CHUNK * VOXEL_SIZE)) - COLLIDER_MARGIN_CHUNKS)
      const c1y = Math.floor((b.py + ex) / (CHUNK * VOXEL_SIZE)) + COLLIDER_MARGIN_CHUNKS
      const c0z = Math.max(0, Math.floor((b.pz - ex) / (CHUNK * VOXEL_SIZE)) - COLLIDER_MARGIN_CHUNKS)
      const c1z = Math.min(WORLD_CZ - 1, Math.floor((b.pz + ex) / (CHUNK * VOXEL_SIZE)) + COLLIDER_MARGIN_CHUNKS)
      for (let cy = c0y; cy <= c1y; cy++)
        for (let cz = c0z; cz <= c1z; cz++)
          for (let cx = c0x; cx <= c1x; cx++) needed.add(chunkIndex(cx, cy, cz))
    }
    let built = 0
    for (const ci of needed) {
      this.chunkLastNeeded.set(ci, this.tickNo)
      if (!this.chunkBodies.has(ci) && built < COLLIDER_BUILD_BUDGET) {
        this.rebuildChunk(world, ci)
        built++
      }
    }
    // evict long-unneeded
    for (const [ci, last] of this.chunkLastNeeded) {
      if (this.tickNo - last <= COLLIDER_EVICT_TICKS) continue
      const bodies = this.chunkBodies.get(ci)
      if (bodies) for (const b of bodies) b.destroy()
      this.chunkBodies.delete(ci)
      this.chunkLastNeeded.delete(ci)
    }
  }

  private rebuildChunk(world: ChunkStore, ci: number): void {
    const old = this.chunkBodies.get(ci)
    if (old) for (const b of old) b.destroy()
    this.chunkBodies.delete(ci)
    const cx = ci % WORLD_CX
    const cz = ((ci / WORLD_CX) | 0) % WORLD_CZ
    const cy = (ci / (WORLD_CX * WORLD_CZ)) | 0
    const ox = cx * CHUNK, oy = cy * CHUNK, oz = cz * CHUNK
    // direct chunk access (chunkAt inflates Palette) — no per-voxel getVoxel
    const c = world.chunkAt(ci)
    if (c.kind === ChunkKind.Empty || (c.kind === ChunkKind.Uniform && c.mat === 0)) {
      this.chunkBodies.set(ci, [])
      return
    }
    const boxes =
      c.kind === ChunkKind.Uniform
        ? [{ x: 0, y: 0, z: 0, sx: CHUNK, sy: CHUNK, sz: CHUNK }] // solid cube, 1 box
        : greedyBoxes(c.data!, CHUNK, CHUNK, CHUNK)
    const out: B3Body[] = []
    for (const b of boxes) {
      const body = this.world.createBody({
        type: 'static',
        position: {
          x: (ox + b.x + b.sx / 2) * VOXEL_SIZE,
          y: (oy + b.y + b.sy / 2) * VOXEL_SIZE,
          z: (oz + b.z + b.sz / 2) * VOXEL_SIZE,
        },
      })
      body.createBox({ halfExtents: { x: (b.sx / 2) * VOXEL_SIZE, y: (b.sy / 2) * VOXEL_SIZE, z: (b.sz / 2) * VOXEL_SIZE } })
      out.push(body)
    }
    this.chunkBodies.set(ci, out)
  }

  dispose(): void {
    for (const b of this.bodies.values()) (b.body as B3Body).destroy()
    this.bodies.clear()
    this.frozen.clear()
    for (const arr of this.chunkBodies.values()) for (const b of arr) b.destroy()
    this.chunkBodies.clear()
    this.world.destroy()
  }
}

/** convex-hull point cloud = unique solid-voxel corners, body-local metres */
function hullPoints(grid: Uint8Array, sx: number, sy: number, sz: number): Array<{ x: number; y: number; z: number }> {
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
    const out: Array<{ x: number; y: number; z: number }> = []
    for (let dz = 0; dz <= 1; dz++) for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++)
      out.push({ x: dx * sx * VOXEL_SIZE, y: dy * sy * VOXEL_SIZE, z: dz * sz * VOXEL_SIZE })
    return out
  }
  return pts
}

/** rotate a vec by a quaternion */
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
