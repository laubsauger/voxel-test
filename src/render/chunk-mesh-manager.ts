/**
 * T6 — render-side chunk mesh manager. Consumes ChunkStore.drainDirty()
 * (the only sim→render handoff, V6: everything else is read-only), ships
 * chunk+neighbor voxel data to mesh workers, and keeps CPU-side mesh data
 * per chunk.
 *
 * T35 — region batching: chunks are drawn as merged REGION³ (4×4×4) region
 * meshes, not one Mesh per chunk. The settled suburb is ~2437 non-empty
 * chunks = ~10k draws/frame across main + 3 CSM cascades (B2, 23fps);
 * merging into ~60 region meshes cuts that to a few hundred. Worker output
 * per chunk is cached; a dirty chunk marks its region and regions rebuild
 * by typed-array concatenation under a per-frame budget (V7).
 *
 * V7: dispatches, geometry data applies and region rebuilds are all budgeted
 * per frame; ordering comes from the RemeshScheduler (near-camera first).
 *
 * B3 — initial-load burst: until the pipeline first drains completely,
 * budgets and worker queue depth run much higher (nothing else competes for
 * the frame during world build), then drop to steady-state. All still
 * bounded per frame (V7).
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
import { buildPaddedChunk, type ChunkMesh } from './mesher'
import type { MeshRequest, MeshResponse } from './mesh-worker'
import { RemeshScheduler, chunkCenter, chunkCoords, type Vec3Like } from './remesh-scheduler'

/** render-side edit event (T14 hook) — dirty chunk + its center, world meters */
export interface EditInfo {
  ci: number
  center: Vec3Like
}

/** steady-state jobs queued per worker — keeps meshers fed between frames */
const WORKER_DEPTH = 2
/** initial-load burst (B3): deeper worker queues + bigger per-frame budgets */
const BURST_WORKER_DEPTH = 4
const BURST_DISPATCH = 24
const BURST_APPLY = 64
const BURST_REGION_BUILDS = 32

/** chunks per region edge — REGION³ chunks merge into one draw call (T35) */
export const REGION = 4
const REGION_CX = Math.ceil(WORLD_CX / REGION)
const REGION_CZ = Math.ceil(WORLD_CZ / REGION)

/** region index for a chunk index */
export function regionIndex(ci: number): number {
  const [cx, cy, cz] = chunkCoords(ci)
  const rx = (cx / REGION) | 0
  const ry = (cy / REGION) | 0
  const rz = (cz / REGION) | 0
  return rx + rz * REGION_CX + ry * REGION_CX * REGION_CZ
}

/** inverse of regionIndex: region index → [rx, ry, rz] */
export function regionCoords(ri: number): [number, number, number] {
  const rx = ri % REGION_CX
  const rz = Math.floor(ri / REGION_CX) % REGION_CZ
  const ry = Math.floor(ri / (REGION_CX * REGION_CZ))
  return [rx, ry, rz]
}

export interface ChunkMeshManagerOptions {
  /** parent for region meshes (usually the scene) */
  parent: Object3D
  /** read-only for us (V6): getVoxel/chunkAt reads + drainDirty handoff */
  world: ChunkStore
  material: Material
  workerCount?: number
  /** max worker dispatches per update() call (V7) */
  maxDispatchPerFrame?: number
  /** max chunk-mesh data applies per update() call (V7) */
  maxApplyPerFrame?: number
  /** max region geometry rebuilds per update() call (V7, T35) */
  maxRegionBuildsPerFrame?: number
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
  /** CPU-side mesh data per non-empty chunk — region rebuilds concat these */
  private readonly chunkData = new Map<number, ChunkMesh>()
  /** one merged Mesh per non-empty region (T35) */
  private readonly regionMeshes = new Map<number, Mesh>()
  /** regions whose chunkData changed since their last rebuild */
  private readonly dirtyRegions = new Set<number>()
  private readonly workers: Worker[] = []
  /** jobs currently queued per worker — dispatch fills to the depth limit */
  private readonly jobCount: number[] = []
  private inFlight = 0
  /** B3: burst budgets until the pipeline first drains completely */
  private initialBuild = true
  private readonly completed: MeshResponse[] = []
  /** latest dispatched (or invalidated) job version per chunk */
  private readonly versions = new Map<number, number>()
  private nextVersion = 1
  private readonly maxDispatchPerFrame: number
  private readonly maxApplyPerFrame: number
  private readonly maxRegionBuildsPerFrame: number
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
    this.maxRegionBuildsPerFrame = opts.maxRegionBuildsPerFrame ?? 8
    const workerCount =
      opts.workerCount ?? Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 4) - 1))
    for (let i = 0; i < workerCount; i++) {
      const w = new Worker(new URL('./mesh-worker.ts', import.meta.url), { type: 'module' })
      w.onmessage = (e: MessageEvent<MeshResponse>) => {
        this.completed.push(e.data)
        this.jobCount[i]--
        this.inFlight--
      }
      // V10 spirit: a dead mesher must not silently freeze world updates
      w.onerror = (e) => {
        throw new Error(`mesh worker ${i} failed: ${e.message}`)
      }
      this.workers.push(w)
      this.jobCount.push(0)
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

  /** chunks with live mesh data (drawn merged into region meshes, T35) */
  get chunkMeshCount(): number {
    return this.chunkData.size
  }

  /** merged region meshes in the scene = draw calls per pass (T35) */
  get regionMeshCount(): number {
    return this.regionMeshes.size
  }

  /**
   * Per-frame pump: drain sim dirt, apply finished meshes, dispatch new
   * jobs, rebuild dirty region geometries — each step budgeted (V7).
   * `camPos` in world meters.
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

    // B3: burst budgets during the initial world build, steady-state after
    const burst = this.initialBuild
    const maxApply = burst ? Math.max(this.maxApplyPerFrame, BURST_APPLY) : this.maxApplyPerFrame
    const maxDispatch = burst
      ? Math.max(this.maxDispatchPerFrame, BURST_DISPATCH)
      : this.maxDispatchPerFrame
    const maxBuilds = burst
      ? Math.max(this.maxRegionBuildsPerFrame, BURST_REGION_BUILDS)
      : this.maxRegionBuildsPerFrame
    const depth = burst ? BURST_WORKER_DEPTH : WORKER_DEPTH

    let applies = 0
    while (this.completed.length > 0 && applies < maxApply) {
      const r = this.completed.shift()!
      // drop stale results — a newer job for this chunk was dispatched
      if (r.version !== this.versions.get(r.ci)) continue
      this.applyResult(r)
      applies++
    }

    let slots = 0
    for (const c of this.jobCount) slots += Math.max(0, depth - c)
    const budget = Math.min(slots, maxDispatch)
    for (const ci of this.scheduler.take(budget, camPos)) {
      if (this.world.chunkAt(ci).kind === ChunkKind.Empty) {
        // no voxels ⇒ no faces; skip the worker round-trip and invalidate
        // any in-flight result so it can't resurrect a removed mesh
        this.versions.set(ci, this.nextVersion++)
        if (this.chunkData.delete(ci)) this.dirtyRegions.add(regionIndex(ci))
        continue
      }
      const [cx, cy, cz] = chunkCoords(ci)
      const padded = buildPaddedChunk((x, y, z) => this.world.getVoxel(x, y, z), cx, cy, cz)
      const version = this.nextVersion++
      this.versions.set(ci, version)
      // least-loaded worker keeps queues even (workerCount ≤ 4)
      let wi = 0
      for (let i = 1; i < this.jobCount.length; i++) {
        if (this.jobCount[i] < this.jobCount[wi]) wi = i
      }
      this.jobCount[wi]++
      this.inFlight++
      // buildPaddedChunk allocates a plain ArrayBuffer (never shared)
      const req: MeshRequest = { ci, version, padded: padded.buffer as ArrayBuffer }
      this.workers[wi].postMessage(req, [padded.buffer])
    }

    let builds = 0
    for (const ri of this.dirtyRegions) {
      if (builds >= maxBuilds) break
      this.dirtyRegions.delete(ri)
      this.buildRegion(ri)
      builds++
    }

    // initial build over once the whole pipeline has drained once (B3)
    if (
      this.initialBuild &&
      this.scheduler.size === 0 &&
      this.inFlight === 0 &&
      this.completed.length === 0
    ) {
      this.initialBuild = false
    }
  }

  private applyResult(r: MeshResponse): void {
    if (r.indices.length === 0) this.chunkData.delete(r.ci)
    else this.chunkData.set(r.ci, r)
    this.dirtyRegions.add(regionIndex(r.ci))
  }

  /**
   * Rebuild one region's merged geometry from its member chunks' cached
   * mesh data (T35). Pure typed-array concatenation — positions offset by
   * the chunk's origin within the region (voxel units), indices rebased.
   */
  private buildRegion(ri: number): void {
    const [rx, ry, rz] = regionCoords(ri)
    const members: Array<[number, ChunkMesh]> = []
    let vtx = 0
    let idx = 0
    for (let dy = 0; dy < REGION; dy++) {
      const cy = ry * REGION + dy
      if (cy >= WORLD_CY) break
      for (let dz = 0; dz < REGION; dz++) {
        const cz = rz * REGION + dz
        if (cz >= WORLD_CZ) break
        for (let dx = 0; dx < REGION; dx++) {
          const cx = rx * REGION + dx
          if (cx >= WORLD_CX) break
          const d = this.chunkData.get(chunkIndex(cx, cy, cz))
          if (!d) continue
          members.push([chunkIndex(cx, cy, cz), d])
          vtx += d.positions.length / 3
          idx += d.indices.length
        }
      }
    }
    if (members.length === 0) {
      this.removeRegionMesh(ri)
      return
    }

    const positions = new Float32Array(vtx * 3)
    const normals = new Float32Array(vtx * 3)
    const uvs = new Float32Array(vtx * 2)
    const materials = new Float32Array(vtx)
    const ao = new Float32Array(vtx)
    const indices = new Uint32Array(idx)
    // tight bounds over member chunk cubes, region-local voxel units
    let minX = Infinity
    let minY = Infinity
    let minZ = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    let maxZ = -Infinity
    let vBase = 0
    let iBase = 0
    for (const [ci, d] of members) {
      const [cx, cy, cz] = chunkCoords(ci)
      const ox = (cx - rx * REGION) * CHUNK
      const oy = (cy - ry * REGION) * CHUNK
      const oz = (cz - rz * REGION) * CHUNK
      const n = d.positions.length / 3
      for (let v = 0; v < n; v++) {
        positions[(vBase + v) * 3] = d.positions[v * 3] + ox
        positions[(vBase + v) * 3 + 1] = d.positions[v * 3 + 1] + oy
        positions[(vBase + v) * 3 + 2] = d.positions[v * 3 + 2] + oz
      }
      normals.set(d.normals, vBase * 3)
      uvs.set(d.uvs, vBase * 2)
      materials.set(d.materials, vBase)
      ao.set(d.ao, vBase)
      for (let i = 0; i < d.indices.length; i++) indices[iBase + i] = d.indices[i] + vBase
      if (ox < minX) minX = ox
      if (oy < minY) minY = oy
      if (oz < minZ) minZ = oz
      if (ox + CHUNK > maxX) maxX = ox + CHUNK
      if (oy + CHUNK > maxY) maxY = oy + CHUNK
      if (oz + CHUNK > maxZ) maxZ = oz + CHUNK
      vBase += n
      iBase += d.indices.length
    }

    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(positions, 3))
    geo.setAttribute('normal', new BufferAttribute(normals, 3))
    geo.setAttribute('uv', new BufferAttribute(uvs, 2))
    geo.setAttribute('mat', new BufferAttribute(materials, 1))
    geo.setAttribute('ao', new BufferAttribute(ao, 1))
    geo.setIndex(new BufferAttribute(indices, 1))
    // known bounds: member chunk cubes — skip per-vertex bounds computation
    const hx = (maxX - minX) / 2
    const hy = (maxY - minY) / 2
    const hz = (maxZ - minZ) / 2
    geo.boundingSphere = new Sphere(
      new Vector3(minX + hx, minY + hy, minZ + hz),
      Math.sqrt(hx * hx + hy * hy + hz * hz) + 0.01,
    )

    const existing = this.regionMeshes.get(ri)
    if (existing) {
      existing.geometry.dispose()
      existing.geometry = geo
      return
    }
    const mesh = new Mesh(geo, this.material)
    mesh.castShadow = true
    mesh.receiveShadow = true
    const size = CHUNK * VOXEL_SIZE
    mesh.position.set(rx * REGION * size, ry * REGION * size, rz * REGION * size)
    mesh.scale.setScalar(VOXEL_SIZE) // mesher emits voxel units
    this.regionMeshes.set(ri, mesh)
    this.parent.add(mesh)
  }

  private removeRegionMesh(ri: number): void {
    const mesh = this.regionMeshes.get(ri)
    if (!mesh) return
    this.parent.remove(mesh)
    mesh.geometry.dispose()
    this.regionMeshes.delete(ri)
  }

  dispose(): void {
    for (const w of this.workers) w.terminate()
    this.workers.length = 0
    this.jobCount.length = 0
    this.inFlight = 0
    for (const ri of [...this.regionMeshes.keys()]) this.removeRegionMesh(ri)
    this.chunkData.clear()
    this.dirtyRegions.clear()
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
