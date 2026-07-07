/**
 * Coarse global support (never leave a building floating). The fine connectivity
 * + stress passes are region-limited for perf, so a severed base far below a tall
 * tower is never seen and the top hangs in the air. This keeps a DOWNSAMPLED
 * occupancy grid over the whole active region (one cell per D³ voxels), updated
 * incrementally as chunks change, and floods it globally from the ground each
 * edit. Any solid coarse cell not reachable from the ground is floating — its
 * voxel bounding region is handed to the fine findUnsupportedIslands to extract.
 *
 * Cheap because it is coarse: a 768×224×480 region at D=8 is ~160k cells, a
 * ~1ms flood, vs an 82M-voxel fine flood. Engine-agnostic (sim layer).
 */
import { CHUNK, ChunkKind, chunkIndex, WORLD_CX, WORLD_CZ, type ChunkStore } from '../world/chunks'
import type { Region } from './connectivity'

const D = 4 // coarse cell edge (voxels); divides CHUNK(32) → 8 cells/chunk/axis.
// D=4 so a typical blast gap (≥~8 voxels) yields a fully-empty cell layer that
// breaks coarse connectivity (D=8 aliased small gaps → false grounding).

export class CoarseSupport {
  private readonly cx0: number // region chunk-origin
  private readonly cy0: number
  private readonly cz0: number
  private readonly ncx: number // coarse dims
  private readonly ncy: number
  private readonly ncz: number
  private readonly count: Int32Array
  private readonly reached: Uint8Array
  private readonly stack: Int32Array

  constructor(region: { cx0: number; cy0: number; cz0: number; cx1: number; cy1: number; cz1: number }) {
    this.cx0 = region.cx0
    this.cy0 = region.cy0
    this.cz0 = region.cz0
    this.ncx = (region.cx1 - region.cx0 + 1) * (CHUNK / D)
    this.ncy = (region.cy1 - region.cy0 + 1) * (CHUNK / D)
    this.ncz = (region.cz1 - region.cz0 + 1) * (CHUNK / D)
    const n = this.ncx * this.ncy * this.ncz
    this.count = new Int32Array(n)
    this.reached = new Uint8Array(n)
    this.stack = new Int32Array(n)
  }

  private cell(gcx: number, gcy: number, gcz: number): number {
    return gcx + gcz * this.ncx + gcy * this.ncx * this.ncz
  }

  /** full build from the region's non-empty chunks (one-time at init) */
  rebuild(world: ChunkStore): void {
    this.count.fill(0)
    const cxEnd = this.cx0 + this.ncx / (CHUNK / D)
    const cyEnd = this.cy0 + this.ncy / (CHUNK / D)
    const czEnd = this.cz0 + this.ncz / (CHUNK / D)
    for (let cy = this.cy0; cy < cyEnd; cy++)
      for (let cz = this.cz0; cz < czEnd; cz++)
        for (let cx = this.cx0; cx < cxEnd; cx++) {
          if (world.chunkAt(chunkIndex(cx, cy, cz)).kind === ChunkKind.Empty) continue
          this.addChunk(world, cx, cy, cz)
        }
  }

  private addChunk(world: ChunkStore, cx: number, cy: number, cz: number): void {
    const per = CHUNK / D
    const bcx = (cx - this.cx0) * per, bcy = (cy - this.cy0) * per, bcz = (cz - this.cz0) * per
    const c = world.chunkAt(chunkIndex(cx, cy, cz))
    if (c.kind === ChunkKind.Uniform) {
      // uniform solid: every coarse cell is trivially full (D³ voxels)
      if (c.mat === 0) return
      for (let dy = 0; dy < per; dy++)
        for (let dz = 0; dz < per; dz++)
          for (let dx = 0; dx < per; dx++) this.count[this.cell(bcx + dx, bcy + dy, bcz + dz)] += D * D * D
      return
    }
    // Dense (chunkAt inflates Palette): read chunk data directly — no snapshot
    // copy. Layout: index = x + z*32 + y*1024 (world/chunks.ts).
    const data = c.data
    if (!data) return
    for (let ly = 0; ly < CHUNK; ly++)
      for (let lz = 0; lz < CHUNK; lz++) {
        const row = lz * CHUNK + ly * CHUNK * CHUNK
        const cellBase = this.cell(bcx, bcy + ((ly / D) | 0), bcz + ((lz / D) | 0))
        for (let lx = 0; lx < CHUNK; lx++) {
          if (data[row + lx] === 0) continue
          this.count[cellBase + ((lx / D) | 0)]++
        }
      }
  }

  /** dirty chunks changed → reset their coarse cells + recount */
  update(world: ChunkStore, chunkIndices: number[]): void {
    const per = CHUNK / D
    for (const ci of chunkIndices) {
      const cx = ci % WORLD_CX
      const cz = ((ci / WORLD_CX) | 0) % WORLD_CZ
      const cy = (ci / (WORLD_CX * WORLD_CZ)) | 0
      if (cx < this.cx0 || cy < this.cy0 || cz < this.cz0) continue
      const bcx = (cx - this.cx0) * per, bcy = (cy - this.cy0) * per, bcz = (cz - this.cz0) * per
      if (bcx + per > this.ncx || bcy + per > this.ncy || bcz + per > this.ncz) continue
      for (let dy = 0; dy < per; dy++)
        for (let dz = 0; dz < per; dz++)
          for (let dx = 0; dx < per; dx++) this.count[this.cell(bcx + dx, bcy + dy, bcz + dz)] = 0
      if (world.chunkAt(ci).kind !== ChunkKind.Empty) this.addChunk(world, cx, cy, cz)
    }
  }

  /**
   * Flood solid coarse cells from the ground (bottom layer); return the voxel
   * bounding region of everything NOT reached (floating), or null if all grounded.
   */
  findFloating(seedBoundaries = false): Region | null {
    const { ncx, ncy, ncz, count, reached, stack } = this
    reached.fill(0)
    let top = 0
    const nxnz = ncx * ncz
    // seeds: solid cells in the bottom coarse layer (region bottom = ground)
    for (let cz = 0; cz < ncz; cz++)
      for (let cx = 0; cx < ncx; cx++) {
        const i = cx + cz * ncx // cy=0
        if (count[i] > 0 && !reached[i]) { reached[i] = 1; stack[top++] = i }
      }
    // per-edit regions (game): structure crossing a SIDE wall may be supported
    // outside the region — conservatively seed side-wall solid cells as supported
    // so a wide building is never falsely dropped by a too-small analysis box.
    if (seedBoundaries) {
      for (let cy = 0; cy < ncy; cy++)
        for (let cz = 0; cz < ncz; cz++)
          for (let cx = 0; cx < ncx; cx++) {
            if (cx !== 0 && cx !== ncx - 1 && cz !== 0 && cz !== ncz - 1) continue
            const i = cx + cz * ncx + cy * nxnz
            if (count[i] > 0 && !reached[i]) { reached[i] = 1; stack[top++] = i }
          }
    }
    while (top > 0) {
      const i = stack[--top]
      const cy = (i / nxnz) | 0
      const r = i - cy * nxnz
      const cz = (r / ncx) | 0
      const cx = r - cz * ncx
      const push = (ncxi: number, ncyi: number, nczi: number): void => {
        if (ncxi < 0 || ncyi < 0 || nczi < 0 || ncxi >= ncx || ncyi >= ncy || nczi >= ncz) return
        const j = ncxi + nczi * ncx + ncyi * nxnz
        if (count[j] > 0 && !reached[j]) { reached[j] = 1; stack[top++] = j }
      }
      push(cx + 1, cy, cz); push(cx - 1, cy, cz)
      push(cx, cy + 1, cz); push(cx, cy - 1, cz)
      push(cx, cy, cz + 1); push(cx, cy, cz - 1)
    }
    // bounding voxel region of unreached solid cells
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
    let any = false
    for (let cy = 0; cy < ncy; cy++)
      for (let cz = 0; cz < ncz; cz++)
        for (let cx = 0; cx < ncx; cx++) {
          const i = cx + cz * ncx + cy * nxnz
          if (count[i] === 0 || reached[i]) continue
          any = true
          const vx = (this.cx0 * CHUNK) + cx * D, vy = (this.cy0 * CHUNK) + cy * D, vz = (this.cz0 * CHUNK) + cz * D
          if (vx < x0) x0 = vx; if (vy < y0) y0 = vy; if (vz < z0) z0 = vz
          if (vx + D - 1 > x1) x1 = vx + D - 1; if (vy + D - 1 > y1) y1 = vy + D - 1; if (vz + D - 1 > z1) z1 = vz + D - 1
        }
    if (!any) return null
    // pad down one cell so the fine flood has the gap below (no false grounding)
    return { x0: x0 - 1, y0: Math.max(0, y0 - D), z0: z0 - 1, x1: x1 + 1, y1: y1 + 1, z1: z1 + 1 }
  }
}
