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

/**
 * T63 (B23) — snapshot the region's materials into a flat local grid with
 * chunk-aware row copies. The flood fill then runs on plain array reads
 * instead of one bounds-checked ChunkStore.getVoxel() per cell (the region
 * for even a single dig is chunk-aligned, ~80³ = 512k cells — per-cell
 * getVoxel dominated the in-tick cost). Pure read; identical values.
 */
export function snapshotRegion(
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

const worldKey = (x: number, y: number, z: number): number => x + WORLD_VX * (z + WORLD_VZ * y)

/** fixed neighbor order (V2) — used by the B15 component-local resolver */
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
 *
 * B15: components whose only support is the boundary escape hatch are
 * re-resolved with a component-local growing region when small enough —
 * see resolveComponentSupport. Deterministic: scan order fixed, provisional
 * resolutions run in discovery order after the main scan.
 *
 * T63 (B23) perf shape — results are bit-identical to the per-getVoxel
 * version (same seed scan y→z→x, same neighbor order, same BFS FIFO order,
 * so island voxel order is unchanged and V3 hashes hold):
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
  // queue entries pack local coords lx | lz<<8 | ly<<16 (extent ≤ 128 per
  // axis fits 8 bits) — no div/mod per dequeue, and interior cells skip
  // bounds checks entirely. Enqueue order is unchanged (same seed scan,
  // same -x,+x,-y,+y,-z,+z neighbor order, FIFO), so results and island
  // voxel order are bit-identical to the reference version (V2/V3).
  const queue = new Int32Array(vol)
  const nxnz = nx * nz
  const nxm1 = nx - 1
  const nym1 = ny - 1
  const nzm1 = nz - 1

  const islands: Island[] = []
  // seeds of components supported ONLY via boundary contact (B15 suspects)
  const provisional: { x: number; y: number; z: number }[] = []

  for (let sy = 0; sy < ny; sy++) {
    for (let sz = 0; sz < nz; sz++) {
      for (let sx = 0; sx < nx; sx++) {
        const si = sx + sz * nx + sy * nxnz
        if (visited[si] !== 0 || grid[si] === 0) continue

        // BFS one component; queue[0..tail) doubles as the component list
        let head = 0
        let tail = 0
        queue[tail++] = sx | (sz << 8) | (sy << 16)
        visited[si] = 1
        let grounded = false
        let boundary = false

        while (head < tail) {
          const p = queue[head++]
          const lx = p & 0xff
          const lz = (p >> 8) & 0xff
          const ly = p >> 16
          const li = lx + lz * nx + ly * nxnz
          if (y0 + ly === 0) grounded = true // resting on the world ground layer

          if (lx > 0 && lx < nxm1 && ly > 0 && ly < nym1 && lz > 0 && lz < nzm1) {
            // interior fast path — all 6 neighbors are inside the region
            let nli = li - 1 // -x
            if (visited[nli] === 0 && grid[nli] !== 0) { visited[nli] = 1; queue[tail++] = p - 1 }
            nli = li + 1 // +x
            if (visited[nli] === 0 && grid[nli] !== 0) { visited[nli] = 1; queue[tail++] = p + 1 }
            nli = li - nxnz // -y
            if (visited[nli] === 0 && grid[nli] !== 0) { visited[nli] = 1; queue[tail++] = p - 0x10000 }
            nli = li + nxnz // +y
            if (visited[nli] === 0 && grid[nli] !== 0) { visited[nli] = 1; queue[tail++] = p + 0x10000 }
            nli = li - nx // -z
            if (visited[nli] === 0 && grid[nli] !== 0) { visited[nli] = 1; queue[tail++] = p - 0x100 }
            nli = li + nx // +z
            if (visited[nli] === 0 && grid[nli] !== 0) { visited[nli] = 1; queue[tail++] = p + 0x100 }
            continue
          }

          // border cell: bounds-checked neighbors + region-boundary escape
          // hatch (solid outside the region ⇒ treat as connected)
          // -x
          if (lx === 0) {
            if (world.getVoxel(x0 - 1, y0 + ly, z0 + lz) !== 0) boundary = true
          } else {
            const nli = li - 1
            if (visited[nli] === 0 && grid[nli] !== 0) { visited[nli] = 1; queue[tail++] = p - 1 }
          }
          // +x
          if (lx === nxm1) {
            if (world.getVoxel(x0 + nx, y0 + ly, z0 + lz) !== 0) boundary = true
          } else {
            const nli = li + 1
            if (visited[nli] === 0 && grid[nli] !== 0) { visited[nli] = 1; queue[tail++] = p + 1 }
          }
          // -y
          if (ly === 0) {
            if (world.getVoxel(x0 + lx, y0 - 1, z0 + lz) !== 0) boundary = true
          } else {
            const nli = li - nxnz
            if (visited[nli] === 0 && grid[nli] !== 0) { visited[nli] = 1; queue[tail++] = p - 0x10000 }
          }
          // +y
          if (ly === nym1) {
            if (world.getVoxel(x0 + lx, y0 + ny, z0 + lz) !== 0) boundary = true
          } else {
            const nli = li + nxnz
            if (visited[nli] === 0 && grid[nli] !== 0) { visited[nli] = 1; queue[tail++] = p + 0x10000 }
          }
          // -z
          if (lz === 0) {
            if (world.getVoxel(x0 + lx, y0 + ly, z0 - 1) !== 0) boundary = true
          } else {
            const nli = li - nx
            if (visited[nli] === 0 && grid[nli] !== 0) { visited[nli] = 1; queue[tail++] = p - 0x100 }
          }
          // +z
          if (lz === nzm1) {
            if (world.getVoxel(x0 + lx, y0 + ly, z0 + nz) !== 0) boundary = true
          } else {
            const nli = li + nx
            if (visited[nli] === 0 && grid[nli] !== 0) { visited[nli] = 1; queue[tail++] = p + 0x100 }
          }
        }

        if (!grounded && !boundary) {
          // materialize in BFS order — identical to the old per-visit pushes
          const voxels: IslandVoxel[] = new Array(tail)
          for (let i = 0; i < tail; i++) {
            const p = queue[i]
            const lx = p & 0xff
            const lz = (p >> 8) & 0xff
            const ly = p >> 16
            voxels[i] = { x: x0 + lx, y: y0 + ly, z: z0 + lz, mat: grid[lx + lz * nx + ly * nxnz] }
          }
          islands.push({ voxels })
        } else if (!grounded && tail <= PROVISIONAL_MAX_VOXELS) {
          // B15: boundary-only support on a small component — re-resolve below
          const p0 = queue[0]
          provisional.push({ x: x0 + (p0 & 0xff), y: y0 + (p0 >> 16), z: z0 + ((p0 >> 8) & 0xff) })
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
