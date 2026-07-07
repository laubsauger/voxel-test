/**
 * B37 — distant LOD cells. The game frame is CPU-BOUND on three.js iterating
 * every region mesh once per render pass (main + shadow cascades). Full-detail
 * region meshes are therefore streamed only within a short radius; everything
 * from there out to the far view distance is drawn as a handful of big COARSE
 * cells instead of thousands of full region meshes.
 *
 * A cell spans CELL_CHUNKS² chunks in x/z (full height). Its voxels are
 * downsampled 1-per-STRIDE³ block into a small grid, greedy-meshed by meshCoarse
 * (no AO, no worker — cheap), and drawn as ONE mesh scaled back up by STRIDE.
 * One 16×16-chunk cell replaces ~256 chunks' worth of region meshes, so the far
 * field costs ~16× fewer draw objects. LOD cells sit beyond the shadow range, so
 * they neither cast nor receive shadows — they cost exactly one main-pass draw.
 *
 * Read-only view of the ChunkStore (V6): getVoxel reads only, never mutates sim.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  Sphere,
  Vector3,
  type Material,
  type Object3D,
} from 'three'
import { CHUNK, VOXEL_SIZE, WORLD_CX, WORLD_CY, WORLD_CZ, chunkIndex, type ChunkStore } from '../world/chunks'
import type { LodMeshRequest, LodMeshResponse } from './lod-worker'
import type { ChunkMesh } from './mesher'

const CELL_CHUNKS = 16 // cell = 16×16 chunks in x/z → 51.2 m
const STRIDE = 4 // downsample: one big-voxel per 4³ world voxels
const CELL_VX = CELL_CHUNKS * CHUNK // 512 world voxels per cell edge
const CELL_M = CELL_VX * VOXEL_SIZE // 51.2 m
const GRID = CELL_VX / STRIDE // 128 big-voxels per cell edge
const CELLS_X = Math.ceil(WORLD_CX / CELL_CHUNKS)
const CELLS_Z = Math.ceil(WORLD_CZ / CELL_CHUNKS)
const WORLD_VY = WORLD_CY * CHUNK

/** LOD shown from here out (slightly inside the full-mesh radius → no seam gap) */
const LOD_NEAR = 90
/** far view distance — LOD evicted beyond this */
const LOD_FAR = 340
const LOD_NEAR2 = LOD_NEAR * LOD_NEAR
const LOD_FAR2 = LOD_FAR * LOD_FAR
/** coarse cells built per frame (each is cheap but not free) */
const BUILD_BUDGET = 2

interface Vec3Like {
  x: number
  y: number
  z: number
}

interface Cell {
  opaque?: Mesh
  transparent?: Mesh
  /** T90 — generation of the in-flight/applied worker build */
  gen?: number
}

export class LodManager {
  private readonly cells = new Map<number, Cell>()
  private lastCamCellX = Infinity
  private lastCamCellZ = Infinity
  private buildQueue: number[] = []
  /** T90 — meshCoarse runs in a worker; gen guards evict/rebuild races */
  private readonly worker: Worker
  private gen = 0

  constructor(
    private readonly world: ChunkStore,
    private readonly parent: Object3D,
    private readonly material: Material,
    private readonly transparentMaterial: Material,
    /** B37 — true once the full-detail meshes for world (x,z) exist; a near
     *  coarse cell is held until then so the building never vanishes mid-approach */
    private readonly isMeshedAt: (x: number, z: number) => boolean,
  ) {
    this.worker = new Worker(new URL('./lod-worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent<LodMeshResponse>) => {
      const { ci, gen, opaque, transparent } = e.data
      const cell = this.cells.get(ci)
      if (!cell || cell.gen !== gen) return // evicted or rebuilt meanwhile
      const cellX = ci % CELLS_X
      const cellZ = (ci / CELLS_X) | 0
      cell.opaque = this.makeMesh(opaque, cellX * CELL_VX, cellZ * CELL_VX, this.material)
      cell.transparent = this.makeMesh(transparent, cellX * CELL_VX, cellZ * CELL_VX, this.transparentMaterial)
    }
  }

  /** stream coarse LOD cells around the camera (call once per frame) */
  update(cam: Vec3Like): void {
    const camCellX = Math.floor(cam.x / CELL_M)
    const camCellZ = Math.floor(cam.z / CELL_M)
    if (camCellX !== this.lastCamCellX || camCellZ !== this.lastCamCellZ) {
      this.lastCamCellX = camCellX
      this.lastCamCellZ = camCellZ
      this.reclassify(cam)
    }
    // B37 — per-frame: evict a NEAR cell only once its full-detail meshes are
    // actually present (mesh-ready check changes continuously, not just on cell
    // crossings). Until then the coarse cell stays and fills the gap.
    for (const ci of [...this.cells.keys()]) {
      const d2 = this.cellDist2(ci, cam)
      if (d2 < LOD_NEAR2 && this.cellMeshed(ci)) this.evictCell(ci)
    }
    // drain the build queue under a per-frame budget
    let built = 0
    while (built < BUILD_BUDGET && this.buildQueue.length > 0) {
      const ci = this.buildQueue.shift()!
      if (this.cells.has(ci)) continue // already built (or re-queued)
      this.buildCell(ci)
      built++
    }
  }

  /** are the full-detail meshes present across the WHOLE cell? T91 — the old
   *  centre-only sample evicted the coarse mesh while EDGE regions were still
   *  streaming in: a whole segment vanished, then popped back at full detail.
   *  Centre AND all four (inset) corners must be meshed before the coarse
   *  stand-in may go — replace-in-place, never vanish-first. */
  private cellMeshed(ci: number): boolean {
    const cx = ci % CELLS_X
    const cz = (ci / CELLS_X) | 0
    const x0 = cx * CELL_M
    const z0 = cz * CELL_M
    const in1 = CELL_M * 0.08 // sample just inside the border regions
    const in2 = CELL_M - in1
    return (
      this.isMeshedAt(x0 + CELL_M / 2, z0 + CELL_M / 2) &&
      this.isMeshedAt(x0 + in1, z0 + in1) &&
      this.isMeshedAt(x0 + in2, z0 + in1) &&
      this.isMeshedAt(x0 + in1, z0 + in2) &&
      this.isMeshedAt(x0 + in2, z0 + in2)
    )
  }

  /** decide which cells should have LOD meshes, evict the rest, queue new ones */
  private reclassify(cam: Vec3Like): void {
    // evict cells too FAR (far side); NEAR-side eviction waits for the full mesh
    // (handled per-frame in update via cellMeshed) so nothing pops out early.
    for (const ci of [...this.cells.keys()]) {
      const d2 = this.cellDist2(ci, cam)
      if (d2 >= LOD_FAR2 || (d2 < LOD_NEAR2 && this.cellMeshed(ci))) this.evictCell(ci)
    }
    // queue in-band cells that are missing, nearest first
    const want: { ci: number; d2: number }[] = []
    const reach = Math.ceil(LOD_FAR / CELL_M) + 1
    for (let cz = this.lastCamCellZ - reach; cz <= this.lastCamCellZ + reach; cz++) {
      if (cz < 0 || cz >= CELLS_Z) continue
      for (let cx = this.lastCamCellX - reach; cx <= this.lastCamCellX + reach; cx++) {
        if (cx < 0 || cx >= CELLS_X) continue
        const ci = cx + cz * CELLS_X
        if (this.cells.has(ci)) continue
        const d2 = this.cellDist2(ci, cam)
        // within LOD_FAR and either in the coarse band OR a near cell whose full
        // meshes aren't up yet (gap-fill on a fast/teleport approach)
        if (d2 < LOD_FAR2 && (d2 >= LOD_NEAR2 || !this.cellMeshed(ci))) want.push({ ci, d2 })
      }
    }
    want.sort((a, b) => a.d2 - b.d2)
    this.buildQueue = want.map((w) => w.ci)
  }

  /** squared horizontal distance from camera to the cell centre (metres) */
  private cellDist2(ci: number, cam: Vec3Like): number {
    const cx = ci % CELLS_X
    const cz = (ci / CELLS_X) | 0
    const wx = (cx + 0.5) * CELL_M
    const wz = (cz + 0.5) * CELL_M
    const dx = wx - cam.x
    const dz = wz - cam.z
    return dx * dx + dz * dz
  }

  /** downsample the cell's voxels, coarse-mesh them, add the meshes to the scene */
  private buildCell(ci: number): void {
    const cellX = ci % CELLS_X
    const cellZ = (ci / CELLS_X) | 0
    const vx0 = cellX * CELL_VX
    const vz0 = cellZ * CELL_VX
    const gridY = Math.ceil(WORLD_VY / STRIDE)
    const grid = new Uint8Array(GRID * gridY * GRID)
    const half = STRIDE >> 1
    let any = false
    // T90 — chunk-wise scan, IDENTICAL sample positions/output as the naive
    // per-voxel loop, which touched 3.1M positions per cell (~50-100ms — THE
    // boundary-cross hitch). Most chunks are Empty (skip 8³ samples at once)
    // or Uniform (bulk-fill); only mixed surface chunks pay per-sample reads.
    const perChunk = CHUNK / STRIDE
    const chunksY = Math.ceil(WORLD_VY / CHUNK)
    let maxBy = 0 // highest occupied sample row + 1 — meshCoarse skips empty sky
    for (let ccy = 0; ccy < chunksY; ccy++) {
      for (let ccz = 0; ccz < CELL_CHUNKS; ccz++) {
        for (let ccx = 0; ccx < CELL_CHUNKS; ccx++) {
          const probe = this.world.probeChunk(chunkIndex((vx0 >> 5) + ccx, ccy, (vz0 >> 5) + ccz))
          if (probe.kind === 'empty') continue
          const bx0 = ccx * perChunk
          const by0 = ccy * perChunk
          const bz0 = ccz * perChunk
          if (by0 + perChunk > maxBy) maxBy = by0 + perChunk
          if (probe.kind === 'uniform') {
            for (let dy = 0; dy < perChunk; dy++)
              for (let dz = 0; dz < perChunk; dz++)
                for (let dx = 0; dx < perChunk; dx++)
                  grid[bx0 + dx + (bz0 + dz) * GRID + (by0 + dy) * GRID * GRID] = probe.mat
            any = true
            continue
          }
          for (let dy = 0; dy < perChunk; dy++) {
            const wy = (by0 + dy) * STRIDE + half
            if (wy >= WORLD_VY) break
            for (let dz = 0; dz < perChunk; dz++) {
              const wz = vz0 + (bz0 + dz) * STRIDE + half
              for (let dx = 0; dx < perChunk; dx++) {
                const wx = vx0 + (bx0 + dx) * STRIDE + half
                const v = this.world.getVoxel(wx, wy, wz)
                if (v !== 0) {
                  grid[bx0 + dx + (bz0 + dz) * GRID + (by0 + dy) * GRID * GRID] = v
                  any = true
                }
              }
            }
          }
        }
      }
    }
    const cell: Cell = { gen: ++this.gen }
    this.cells.set(ci, cell)
    if (!any) return // empty cell (open sky/water gap) — occupies the slot, no mesh
    // T90 — greedy meshing runs in the LOD worker (the main-thread pass was
    // 36-82ms per cell = the boundary-cross hitch). Height-trimmed to the
    // occupied rows (identical output — the sky rows are all air); the mesh
    // arrives async and pops in a few frames later, same as chunk meshes.
    const gy = Math.min(maxBy, gridY)
    const req: LodMeshRequest = { ci, gen: cell.gen!, grid: grid.buffer as ArrayBuffer, gxz: GRID, gy }
    this.worker.postMessage(req, [grid.buffer as ArrayBuffer])
  }

  private makeMesh(m: ChunkMesh, vx0: number, vz0: number, material: Material): Mesh | undefined {
    if (m.quadCount === 0) return undefined
    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(m.positions, 3))
    geo.setAttribute('normal', new BufferAttribute(m.normals, 3))
    geo.setAttribute('uv', new BufferAttribute(m.uvs, 2))
    geo.setAttribute('mat', new BufferAttribute(m.materials, 1))
    geo.setAttribute('ao', new BufferAttribute(m.ao, 1))
    geo.setIndex(new BufferAttribute(m.indices, 1))
    const c = GRID / 2
    const cy = Math.ceil(WORLD_VY / STRIDE) / 2
    const r = Math.sqrt(c * c + cy * cy + c * c) + 1
    geo.boundingSphere = new Sphere(new Vector3(c, cy, c), r)
    const mesh = new Mesh(geo, material)
    // beyond the shadow range — pure main-pass geometry, one draw
    mesh.castShadow = false
    mesh.receiveShadow = false
    // P9 — sink the coarse cell 0.25 m so where it OVERLAPS the full-detail
    // meshes (the LOD_NEAR..render-distance band) the full ground wins the depth
    // test instead of z-fighting the coplanar coarse ground. 0.25 m is far above
    // z-buffer precision at 120 m+ yet visually imperceptible at that range.
    mesh.position.set(vx0 * VOXEL_SIZE, -0.25, vz0 * VOXEL_SIZE)
    mesh.scale.setScalar(STRIDE * VOXEL_SIZE) // coarse grid units → metres
    this.parent.add(mesh)
    return mesh
  }

  private evictCell(ci: number): void {
    const cell = this.cells.get(ci)
    if (!cell) return
    for (const mesh of [cell.opaque, cell.transparent]) {
      if (!mesh) continue
      this.parent.remove(mesh)
      mesh.geometry.dispose()
    }
    this.cells.delete(ci)
  }

  dispose(): void {
    this.worker.terminate() // T90
    for (const ci of [...this.cells.keys()]) this.evictCell(ci)
    this.buildQueue.length = 0
  }
}
