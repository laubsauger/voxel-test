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
import { buildPaddedChunk, type ChunkMesh, type ChunkMeshStreams } from './mesher'
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

/**
 * T63 (B23) — region rebuild coalescing + time budget (steady state only).
 *
 * A single dig remeshes the edited chunk + 6 face neighbors; their worker
 * results trickle in over 2-3 frames, and each arrival re-dirtied the region,
 * so one dig rebuilt the same region geometry 2-3 times (full typed-array
 * concat + GPU re-upload each time). Steady state now defers a dirty region
 * while any member chunk still has a remesh queued or in flight, so the
 * region rebuilds ONCE per edit. Deferral is render-side only (V6) — the sim
 * never sees it.
 */
/** frames a dirty region may defer before rebuilding anyway (staleness cap) */
const MAX_REGION_DEFER = 8
/** per-frame wall-clock budget (ms) for region concat work — V7 gates the
 * actual rebuild time, not just the rebuild count */
const REGION_BUILD_MS_BUDGET = 3

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
  /**
   * T39: material for the transparent geometry stream (glass, water-solid).
   * Optional — without it transparent faces still build into the second
   * region mesh with the opaque material (visible, just not see-through).
   */
  transparentMaterial?: Material
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
  private readonly chunkData = new Map<number, ChunkMeshStreams>()
  /** one merged opaque Mesh per non-empty region (T35) */
  private readonly regionMeshes = new Map<number, Mesh>()
  /** one merged transparent Mesh per region with glass/water faces (T39) */
  private readonly regionMeshesT = new Map<number, Mesh>()
  /** regions whose chunkData changed since their last rebuild */
  private readonly dirtyRegions = new Set<number>()
  /** worker jobs outstanding per chunk (T63) — region deferral looks these up */
  private readonly pendingJobs = new Map<number, number>()
  /** frames each dirty region has been deferred (T63, capped) */
  private readonly regionDefers = new Map<number, number>()
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
  readonly transparentMaterial: Material
  private readonly dirtySource: () => number[]

  constructor(opts: ChunkMeshManagerOptions) {
    this.parent = opts.parent
    this.world = opts.world
    this.material = opts.material
    this.transparentMaterial = opts.transparentMaterial ?? opts.material
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

  /** queue every non-empty chunk — call once after initial world gen.
   * B32 — skip fully-buried solid chunks (every face internal): they mesh to
   * ZERO faces, so queuing them is pure wasted worker/scheduler time. At the 4×
   * world the sub-surface dirt slab alone is ~17k such chunks (~30% of the
   * initial queue). Skipping is behaviourally identical to today — a buried
   * chunk that a later edit exposes is re-dirtied through the normal edit path
   * (its own setVoxel), exactly as an already-empty-meshed one would be. */
  enqueueAll(): void {
    for (let ci = 0; ci < CHUNK_COUNT; ci++) {
      if (this.world.chunkAt(ci).kind === ChunkKind.Empty) continue
      if (this.isBuried(ci)) continue
      this.scheduler.enqueue(ci)
    }
  }

  /** true iff a Uniform-solid chunk has all 6 faces against solid voxels, so
   * the greedy mesher would emit nothing for it (V6: pure ChunkStore reads). */
  private isBuried(ci: number): boolean {
    const c = this.world.chunkAt(ci)
    if (c.kind !== ChunkKind.Uniform || c.mat === 0) return false
    const [cx, cy, cz] = chunkCoords(ci)
    return (
      this.faceSolid(cx - 1, cy, cz, 0, CHUNK - 1) && // neighbor -x, its x=31 layer
      this.faceSolid(cx + 1, cy, cz, 0, 0) && //           +x, x=0
      this.faceSolid(cx, cy - 1, cz, 1, CHUNK - 1) && //   -y, y=31
      this.faceSolid(cx, cy + 1, cz, 1, 0) && //           +y, y=0
      this.faceSolid(cx, cy, cz - 1, 2, CHUNK - 1) && //   -z, z=31
      this.faceSolid(cx, cy, cz + 1, 2, 0) //              +z, z=0
    )
  }

  /** is the boundary layer (axis 0=x/1=y/2=z at local `coord`) of the neighbor
   * chunk (ncx,ncy,ncz) fully solid? OOB below/side = solid (buried), OOB above
   * = open sky (not solid). Empty = air; Uniform = its mat; Dense = scan layer. */
  private faceSolid(ncx: number, ncy: number, ncz: number, axis: number, coord: number): boolean {
    if (ncy < 0) return true
    if (ncy >= WORLD_CY) return false
    if (ncx < 0 || ncz < 0 || ncx >= WORLD_CX || ncz >= WORLD_CZ) return true
    const c = this.world.chunkAt(chunkIndex(ncx, ncy, ncz))
    if (c.kind === ChunkKind.Empty) return false
    if (c.kind === ChunkKind.Uniform) return c.mat !== 0
    const d = c.data!
    // scan the 32×32 boundary plane; any air voxel means the face is exposed
    for (let a = 0; a < CHUNK; a++) {
      for (let b = 0; b < CHUNK; b++) {
        const vi =
          axis === 0
            ? coord + b * CHUNK + a * CHUNK * CHUNK // x fixed
            : axis === 1
              ? b + a * CHUNK + coord * CHUNK * CHUNK // y fixed
              : b + coord * CHUNK + a * CHUNK * CHUNK // z fixed
        if (d[vi] === 0) return false
      }
    }
    return true
  }

  /** chunks queued but not yet dispatched (HUD / debugging) */
  get pendingCount(): number {
    return this.scheduler.size
  }

  /** chunks with live mesh data (drawn merged into region meshes, T35) */
  get chunkMeshCount(): number {
    return this.chunkData.size
  }

  /** merged opaque region meshes in the scene = draw calls per pass (T35) */
  get regionMeshCount(): number {
    return this.regionMeshes.size
  }

  /** merged transparent region meshes (T39) — extra draws in the main pass only */
  get transparentRegionMeshCount(): number {
    return this.regionMeshesT.size
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
        // B32 — skip fully-buried solid chunks (mesh to nothing). The initial
        // world build feeds every chunk through here (via phys.drainRemesh from
        // initStatic), so this is where the ~17k sub-surface dirt chunks would
        // otherwise be queued. Safe for edits: digging exposes a face, so the
        // chunk is no longer buried and meshes normally.
        if (!this.isBuried(ci)) this.scheduler.enqueue(ci)
        // boundary faces + AO of face neighbors depend on this chunk
        for (const n of faceNeighbors(ci)) if (!this.isBuried(n)) this.scheduler.enqueue(n)
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
      const jobs = this.pendingJobs.get(r.ci)
      if (jobs !== undefined) {
        if (jobs <= 1) this.pendingJobs.delete(r.ci)
        else this.pendingJobs.set(r.ci, jobs - 1)
      }
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
      this.pendingJobs.set(ci, (this.pendingJobs.get(ci) ?? 0) + 1)
      // buildPaddedChunk allocates a plain ArrayBuffer (never shared)
      const req: MeshRequest = { ci, version, padded: padded.buffer as ArrayBuffer }
      this.workers[wi].postMessage(req, [padded.buffer])
    }

    // region rebuilds — count-budgeted; steady state additionally coalesces
    // (defer while member chunks are still remeshing) and time-gates the
    // concat work itself (T63, V7)
    let builds = 0
    const buildStart = performance.now()
    for (const ri of this.dirtyRegions) {
      if (builds >= maxBuilds) break
      if (!burst) {
        if (builds > 0 && performance.now() - buildStart > REGION_BUILD_MS_BUDGET) break
        const defers = this.regionDefers.get(ri) ?? 0
        if (defers < MAX_REGION_DEFER && this.regionHasPendingChunks(ri)) {
          this.regionDefers.set(ri, defers + 1)
          continue
        }
      }
      this.dirtyRegions.delete(ri)
      this.regionDefers.delete(ri)
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

  /**
   * T63 — true while any member chunk of the region is queued for remesh or
   * has a worker job outstanding; the region rebuild defers so one edit
   * produces one rebuild instead of one per result wave. 64 Set/Map lookups.
   */
  private regionHasPendingChunks(ri: number): boolean {
    const [rx, ry, rz] = regionCoords(ri)
    for (let dy = 0; dy < REGION; dy++) {
      const cy = ry * REGION + dy
      if (cy >= WORLD_CY) break
      for (let dz = 0; dz < REGION; dz++) {
        const cz = rz * REGION + dz
        if (cz >= WORLD_CZ) break
        for (let dx = 0; dx < REGION; dx++) {
          const cx = rx * REGION + dx
          if (cx >= WORLD_CX) break
          const ci = chunkIndex(cx, cy, cz)
          if (this.pendingJobs.has(ci) || this.scheduler.has(ci)) return true
        }
      }
    }
    return false
  }

  private applyResult(r: MeshResponse): void {
    if (r.opaque.indices.length === 0 && r.transparent.indices.length === 0) {
      this.chunkData.delete(r.ci)
    } else {
      this.chunkData.set(r.ci, { opaque: r.opaque, transparent: r.transparent })
    }
    this.dirtyRegions.add(regionIndex(r.ci))
  }

  /**
   * Rebuild one region's merged geometries from its member chunks' cached
   * mesh data (T35) — opaque + transparent streams (T39) each get their own
   * Mesh. Pure typed-array concatenation: positions offset by the chunk's
   * origin within the region (voxel units), indices rebased.
   */
  private buildRegion(ri: number): void {
    const [rx, ry, rz] = regionCoords(ri)
    const opaque: Array<[number, ChunkMesh]> = []
    const transparent: Array<[number, ChunkMesh]> = []
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
          const ci = chunkIndex(cx, cy, cz)
          if (d.opaque.indices.length > 0) opaque.push([ci, d.opaque])
          if (d.transparent.indices.length > 0) transparent.push([ci, d.transparent])
        }
      }
    }
    this.buildRegionStream(ri, opaque, this.regionMeshes, this.material, false)
    this.buildRegionStream(ri, transparent, this.regionMeshesT, this.transparentMaterial, true)
  }

  /** build/replace/remove one region Mesh for one geometry stream */
  private buildRegionStream(
    ri: number,
    members: Array<[number, ChunkMesh]>,
    meshes: Map<number, Mesh>,
    material: Material,
    isTransparent: boolean,
  ): void {
    if (members.length === 0) {
      removeRegionMesh(this.parent, meshes, ri)
      return
    }
    const [rx, ry, rz] = regionCoords(ri)
    let vtx = 0
    let idx = 0
    for (const [, d] of members) {
      vtx += d.positions.length / 3
      idx += d.indices.length
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

    const existing = meshes.get(ri)
    if (existing) {
      existing.geometry.dispose()
      existing.geometry = geo
      return
    }
    const mesh = new Mesh(geo, material)
    // T39: glass must not stamp full shadows — no shadow cast at all v1
    // (soft partial glass shadows would need a custom depth material)
    mesh.castShadow = !isTransparent
    mesh.receiveShadow = true
    const size = CHUNK * VOXEL_SIZE
    mesh.position.set(rx * REGION * size, ry * REGION * size, rz * REGION * size)
    mesh.scale.setScalar(VOXEL_SIZE) // mesher emits voxel units
    meshes.set(ri, mesh)
    this.parent.add(mesh)
  }

  dispose(): void {
    for (const w of this.workers) w.terminate()
    this.workers.length = 0
    this.jobCount.length = 0
    this.inFlight = 0
    for (const ri of [...this.regionMeshes.keys()]) removeRegionMesh(this.parent, this.regionMeshes, ri)
    for (const ri of [...this.regionMeshesT.keys()]) removeRegionMesh(this.parent, this.regionMeshesT, ri)
    this.chunkData.clear()
    this.dirtyRegions.clear()
    this.pendingJobs.clear()
    this.regionDefers.clear()
    this.scheduler.clear()
  }
}

function removeRegionMesh(parent: Object3D, meshes: Map<number, Mesh>, ri: number): void {
  const mesh = meshes.get(ri)
  if (!mesh) return
  parent.remove(mesh)
  mesh.geometry.dispose()
  meshes.delete(ri)
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
