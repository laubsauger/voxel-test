/**
 * T11 [P] — connectivity flood-fill after dig/explode edits.
 *
 * Region-limited BFS over solid voxels to find disconnected islands.
 * Runs SYNCHRONOUSLY inside the sim tick — determinism requires the result on
 * a fixed tick, so no async workers (V2). Iteration order is fixed:
 * seed scan y→z→x, neighbor order -x,+x,-y,+y,-z,+z.
 *
 * "Supported" means one of:
 *   - the component contains a voxel at y === 0 (the world ground layer), or
 *   - the component reaches the region boundary AND continues into solid
 *     voxels outside the region (escape hatch: the search is bounded, so a
 *     structure extending past the region is conservatively treated as
 *     connected — a larger region or a later edit near the far side will
 *     re-evaluate it).
 *
 * Everything not supported is returned as an island, in deterministic order.
 */
import {
  CHUNK,
  ChunkKind,
  WORLD_VX,
  WORLD_VY,
  WORLD_VZ,
  chunkIndex,
  type ChunkStore,
} from '../world/chunks'

export interface IslandVoxel {
  x: number
  y: number
  z: number
  mat: number
}

export interface Island {
  voxels: IslandVoxel[]
}

/** margin (voxels) added around an edit's bounds when checking connectivity */
export const CONNECTIVITY_MARGIN = 8
/** hard cap per region axis — bounds worst-case flood-fill cost (escape hatch above covers the cut) */
export const MAX_REGION_EXTENT = 128

export interface Region {
  x0: number
  y0: number
  z0: number
  x1: number
  y1: number
  z1: number
}

/** clamp region to world bounds and MAX_REGION_EXTENT per axis (trims both ends evenly) */
export function clampRegion(r: Region): Region {
  let { x0, y0, z0, x1, y1, z1 } = r
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); z0 = Math.max(0, z0)
  x1 = Math.min(WORLD_VX - 1, x1); y1 = Math.min(WORLD_VY - 1, y1); z1 = Math.min(WORLD_VZ - 1, z1)
  const trim = (lo: number, hi: number): [number, number] => {
    const excess = hi - lo + 1 - MAX_REGION_EXTENT
    if (excess <= 0) return [lo, hi]
    const cut = excess >> 1
    return [lo + cut, lo + cut + MAX_REGION_EXTENT - 1]
  }
  ;[x0, x1] = trim(x0, x1)
  ;[y0, y1] = trim(y0, y1)
  ;[z0, z1] = trim(z0, z1)
  return { x0, y0, z0, x1, y1, z1 }
}

/**
 * T63 (B23) — snapshot the region's materials into a flat local grid with
 * chunk-aware row copies. The flood fill then runs on plain array reads
 * instead of one bounds-checked ChunkStore.getVoxel() per cell (the region
 * for even a single dig is chunk-aligned, ~80³ = 512k cells — per-cell
 * getVoxel dominated the in-tick cost). Pure read; identical values.
 */
function snapshotRegion(
  world: ChunkStore,
  x0: number,
  y0: number,
  z0: number,
  nx: number,
  ny: number,
  nz: number,
): Uint8Array {
  const grid = new Uint8Array(nx * ny * nz)
  const x1 = x0 + nx - 1
  const y1 = y0 + ny - 1
  const z1 = z0 + nz - 1
  for (let cy = y0 >> 5; cy <= y1 >> 5; cy++) {
    for (let cz = z0 >> 5; cz <= z1 >> 5; cz++) {
      for (let cx = x0 >> 5; cx <= x1 >> 5; cx++) {
        const c = world.chunkAt(chunkIndex(cx, cy, cz))
        if (c.kind === ChunkKind.Empty) continue
        // world-space intersection of this chunk's cube with the region
        const wx0 = Math.max(x0, cx << 5)
        const wx1 = Math.min(x1, (cx << 5) + CHUNK - 1)
        const wy0 = Math.max(y0, cy << 5)
        const wy1 = Math.min(y1, (cy << 5) + CHUNK - 1)
        const wz0 = Math.max(z0, cz << 5)
        const wz1 = Math.min(z1, (cz << 5) + CHUNK - 1)
        const len = wx1 - wx0 + 1
        if (c.kind === ChunkKind.Uniform) {
          if (c.mat === 0) continue
          for (let wy = wy0; wy <= wy1; wy++) {
            for (let wz = wz0; wz <= wz1; wz++) {
              const g = wx0 - x0 + (wz - z0) * nx + (wy - y0) * nx * nz
              grid.fill(c.mat, g, g + len)
            }
          }
        } else {
          const data = c.data!
          for (let wy = wy0; wy <= wy1; wy++) {
            for (let wz = wz0; wz <= wz1; wz++) {
              // both layouts are contiguous along x — one row copy
              const d = (wx0 & 31) + (wz & 31) * CHUNK + (wy & 31) * CHUNK * CHUNK
              const g = wx0 - x0 + (wz - z0) * nx + (wy - y0) * nx * nz
              grid.set(data.subarray(d, d + len), g)
            }
          }
        }
      }
    }
  }
  return grid
}

/**
 * Flood-fill all solid voxels inside `region` (clamped) and return the
 * components that are NOT supported. Read-only on the world.
 *
 * T63 (B23) perf shape — results are bit-identical to the original
 * per-getVoxel version (same seed scan y→z→x, same neighbor order, same
 * BFS FIFO order, so island voxel order is unchanged and V3 hashes hold):
 *   - the fill reads a flat snapshot grid (see snapshotRegion) — the world
 *     is only consulted for the region-boundary escape hatch,
 *   - island voxel objects materialize AFTER a component proves unsupported
 *     (the queue itself is the component list) — the old code allocated one
 *     object per visited voxel, including the entire supported ground slab.
 */
export function findUnsupportedIslands(world: ChunkStore, region: Region): Island[] {
  const { x0, y0, z0, x1, y1, z1 } = clampRegion(region)
  if (x0 > x1 || y0 > y1 || z0 > z1) return []
  const nx = x1 - x0 + 1
  const ny = y1 - y0 + 1
  const nz = z1 - z0 + 1
  const vol = nx * ny * nz
  const grid = snapshotRegion(world, x0, y0, z0, nx, ny, nz)
  const visited = new Uint8Array(vol)
  const queue = new Int32Array(vol)
  const nxnz = nx * nz

  const islands: Island[] = []

  for (let sy = 0; sy < ny; sy++) {
    for (let sz = 0; sz < nz; sz++) {
      for (let sx = 0; sx < nx; sx++) {
        const si = sx + sz * nx + sy * nxnz
        if (visited[si] !== 0 || grid[si] === 0) continue

        // BFS one component; queue[0..tail) doubles as the component list
        let head = 0
        let tail = 0
        queue[tail++] = si
        visited[si] = 1
        let supported = false

        while (head < tail) {
          const li = queue[head++]
          const lx = li % nx
          const lz = ((li / nx) | 0) % nz
          const ly = (li / nxnz) | 0
          if (y0 + ly === 0) supported = true // resting on the world ground layer

          // neighbor order -x,+x,-y,+y,-z,+z (deterministic, unchanged)
          for (let n = 0; n < 6; n++) {
            const nlx = n === 0 ? lx - 1 : n === 1 ? lx + 1 : lx
            const nly = n === 2 ? ly - 1 : n === 3 ? ly + 1 : ly
            const nlz = n === 4 ? lz - 1 : n === 5 ? lz + 1 : lz
            if (nlx < 0 || nly < 0 || nlz < 0 || nlx >= nx || nly >= ny || nlz >= nz) {
              // neighbor is outside the region: solid there ⇒ the structure
              // continues past the search bounds ⇒ treat as connected
              if (world.getVoxel(x0 + nlx, y0 + nly, z0 + nlz) !== 0) supported = true
              continue
            }
            const nli = nlx + nlz * nx + nly * nxnz
            if (visited[nli] !== 0 || grid[nli] === 0) continue
            visited[nli] = 1
            queue[tail++] = nli
          }
        }

        if (!supported) {
          // materialize in BFS order — identical to the old per-visit pushes
          const voxels: IslandVoxel[] = new Array(tail)
          for (let i = 0; i < tail; i++) {
            const li = queue[i]
            const lx = li % nx
            const lz = ((li / nx) | 0) % nz
            const ly = (li / nxnz) | 0
            voxels[i] = { x: x0 + lx, y: y0 + ly, z: z0 + lz, mat: grid[li] }
          }
          islands.push({ voxels })
        }
      }
    }
  }
  return islands
}
