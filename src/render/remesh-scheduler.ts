/**
 * T9 — remesh scheduler (V7). Pending dirty chunks are drained with a
 * per-frame budget, nearest-to-camera first, so a big edit amortizes over
 * frames instead of stalling one. Pure logic: no three.js, no Worker —
 * unit-testable.
 */
import { CHUNK, VOXEL_SIZE, WORLD_CX, WORLD_CZ } from '../world/chunks'

export interface Vec3Like {
  x: number
  y: number
  z: number
}

/** inverse of chunkIndex: chunk index → [cx, cy, cz] */
export function chunkCoords(ci: number): [number, number, number] {
  const cx = ci % WORLD_CX
  const cz = Math.floor(ci / WORLD_CX) % WORLD_CZ
  const cy = Math.floor(ci / (WORLD_CX * WORLD_CZ))
  return [cx, cy, cz]
}

/** chunk center in world meters */
export function chunkCenter(ci: number): Vec3Like {
  const [cx, cy, cz] = chunkCoords(ci)
  const size = CHUNK * VOXEL_SIZE
  const half = size / 2
  return { x: cx * size + half, y: cy * size + half, z: cz * size + half }
}

export class RemeshScheduler {
  private readonly pending = new Set<number>()
  // B32 — sorted-order cache. Sorting the whole pending set every frame is
  // O(n log n) and at a 4× world (~55k pending during the initial burst) that
  // alone dropped the frame rate into single digits. The nearest-first order
  // only changes when the camera moves or new chunks are enqueued, so we cache
  // the sorted list + a cursor and rebuild lazily.
  private sorted: number[] = []
  private cursor = 0
  private dirty = true
  private camX = Infinity
  private camY = Infinity
  private camZ = Infinity

  get size(): number {
    return this.pending.size
  }

  has(ci: number): boolean {
    return this.pending.has(ci)
  }

  /** idempotent — re-dirtying a queued chunk does not duplicate work */
  enqueue(ci: number): void {
    if (!this.pending.has(ci)) {
      this.pending.add(ci)
      this.dirty = true // new chunk → the cached order is stale
    }
  }

  /**
   * Remove and return up to `budget` chunks, nearest chunk center to `cam`
   * (world meters) first; ties break on chunk index for determinism.
   */
  take(budget: number, cam: Vec3Like): number[] {
    if (budget <= 0 || this.pending.size === 0) return []
    // rebuild the sorted order only when the set changed or the camera moved
    // more than ~half a chunk since the last sort (order is stable otherwise)
    const chunkM = CHUNK * VOXEL_SIZE
    const moved =
      Math.abs(cam.x - this.camX) + Math.abs(cam.y - this.camY) + Math.abs(cam.z - this.camZ) > chunkM * 0.5
    if (this.dirty || moved) {
      this.sorted = [...this.pending]
      this.sorted.sort((a, b) => {
        const ca = chunkCenter(a)
        const cb = chunkCenter(b)
        const da = (ca.x - cam.x) ** 2 + (ca.y - cam.y) ** 2 + (ca.z - cam.z) ** 2
        const db = (cb.x - cam.x) ** 2 + (cb.y - cam.y) ** 2 + (cb.z - cam.z) ** 2
        return da - db || a - b
      })
      this.cursor = 0
      this.dirty = false
      this.camX = cam.x
      this.camY = cam.y
      this.camZ = cam.z
    }
    const out: number[] = []
    // pop from the cached order, skipping any already-removed entries
    while (this.cursor < this.sorted.length && out.length < budget) {
      const ci = this.sorted[this.cursor++]
      if (this.pending.delete(ci)) out.push(ci)
    }
    return out
  }

  clear(): void {
    this.pending.clear()
    this.sorted = []
    this.cursor = 0
    this.dirty = true
  }
}
