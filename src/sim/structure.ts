/**
 * T56 — structural stress / weak-neck collapse. Complements connectivity.ts:
 * findUnsupportedIslands drops FULLY-disconnected pieces; this drops pieces that
 * are still connected to the ground but whose support is TOO THIN for the mass it
 * carries (a top floor held up by a few slender columns, an undermined wall, a
 * cantilever). Those "necks" break and the mass above detaches — FRAGMENTED into
 * chunks so it crumbles rather than falling as one rigid slab.
 *
 * Engine-agnostic (sim layer): returns Island[] for the existing extractIsland /
 * buildVoxelBody path (Jolt or Box3D). Region-scoped + budgeted + deterministic
 * (scan y→z→x, slices bottom→up, fixed fragment grid) so it is MP-safe (V2/V3).
 *
 * Heuristic, not FEM: per grounded component, at each height the neck capacity ≈
 * (cross-section voxels) × material strength × CAP_PER_VOXEL, and the load ≈ mass
 * above. Break at the most-overstressed height whose load exceeds capacity.
 */
import type { ChunkStore } from '../world/chunks'
import { material, MAT_DIRT, MAT_GRASS, MAT_ASPHALT, MAT_SAND } from './materials'
import { clampRegion, snapshotRegion, type Island, type IslandVoxel, type Region } from './connectivity'

/** terrain = the GROUND reference: grounds structure, never flooded/collapsed.
 *  Everything else (incl. wood trunks + leaves) IS structure — so chopping a
 *  tree's trunk collapses it, but only when the edit actually touches it. */
const TERRAIN = new Uint8Array(256)
for (const m of [MAT_DIRT, MAT_GRASS, MAT_ASPHALT, MAT_SAND]) TERRAIN[m] = 1
const isStruct = (m: number): boolean => m !== 0 && TERRAIN[m] === 0

export interface StressOpts {
  /** mass (voxels) one unit-strength cross-section voxel can hold */
  capPerVoxel?: number
  /** collapse where load / capacity exceeds this */
  threshold?: number
  /** fragment detached mass into cubes of this edge (voxels) — crumble size */
  fragment?: number
  /** max islands emitted per pass (budget) */
  maxIslands?: number
  /** ignore components smaller than this (noise) */
  minComponent?: number
}

const DEF: Required<StressOpts> = {
  capPerVoxel: 9,
  threshold: 1,
  fragment: 6, // chunkier debris = far fewer bodies for the same collapsed volume
  maxIslands: 96,
  minComponent: 24,
}

/**
 * @param region     analysis box (expanded UP so a low edit sees the mass above)
 * @param editRegion the voxels actually changed this edit — ONLY components that
 *                   intersect this collapse. Untouched neighbours/trees are left
 *                   alone (the fix for "a hole in one wall drops the whole block").
 */
export function findStressCollapses(world: ChunkStore, region: Region, editRegion: Region, opts: StressOpts = {}): Island[] {
  const o = { ...DEF, ...opts }
  const R = clampRegion(region)
  const E = editRegion
  if (R.x0 > R.x1 || R.y0 > R.y1 || R.z0 > R.z1) return []
  const nx = R.x1 - R.x0 + 1
  const ny = R.y1 - R.y0 + 1
  const nz = R.z1 - R.z0 + 1
  const nxnz = nx * nz
  const vol = nx * ny * nz
  // bulk chunk-aware snapshot → flood on the array (per-voxel getVoxel dominated)
  const grid = snapshotRegion(world, R.x0, R.y0, R.z0, nx, ny, nz)
  const at = (lx: number, ly: number, lz: number): number => grid[lx + lz * nx + ly * nxnz]

  const visited = new Uint8Array(vol)
  const queue = new Int32Array(vol)
  const out: Island[] = []

  // scan seeds y→z→x (deterministic)
  for (let sy = 0; sy < ny && out.length < o.maxIslands; sy++)
    for (let sz = 0; sz < nz; sz++)
      for (let sx = 0; sx < nx; sx++) {
        const si = sx + sz * nx + sy * nxnz
        if (visited[si] !== 0 || !isStruct(at(sx, sy, sz))) continue

        // BFS the component; record voxels + grounded flag
        let head = 0, tail = 0
        queue[tail++] = sx | (sz << 8) | (sy << 16)
        visited[si] = 1
        let grounded = false // touches world ground (y=0) or structure below the region
        let boundary = false // extends past the region horizontally → assume supported elsewhere
        let touched = false // component overlaps the actual edit → eligible to collapse
        const comp: number[] = [] // packed lx|lz<<8|ly<<16
        while (head < tail) {
          const p = queue[head++]
          const lx = p & 0xff, lz = (p >> 8) & 0xff, ly = p >> 16
          comp.push(p)
          const wx = R.x0 + lx, wy = R.y0 + ly, wz = R.z0 + lz
          if (wx >= E.x0 && wx <= E.x1 && wy >= E.y0 && wy <= E.y1 && wz >= E.z0 && wz <= E.z1) touched = true
          if (wy === 0) grounded = true
          // grounded if resting on terrain (the ground reference) directly below
          const below = ly > 0 ? grid[lx + lz * nx + (ly - 1) * nxnz] : world.getVoxel(R.x0 + lx, R.y0 - 1, R.z0 + lz)
          if (TERRAIN[below] === 1) grounded = true
          const tryN = (mx: number, my: number, mz: number, pk: number): void => {
            if (mx < 0 || my < 0 || mz < 0 || mx >= nx || my >= ny || mz >= nz) {
              if (isStruct(world.getVoxel(R.x0 + mx, R.y0 + my, R.z0 + mz))) boundary = true
              return
            }
            const ni = mx + mz * nx + my * nxnz
            if (visited[ni] === 0 && isStruct(at(mx, my, mz))) { visited[ni] = 1; queue[tail++] = pk }
          }
          tryN(lx - 1, ly, lz, p - 1)
          tryN(lx + 1, ly, lz, p + 1)
          tryN(lx, ly - 1, lz, p - 0x10000)
          tryN(lx, ly + 1, lz, p + 0x10000)
          tryN(lx, ly, lz - 1, p - 0x100)
          tryN(lx, ly, lz + 1, p + 0x100)
        }
        // stress-test grounded components only (ungrounded = connectivity's job).
        // `boundary` does NOT disqualify a grounded component: the ground slab
        // always extends past the region, but the building's own neck is still
        // judged from the weakest cross-section, which the ground never is.
        void boundary
        // untouched = not overlapping this edit → leave it standing (locality).
        if (!touched || !grounded || comp.length < o.minComponent) continue

        // per-height cross-section + strength + mass
        const csY = new Int32Array(ny)
        const strY = new Float64Array(ny)
        for (const p of comp) {
          const lx = p & 0xff, lz = (p >> 8) & 0xff, ly = p >> 16
          csY[ly]++
          strY[ly] += material(at(lx, ly, lz)).strength
        }
        let minLy = ny, maxLy = -1
        for (let ly = 0; ly < ny; ly++) if (csY[ly] > 0) { if (ly < minLy) minLy = ly; if (ly > maxLy) maxLy = ly }
        // mass strictly above each slice
        const above = new Int32Array(ny)
        let acc = 0
        for (let ly = maxLy; ly >= minLy; ly--) { above[ly] = acc; acc += csY[ly] }

        // find the most overstressed neck above the base
        let breakLy = -1, worst = o.threshold
        for (let ly = minLy + 1; ly <= maxLy; ly++) {
          if (csY[ly] === 0) continue
          const avgStr = strY[ly] / csY[ly]
          const cap = csY[ly] * avgStr * o.capPerVoxel
          const ratio = above[ly] / Math.max(cap, 1)
          if (ratio > worst) { worst = ratio; breakLy = ly }
        }
        if (breakLy < 0) continue // adequately supported

        // detach everything at/above the neck, fragmented into cubes (crumble)
        const F = o.fragment
        const frags = new Map<number, IslandVoxel[]>()
        for (const p of comp) {
          const ly = p >> 16
          if (ly < breakLy) continue
          const lx = p & 0xff, lz = (p >> 8) & 0xff
          const key = ((lx / F) | 0) | (((lz / F) | 0) << 10) | (((ly / F) | 0) << 20)
          let arr = frags.get(key)
          if (!arr) { arr = []; frags.set(key, arr) }
          arr.push({ x: R.x0 + lx, y: R.y0 + ly, z: R.z0 + lz, mat: at(lx, ly, lz) })
        }
        for (const arr of frags.values()) {
          if (out.length >= o.maxIslands) break
          out.push({ voxels: arr })
        }
      }
  return out
}
