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

  get size(): number {
    return this.pending.size
  }

  has(ci: number): boolean {
    return this.pending.has(ci)
  }

  /** idempotent — re-dirtying a queued chunk does not duplicate work */
  enqueue(ci: number): void {
    this.pending.add(ci)
  }

  /**
   * Remove and return up to `budget` chunks, nearest chunk center to `cam`
   * (world meters) first; ties break on chunk index for determinism.
   */
  take(budget: number, cam: Vec3Like): number[] {
    if (budget <= 0 || this.pending.size === 0) return []
    const scored: Array<[number, number]> = []
    for (const ci of this.pending) {
      const c = chunkCenter(ci)
      const dx = c.x - cam.x
      const dy = c.y - cam.y
      const dz = c.z - cam.z
      scored.push([ci, dx * dx + dy * dy + dz * dz])
    }
    scored.sort((a, b) => a[1] - b[1] || a[0] - b[0])
    const out: number[] = []
    for (let i = 0; i < scored.length && out.length < budget; i++) {
      out.push(scored[i][0])
      this.pending.delete(scored[i][0])
    }
    return out
  }

  clear(): void {
    this.pending.clear()
  }
}
