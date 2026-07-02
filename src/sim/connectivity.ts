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
import { WORLD_VX, WORLD_VY, WORLD_VZ, type ChunkStore } from '../world/chunks'

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

const NEIGHBORS: ReadonlyArray<readonly [number, number, number]> = [
  [-1, 0, 0],
  [1, 0, 0],
  [0, -1, 0],
  [0, 1, 0],
  [0, 0, -1],
  [0, 0, 1],
]

/**
 * Flood-fill all solid voxels inside `region` (clamped) and return the
 * components that are NOT supported. Read-only on the world.
 */
export function findUnsupportedIslands(world: ChunkStore, region: Region): Island[] {
  const { x0, y0, z0, x1, y1, z1 } = clampRegion(region)
  if (x0 > x1 || y0 > y1 || z0 > z1) return []
  const nx = x1 - x0 + 1
  const ny = y1 - y0 + 1
  const nz = z1 - z0 + 1
  const vol = nx * ny * nz
  const visited = new Uint8Array(vol)
  const queue = new Int32Array(vol)
  const lidx = (lx: number, ly: number, lz: number) => lx + lz * nx + ly * nx * nz

  const islands: Island[] = []

  for (let sy = 0; sy < ny; sy++) {
    for (let sz = 0; sz < nz; sz++) {
      for (let sx = 0; sx < nx; sx++) {
        const si = lidx(sx, sy, sz)
        if (visited[si] || world.getVoxel(x0 + sx, y0 + sy, z0 + sz) === 0) continue

        // BFS one component
        let head = 0
        let tail = 0
        queue[tail++] = si
        visited[si] = 1
        let supported = false
        const voxels: IslandVoxel[] = []

        while (head < tail) {
          const li = queue[head++]
          const lx = li % nx
          const lz = ((li / nx) | 0) % nz
          const ly = (li / (nx * nz)) | 0
          const wx = x0 + lx
          const wy = y0 + ly
          const wz = z0 + lz
          voxels.push({ x: wx, y: wy, z: wz, mat: world.getVoxel(wx, wy, wz) })
          if (wy === 0) supported = true // resting on the world ground layer

          for (const [dx, dy, dz] of NEIGHBORS) {
            const nlx = lx + dx
            const nly = ly + dy
            const nlz = lz + dz
            if (nlx < 0 || nly < 0 || nlz < 0 || nlx >= nx || nly >= ny || nlz >= nz) {
              // neighbor is outside the region: solid there ⇒ the structure
              // continues past the search bounds ⇒ treat as connected
              if (world.getVoxel(wx + dx, wy + dy, wz + dz) !== 0) supported = true
              continue
            }
            const nli = lidx(nlx, nly, nlz)
            if (visited[nli] || world.getVoxel(x0 + nlx, y0 + nly, z0 + nlz) === 0) continue
            visited[nli] = 1
            queue[tail++] = nli
          }
        }

        if (!supported) islands.push({ voxels })
      }
    }
  }
  return islands
}
