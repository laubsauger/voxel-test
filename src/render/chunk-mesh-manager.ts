/**
 * T6 — render-side chunk mesh manager. Consumes ChunkStore.drainDirty()
 * (the only sim→render handoff, V6: everything else is read-only), ships
 * chunk+neighbor voxel data to mesh workers, and swaps THREE.BufferGeometry
 * per chunk when results return.
 *
 * V7: dispatches and geometry swaps are both budgeted per frame; ordering
 * comes from the RemeshScheduler (near-camera first).
 */
import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  Sphere,
  Vector3,
  type Material,
  type Object3D,
} from 'three/webgpu'
import {
  CHUNK,
  CHUNK_COUNT,
  ChunkKind,
  VOXEL_SIZE,
  WORLD_CX,
  WORLD_CY,
  WORLD_CZ,
  chunkIndex,
  type ChunkStore,
} from '../world/chunks'
import { buildPaddedChunk } from './mesher'
import type { MeshRequest, MeshResponse } from './mesh-worker'
import { RemeshScheduler, chunkCenter, chunkCoords, type Vec3Like } from './remesh-scheduler'

/** render-side edit event (T14 hook) — dirty chunk + its center, world meters */
export interface EditInfo {
  ci: number
  center: Vec3Like
}

export interface ChunkMeshManagerOptions {
  /** parent for chunk meshes (usually the scene) */
  parent: Object3D
  /** read-only for us (V6): getVoxel/chunkAt reads + drainDirty handoff */
  world: ChunkStore
  material: Material
  workerCount?: number
  /** max worker dispatches per update() call (V7) */
  maxDispatchPerFrame?: number
  /** max geometry swaps per update() call (V7) */
  maxApplyPerFrame?: number
  /**
   * Where to pull dirty chunk indices from each frame. Defaults to
   * world.drainDirty(). When a sim system (physics) drains the store's dirty
   * set inside the tick, pass its re-exposed channel instead (e.g.
   * () => phys.drainRemesh()) — both sides draining the store would starve
   * one of them.
   */
  dirtySource?: () => number[]
}

export class ChunkMeshManager {
  /**
   * Render-side edit hook (T14): called once per update() with the chunks
   * the sim dirtied since last frame. Assign after the initial world build
   * to skip the world-gen flood.
   */
  onEdit: ((edits: EditInfo[]) => void) | null = null

  readonly scheduler = new RemeshScheduler()
  private readonly meshes = new Map<number, Mesh>()
  private readonly workers: Worker[] = []
  private readonly idle: number[] = []
  private readonly completed: MeshResponse[] = []
  /** latest dispatched (or invalidated) job version per chunk */
  private readonly versions = new Map<number, number>()
  private nextVersion = 1
  private readonly maxDispatchPerFrame: number
  private readonly maxApplyPerFrame: number
  private readonly parent: Object3D
  private readonly world: ChunkStore
  readonly material: Material
  private readonly dirtySource: () => number[]

  constructor(opts: ChunkMeshManagerOptions) {
    this.parent = opts.parent
    this.world = opts.world
    this.material = opts.material
    this.dirtySource = opts.dirtySource ?? (() => this.world.drainDirty())
    this.maxDispatchPerFrame = opts.maxDispatchPerFrame ?? 12
    this.maxApplyPerFrame = opts.maxApplyPerFrame ?? 12
    const workerCount =
      opts.workerCount ?? Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 4) - 1))
    for (let i = 0; i < workerCount; i++) {
      const w = new Worker(new URL('./mesh-worker.ts', import.meta.url), { type: 'module' })
      w.onmessage = (e: MessageEvent<MeshResponse>) => {
        this.completed.push(e.data)
        this.idle.push(i)
      }
      // V10 spirit: a dead mesher must not silently freeze world updates
      w.onerror = (e) => {
        throw new Error(`mesh worker ${i} failed: ${e.message}`)
      }
      this.workers.push(w)
      this.idle.push(i)
    }
  }

  /** queue every non-empty chunk — call once after initial world gen */
  enqueueAll(): void {
    for (let ci = 0; ci < CHUNK_COUNT; ci++) {
      if (this.world.chunkAt(ci).kind !== ChunkKind.Empty) this.scheduler.enqueue(ci)
    }
  }

  /** chunks queued but not yet dispatched (HUD / debugging) */
  get pendingCount(): number {
    return this.scheduler.size
  }

  get chunkMeshCount(): number {
    return this.meshes.size
  }

  /**
   * Per-frame pump: drain sim dirt, apply finished meshes, dispatch new
   * jobs — each step budgeted (V7). `camPos` in world meters.
   */
  update(camPos: Vec3Like): void {
    const dirty = this.dirtySource() // sole handoff from sim state (V6)
    if (dirty.length > 0) {
      if (this.onEdit) {
        this.onEdit(dirty.map((ci) => ({ ci, center: chunkCenter(ci) })))
      }
      for (const ci of dirty) {
        this.scheduler.enqueue(ci)
        // boundary faces + AO of face neighbors depend on this chunk
        for (const n of faceNeighbors(ci)) this.scheduler.enqueue(n)
      }
    }

    let applies = 0
    while (this.completed.length > 0 && applies < this.maxApplyPerFrame) {
      const r = this.completed.shift()!
      // drop stale results — a newer job for this chunk was dispatched
      if (r.version !== this.versions.get(r.ci)) continue
      this.applyResult(r)
      applies++
    }

    const budget = Math.min(this.idle.length, this.maxDispatchPerFrame)
    if (budget <= 0) return
    for (const ci of this.scheduler.take(budget, camPos)) {
      if (this.world.chunkAt(ci).kind === ChunkKind.Empty) {
        // no voxels ⇒ no faces; skip the worker round-trip and invalidate
        // any in-flight result so it can't resurrect a removed mesh
        this.versions.set(ci, this.nextVersion++)
        this.removeMesh(ci)
        continue
      }
      const [cx, cy, cz] = chunkCoords(ci)
      const padded = buildPaddedChunk((x, y, z) => this.world.getVoxel(x, y, z), cx, cy, cz)
      const version = this.nextVersion++
      this.versions.set(ci, version)
      const wi = this.idle.pop()!
      // buildPaddedChunk allocates a plain ArrayBuffer (never shared)
      const req: MeshRequest = { ci, version, padded: padded.buffer as ArrayBuffer }
      this.workers[wi].postMessage(req, [padded.buffer])
    }
  }

  private applyResult(r: MeshResponse): void {
    if (r.indices.length === 0) {
      this.removeMesh(r.ci)
      return
    }
    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(r.positions, 3))
    geo.setAttribute('normal', new BufferAttribute(r.normals, 3))
    geo.setAttribute('uv', new BufferAttribute(r.uvs, 2))
    geo.setAttribute('mat', new BufferAttribute(r.materials, 1))
    geo.setAttribute('ao', new BufferAttribute(r.ao, 1))
    geo.setIndex(new BufferAttribute(r.indices, 1))
    // known bounds: chunk-local cube — skip per-vertex bounds computation
    geo.boundingSphere = new Sphere(
      new Vector3(CHUNK / 2, CHUNK / 2, CHUNK / 2),
      (CHUNK / 2) * Math.sqrt(3) + 0.01,
    )
    const existing = this.meshes.get(r.ci)
    if (existing) {
      existing.geometry.dispose()
      existing.geometry = geo
      return
    }
    const mesh = new Mesh(geo, this.material)
    mesh.castShadow = true
    mesh.receiveShadow = true
    const [cx, cy, cz] = chunkCoords(r.ci)
    const size = CHUNK * VOXEL_SIZE
    mesh.position.set(cx * size, cy * size, cz * size)
    mesh.scale.setScalar(VOXEL_SIZE) // mesher emits voxel units
    this.meshes.set(r.ci, mesh)
    this.parent.add(mesh)
  }

  private removeMesh(ci: number): void {
    const mesh = this.meshes.get(ci)
    if (!mesh) return
    this.parent.remove(mesh)
    mesh.geometry.dispose()
    this.meshes.delete(ci)
  }

  dispose(): void {
    for (const w of this.workers) w.terminate()
    this.workers.length = 0
    this.idle.length = 0
    for (const ci of [...this.meshes.keys()]) this.removeMesh(ci)
    this.scheduler.clear()
  }
}

function faceNeighbors(ci: number): number[] {
  const [cx, cy, cz] = chunkCoords(ci)
  const out: number[] = []
  if (cx > 0) out.push(chunkIndex(cx - 1, cy, cz))
  if (cx < WORLD_CX - 1) out.push(chunkIndex(cx + 1, cy, cz))
  if (cy > 0) out.push(chunkIndex(cx, cy - 1, cz))
  if (cy < WORLD_CY - 1) out.push(chunkIndex(cx, cy + 1, cz))
  if (cz > 0) out.push(chunkIndex(cx, cy, cz - 1))
  if (cz < WORLD_CZ - 1) out.push(chunkIndex(cx, cy, cz + 1))
  return out
}
