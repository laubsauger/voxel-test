/**
 * T93 — direct ground-reachability check ("is there ANY welded path from this
 * block to the ground?"). The missing primitive behind B33/B34: every previous
 * detector was locality-bounded and had to assume "crosses my analysis region
 * = supported elsewhere" (fine connectivity, stress pass) or aliased thin gaps
 * away (D=4 coarse grid). This one floods the ACTUAL component with no region
 * boundary at all — the only outs are terrain contact (grounded, early exit)
 * or component exhaustion (provably floating).
 *
 * Efficiency contract:
 *  - runs on CANDIDATES only: seeds harvested from the edit's surroundings,
 *    invoked from the deferred stress slot (merged boxes, tick % 6)
 *  - DOWN-BIASED stack: supported structures confirm in ~height pops (the
 *    common case is nearly free); only true floaters pay their component size
 *  - hard visit cap (deterministic): beyond MAX_VISITS the component is
 *    assumed supported — a skyscraper-scale component is never fully severed
 *    by one edit box without the stress pass firing first
 *  - shared visited set across seeds of one pass — N seeds in one component
 *    cost one flood
 *
 * Determinism (V2/V3): pure sim-state reads, fixed seed order, fixed
 * neighbour order, constant cap → identical verdicts on every peer.
 */
import type { ChunkStore } from '../world/chunks'
import { WORLD_CX, WORLD_CY, WORLD_CZ, CHUNK } from '../world/chunks'
import { MAT_DIRT, MAT_GRASS, MAT_ASPHALT, MAT_SAND } from './materials'
import type { Island, IslandVoxel } from './connectivity'

const WVX = WORLD_CX * CHUNK
const WVY = WORLD_CY * CHUNK
const WVZ = WORLD_CZ * CHUNK

const TERRAIN = new Uint8Array(256)
for (const m of [MAT_DIRT, MAT_GRASS, MAT_ASPHALT, MAT_SAND]) TERRAIN[m] = 1

/** max voxels visited across ONE pass (all seeds). ~50-80ns per visit →
 *  worst case a few ms in the deferred stress slot. */
export const GROUND_CHECK_MAX_VISITS = 120_000
/** fragment edge for the crumble (matches structure.ts DEF.fragment) */
const FRAGMENT = 6

const pack = (x: number, y: number, z: number): number => x + z * WVX + y * WVX * WVZ

/**
 * Harvest seed voxels around an edit box: every structural voxel in the box
 * expanded by 1 (the shell left standing next to the removal). The flood
 * dedupes seeds that share a component.
 */
export function harvestSeeds(world: ChunkStore, edit: { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }): Array<[number, number, number]> {
  const seeds: Array<[number, number, number]> = []
  const x0 = Math.max(0, edit.x0 - 1), x1 = Math.min(WVX - 1, edit.x1 + 1)
  const y0 = Math.max(0, edit.y0 - 1), y1 = Math.min(WVY - 1, edit.y1 + 1)
  const z0 = Math.max(0, edit.z0 - 1), z1 = Math.min(WVZ - 1, edit.z1 + 1)
  for (let y = y0; y <= y1; y++)
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) {
        const m = world.getVoxel(x, y, z)
        if (m !== 0 && TERRAIN[m] === 0) seeds.push([x, y, z])
      }
  return seeds
}

/**
 * Flood every candidate component; return the provably-floating ones as
 * fragmented islands (ready for the extractIsland → debris path).
 */
export function findGroundlessComponents(
  world: ChunkStore,
  seeds: Array<[number, number, number]>,
  maxVisits: number = GROUND_CHECK_MAX_VISITS,
): Island[] {
  const visited = new Set<number>()
  const out: Island[] = []
  let budget = maxVisits

  for (const [sx, sy, sz] of seeds) {
    if (budget <= 0) break
    if (visited.has(pack(sx, sy, sz))) continue // component already judged
    const m0 = world.getVoxel(sx, sy, sz)
    if (m0 === 0 || TERRAIN[m0] === 1) continue

    // down-biased DFS: neighbour push order (up, +z, -z, +x, -x, DOWN) makes
    // DOWN pop first → grounded components confirm in ~height visits
    const stack: number[] = [pack(sx, sy, sz)]
    visited.add(stack[0])
    const comp: number[] = []
    let grounded = false
    let aborted = false
    while (stack.length > 0) {
      const p = stack.pop()!
      const y = Math.floor(p / (WVX * WVZ))
      const r = p - y * WVX * WVZ
      const z = Math.floor(r / WVX)
      const x = r - z * WVX
      comp.push(p)
      if (--budget <= 0 && stack.length > 0) { aborted = true; break }

      // grounded the moment we stand on terrain or the world floor
      if (y === 0) { grounded = true; break }
      const below = world.getVoxel(x, y - 1, z)
      if (TERRAIN[below] === 1) { grounded = true; break }

      const tryN = (nx: number, ny: number, nz: number): void => {
        if (nx < 0 || ny < 0 || nz < 0 || nx >= WVX || ny >= WVY || nz >= WVZ) return
        const np = pack(nx, ny, nz)
        if (visited.has(np)) return
        const nm = world.getVoxel(nx, ny, nz)
        if (nm === 0) return
        if (TERRAIN[nm] === 1) return // terrain itself never joins the component
        visited.add(np)
        stack.push(np)
      }
      tryN(x, y + 1, z)
      tryN(x, y, z + 1)
      tryN(x, y, z - 1)
      tryN(x + 1, y, z)
      tryN(x - 1, y, z)
      tryN(x, y - 1, z) // pushed last → popped FIRST (down bias)
    }

    if (grounded || aborted) continue // supported (or too big to judge — assume)

    // provably floating: fragment into crumble cubes
    const frags = new Map<number, IslandVoxel[]>()
    for (const p of comp) {
      const y = Math.floor(p / (WVX * WVZ))
      const r = p - y * WVX * WVZ
      const z = Math.floor(r / WVX)
      const x = r - z * WVX
      const key = ((x / FRAGMENT) | 0) + ((z / FRAGMENT) | 0) * 4096 + ((y / FRAGMENT) | 0) * 4096 * 4096
      let arr = frags.get(key)
      if (!arr) { arr = []; frags.set(key, arr) }
      arr.push({ x, y, z, mat: world.getVoxel(x, y, z) })
    }
    for (const arr of frags.values()) out.push({ voxels: arr })
  }
  return out
}
