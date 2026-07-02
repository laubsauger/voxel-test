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

// --- B15: boundary-supported fragment resolution -----------------------------
/**
 * Components supported ONLY via the region-boundary escape hatch used to be
 * accepted as supported forever — a fragment whose bbox clipped the region
 * edge stayed static mid-air (B15). Small such components now get a second
 * look: a component-local flood fill whose region grows toward the boundary
 * contacts until the component is fully enclosed (→ verdict is real),
 * grounded, too big, or the iteration cap hits (→ conservative supported).
 * Bounded: ≤ PROVISIONAL_MAX_VOXELS per flood, ≤ RESOLVE_MAX_ITERS regrows.
 */
export const PROVISIONAL_MAX_VOXELS = 2048
export const RESOLVE_MAX_ITERS = 6

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

const worldKey = (x: number, y: number, z: number): number => x + WORLD_VX * (z + WORLD_VZ * y)

/**
 * Flood-fill all solid voxels inside `region` (clamped) and return the
 * components that are NOT supported. Read-only on the world.
 *
 * B15: components whose only support is the boundary escape hatch are
 * re-resolved with a component-local growing region when small enough —
 * see resolveComponentSupport. Deterministic: scan order fixed, provisional
 * resolutions run in discovery order after the main scan.
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
  // seeds of components supported ONLY via boundary contact (B15 suspects)
  const provisional: { x: number; y: number; z: number }[] = []

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
        let grounded = false
        let boundary = false
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
          if (wy === 0) grounded = true // resting on the world ground layer

          for (const [dx, dy, dz] of NEIGHBORS) {
            const nlx = lx + dx
            const nly = ly + dy
            const nlz = lz + dz
            if (nlx < 0 || nly < 0 || nlz < 0 || nlx >= nx || nly >= ny || nlz >= nz) {
              // neighbor is outside the region: solid there ⇒ the structure
              // continues past the search bounds ⇒ provisionally connected
              if (world.getVoxel(wx + dx, wy + dy, wz + dz) !== 0) boundary = true
              continue
            }
            const nli = lidx(nlx, nly, nlz)
            if (visited[nli] || world.getVoxel(x0 + nlx, y0 + nly, z0 + nlz) === 0) continue
            visited[nli] = 1
            queue[tail++] = nli
          }
        }

        if (!grounded && !boundary) {
          islands.push({ voxels })
        } else if (!grounded && voxels.length <= PROVISIONAL_MAX_VOXELS) {
          // boundary-only support on a small component: B15 candidate
          provisional.push({ x: voxels[0].x, y: voxels[0].y, z: voxels[0].z })
        }
        // grounded, or boundary-supported and big: supported (as before)
      }
    }
  }

  if (provisional.length === 0) return islands

  // B15 second pass: resolve small boundary-supported components with a
  // growing component-local region. `claimed` prevents duplicate extraction
  // when resolutions overlap (same structure reached from two in-region seeds).
  const claimed = new Set<number>()
  for (const island of islands) for (const v of island.voxels) claimed.add(worldKey(v.x, v.y, v.z))
  for (const seed of provisional) {
    if (claimed.has(worldKey(seed.x, seed.y, seed.z))) continue
    const res = resolveComponentSupport(world, seed.x, seed.y, seed.z)
    if (res.supported) continue
    let overlap = false
    for (const v of res.voxels) {
      if (claimed.has(worldKey(v.x, v.y, v.z))) {
        overlap = true
        break
      }
    }
    // overlap with an already-extracted set: skip — the extraction dirties
    // those chunks and the next tick's structural pass re-evaluates cleanly
    if (overlap) continue
    for (const v of res.voxels) claimed.add(worldKey(v.x, v.y, v.z))
    islands.push({ voxels: res.voxels })
  }
  return islands
}

/**
 * B15 — resolve support for ONE component starting at a solid seed voxel.
 * Floods the component inside a region that starts at seed ± margin and grows
 * toward boundary contacts each iteration. Verdicts:
 *   - grounded (reaches y === 0)                    → supported
 *   - exceeds PROVISIONAL_MAX_VOXELS (a structure)  → supported (conservative)
 *   - region can no longer grow / iteration cap     → supported (conservative)
 *   - fully enclosed by air within the region       → NOT supported (island)
 * Deterministic: FIFO BFS, fixed neighbor order, growth from voxel bbox only.
 */
export function resolveComponentSupport(
  world: ChunkStore,
  sx: number,
  sy: number,
  sz: number,
): { supported: boolean; voxels: IslandVoxel[] } {
  const m = CONNECTIVITY_MARGIN
  let region = clampRegion({ x0: sx - m, y0: sy - m, z0: sz - m, x1: sx + m, y1: sy + m, z1: sz + m })

  for (let iter = 0; iter < RESOLVE_MAX_ITERS; iter++) {
    const visited = new Set<number>()
    const qx: number[] = [sx]
    const qy: number[] = [sy]
    const qz: number[] = [sz]
    visited.add(worldKey(sx, sy, sz))
    const voxels: IslandVoxel[] = []
    let boundary = false
    // bbox over component voxels AND outside-region solid contacts
    let bx0 = sx, by0 = sy, bz0 = sz, bx1 = sx, by1 = sy, bz1 = sz
    let head = 0

    while (head < qx.length) {
      const wx = qx[head]
      const wy = qy[head]
      const wz = qz[head]
      head++
      voxels.push({ x: wx, y: wy, z: wz, mat: world.getVoxel(wx, wy, wz) })
      if (wy === 0) return { supported: true, voxels } // grounded
      if (voxels.length > PROVISIONAL_MAX_VOXELS) return { supported: true, voxels } // too big: a structure
      if (wx < bx0) bx0 = wx
      if (wy < by0) by0 = wy
      if (wz < bz0) bz0 = wz
      if (wx > bx1) bx1 = wx
      if (wy > by1) by1 = wy
      if (wz > bz1) bz1 = wz

      for (const [dx, dy, dz] of NEIGHBORS) {
        const nxw = wx + dx
        const nyw = wy + dy
        const nzw = wz + dz
        if (world.getVoxel(nxw, nyw, nzw) === 0) continue
        if (nxw < region.x0 || nyw < region.y0 || nzw < region.z0 || nxw > region.x1 || nyw > region.y1 || nzw > region.z1) {
          boundary = true
          if (nxw < bx0) bx0 = nxw
          if (nyw < by0) by0 = nyw
          if (nzw < bz0) bz0 = nzw
          if (nxw > bx1) bx1 = nxw
          if (nyw > by1) by1 = nyw
          if (nzw > bz1) bz1 = nzw
          continue
        }
        const k = worldKey(nxw, nyw, nzw)
        if (visited.has(k)) continue
        visited.add(k)
        qx.push(nxw)
        qy.push(nyw)
        qz.push(nzw)
      }
    }

    if (!boundary) return { supported: false, voxels } // fully enclosed: floats free
    const grown = clampRegion({ x0: bx0 - m, y0: by0 - m, z0: bz0 - m, x1: bx1 + m, y1: by1 + m, z1: bz1 + m })
    if (
      grown.x0 === region.x0 && grown.y0 === region.y0 && grown.z0 === region.z0 &&
      grown.x1 === region.x1 && grown.y1 === region.y1 && grown.z1 === region.z1
    ) {
      return { supported: true, voxels } // clamp stops growth: conservative
    }
    region = grown
  }
  return { supported: true, voxels: [] } // iteration cap: conservative
}
