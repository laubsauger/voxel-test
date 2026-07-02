/**
 * I.chunk — sparse voxel chunk store. Part of authoritative sim state.
 * Voxel = 1 byte material id, 0 = air (V5). Chunk 32³.
 * Chunk states: empty | uniform(mat) | dense(Uint8Array 32768).
 *
 * Voxel coords: integer, x∈[0,1024) y∈[0,512) z∈[0,1024). World meters = voxel * 0.1.
 */

export const VOXEL_SIZE = 0.1
export const CHUNK = 32
export const CHUNK_VOL = CHUNK * CHUNK * CHUNK
export const WORLD_CX = 32
export const WORLD_CY = 16
export const WORLD_CZ = 32
export const WORLD_VX = WORLD_CX * CHUNK
export const WORLD_VY = WORLD_CY * CHUNK
export const WORLD_VZ = WORLD_CZ * CHUNK
export const CHUNK_COUNT = WORLD_CX * WORLD_CY * WORLD_CZ

export const enum ChunkKind {
  Empty = 0,
  Uniform = 1,
  Dense = 2,
}

export interface Chunk {
  kind: ChunkKind
  /** material for Uniform chunks */
  mat: number
  /** voxel data for Dense chunks, index = x + z*32 + y*1024 */
  data: Uint8Array | null
}

export function chunkIndex(cx: number, cy: number, cz: number): number {
  return cx + cz * WORLD_CX + cy * WORLD_CX * WORLD_CZ
}

export function voxelInChunk(x: number, y: number, z: number): number {
  return (x & 31) + (z & 31) * CHUNK + (y & 31) * CHUNK * CHUNK
}

function inBounds(x: number, y: number, z: number): boolean {
  return x >= 0 && y >= 0 && z >= 0 && x < WORLD_VX && y < WORLD_VY && z < WORLD_VZ
}

export class ChunkStore {
  private readonly chunks: Chunk[] = new Array(CHUNK_COUNT)
  /** chunk indices touched since last drain — consumed by mesher/mirror */
  readonly dirty = new Set<number>()
  /**
   * Per-voxel mutation hook (set in main.ts wiring): water CA subscribes so
   * settled pools wake when a wall is breached. Runs in-tick — must stay
   * deterministic (V2). Not called by fillBox's uniform-chunk path (scene
   * gen runs before subscribers attach).
   */
  onVoxelChanged: ((x: number, y: number, z: number) => void) | null = null

  constructor() {
    for (let i = 0; i < CHUNK_COUNT; i++) {
      this.chunks[i] = { kind: ChunkKind.Empty, mat: 0, data: null }
    }
  }

  chunkAt(index: number): Chunk {
    return this.chunks[index]
  }

  getVoxel(x: number, y: number, z: number): number {
    if (!inBounds(x, y, z)) return 0
    const c = this.chunks[chunkIndex(x >> 5, y >> 5, z >> 5)]
    switch (c.kind) {
      case ChunkKind.Empty:
        return 0
      case ChunkKind.Uniform:
        return c.mat
      default:
        return c.data![voxelInChunk(x, y, z)]
    }
  }

  setVoxel(x: number, y: number, z: number, mat: number): void {
    if (!inBounds(x, y, z)) return
    const ci = chunkIndex(x >> 5, y >> 5, z >> 5)
    const c = this.chunks[ci]
    const vi = voxelInChunk(x, y, z)
    if (c.kind === ChunkKind.Dense) {
      if (c.data![vi] === mat) return
      c.data![vi] = mat
    } else {
      const current = c.kind === ChunkKind.Uniform ? c.mat : 0
      if (current === mat) return
      this.realize(c)
      c.data![vi] = mat
    }
    this.dirty.add(ci)
    if (this.onVoxelChanged) this.onVoxelChanged(x, y, z)
  }

  /** uniform/empty → dense, preserving contents */
  private realize(c: Chunk): void {
    const data = new Uint8Array(CHUNK_VOL)
    if (c.kind === ChunkKind.Uniform) data.fill(c.mat)
    c.kind = ChunkKind.Dense
    c.data = data
    c.mat = 0
  }

  /**
   * Fill axis-aligned box [x0..x1]×[y0..y1]×[z0..z1] inclusive.
   * Fully-covered chunks become Uniform (memory stays sparse).
   */
  fillBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, mat: number): void {
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); z0 = Math.max(0, z0)
    x1 = Math.min(WORLD_VX - 1, x1); y1 = Math.min(WORLD_VY - 1, y1); z1 = Math.min(WORLD_VZ - 1, z1)
    if (x0 > x1 || y0 > y1 || z0 > z1) return
    for (let cy = y0 >> 5; cy <= y1 >> 5; cy++) {
      for (let cz = z0 >> 5; cz <= z1 >> 5; cz++) {
        for (let cx = x0 >> 5; cx <= x1 >> 5; cx++) {
          const bx0 = cx << 5, by0 = cy << 5, bz0 = cz << 5
          const covered =
            x0 <= bx0 && x1 >= bx0 + 31 &&
            y0 <= by0 && y1 >= by0 + 31 &&
            z0 <= bz0 && z1 >= bz0 + 31
          const ci = chunkIndex(cx, cy, cz)
          if (covered) {
            const c = this.chunks[ci]
            c.kind = mat === 0 ? ChunkKind.Empty : ChunkKind.Uniform
            c.mat = mat === 0 ? 0 : mat
            c.data = null
            this.dirty.add(ci)
          } else {
            const lx0 = Math.max(x0, bx0), lx1 = Math.min(x1, bx0 + 31)
            const ly0 = Math.max(y0, by0), ly1 = Math.min(y1, by0 + 31)
            const lz0 = Math.max(z0, bz0), lz1 = Math.min(z1, bz0 + 31)
            for (let y = ly0; y <= ly1; y++)
              for (let z = lz0; z <= lz1; z++)
                for (let x = lx0; x <= lx1; x++) this.setVoxel(x, y, z, mat)
          }
        }
      }
    }
  }

  /**
   * Stamp sphere of material (0 = dig) centered at voxel (cx,cy,cz), radius r voxels.
   * Deterministic iteration order.
   */
  stampSphere(cx: number, cy: number, cz: number, r: number, mat: number): void {
    const r2 = r * r
    const x0 = Math.floor(cx - r), x1 = Math.ceil(cx + r)
    const y0 = Math.floor(cy - r), y1 = Math.ceil(cy + r)
    const z0 = Math.floor(cz - r), z1 = Math.ceil(cz + r)
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x + 0.5 - cx, dy = y + 0.5 - cy, dz = z + 0.5 - cz
          if (dx * dx + dy * dy + dz * dz <= r2) this.setVoxel(x, y, z, mat)
        }
      }
    }
  }

  drainDirty(): number[] {
    const out = [...this.dirty].sort((a, b) => a - b)
    this.dirty.clear()
    return out
  }
}
