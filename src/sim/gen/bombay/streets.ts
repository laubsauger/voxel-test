/**
 * T101 — Bombay Beach street grid (WP3, docs/research/bombay-beach.md §1.1/§3).
 *
 * Turns the T98 BombayZone street contract into voxels: cracked sand-blown
 * asphalt for every named street + the Ave-A desert spur, B37-style ragged
 * dirt two-tracks for 2nd Street, the two alleys and the three dead-end
 * stubs past 5th (which fade out raggedly instead of ending in a hard
 * rectangle). NO lane markings anywhere — nothing here writes MAT_PAINT or
 * clean MAT_ASPHALT (research §1.1: "no street renders as clean city
 * asphalt").
 *
 * Terrain-following: the WP2 terrain module steps the zone's 20-30 vox
 * seaward fall in 1-vox terraces, so every cross-section samples the store
 * for the local ground top (first solid below a probe y) instead of assuming
 * a flat layout.groundY — streets ride the terraces without floating or
 * burying, and tolerate a flat stub terrain too (probe falls back to
 * groundY-1 on an all-air column).
 *
 * Deterministic (V2): pure position hashes (hash3/valueNoise) seeded from
 * layout.seed only. Runs after stampBombay_terrain, before lots.
 */
import type { ChunkStore } from '../../../world/chunks'
import { WORLD_VX, WORLD_VZ } from '../../../world/chunks'
import {
  MAT_AIR,
  MAT_CRACKED_ASPHALT,
  MAT_DIRT,
  MAT_PLAYA_MUD,
  MAT_SAND,
} from '../../materials'
import { hash3, valueNoise } from '../stamper'
import {
  BOMBAY_STREET_HALF,
  BOMBAY_VERGE_W,
  type BombayStreet,
  type BombayZone,
  type Layout,
} from '../layout'

const BED_DEPTH = 3 // asphalt slab thickness (matches ROAD_DEPTH idiom)
const GOUGE_H = 40 // clear-air height above the surface (B37 track idiom)
const BEND_RAMP = 120 // 5th St diagonal: offset eases in over this run length
/** stubs fade over their last (1-STUB_FADE_FROM) of run — raggedy dead end */
const STUB_FADE_FROM = 0.55

function inWorld(x: number, z: number): boolean {
  return x >= 0 && x < WORLD_VX && z >= 0 && z < WORLD_VZ
}

/** bend-aware centerline: honors the T98 contract exactly (center+offset for
 * run coord ≥ at) and eases the jog in over the BEND_RAMP vox before `at` so
 * the bent street stays one connected diagonal, not two offset rectangles. */
function centerAt(st: BombayStreet, p: number): number {
  if (!st.bend) return st.center
  if (p >= st.bend.at) return st.center + st.bend.offset
  const into = p - (st.bend.at - BEND_RAMP)
  if (into <= 0) return st.center
  return st.center + Math.round((st.bend.offset * into) / BEND_RAMP)
}

export function stampBombay_streets(store: ChunkStore, layout: Layout, zone: BombayZone): void {
  const g = layout.groundY
  const seed = (layout.seed ^ 0x7b0b31) >>> 0 // T101 stream — independent of other stampers

  /** local ground-top y at (x,z): first solid below the probe (probe starts
   * above the berm band). A street surface stamped earlier (intersections)
   * reads back at its recessed level, so cracked-asphalt/pothole-mud tops
   * count as grade+1 to keep crossing streets on the same grade. All-air
   * column (terrain still a stub / off the slab) falls back to groundY-1. */
  const groundTop = (x: number, z: number): number => {
    if (!inWorld(x, z)) return g - 1
    for (let y = g + 60; y >= 1; y--) {
      const m = store.getVoxel(x, y, z)
      if (m === MAT_AIR) continue
      if (m === MAT_CRACKED_ASPHALT || m === MAT_PLAYA_MUD) return y + 1
      return y
    }
    return g - 1
  }

  // -- cracked sand-blown asphalt (research §1.1 surfaces directive) --------
  // Per cross-section: 1-vox-recessed MAT_CRACKED_ASPHALT bed (top at
  // grade-1, air above) with flush 1 m sand verges, hash-dropped 4×4 patch
  // cells (~10%) punched through to playa mud / blown-in sand, and noise-run
  // sand drifts lapping over the asphalt edges at verge level. No paint.
  // On the bent street the bed covers the UNION of the original and the
  // offset alignment (old roadbed left in place through the kink) so the
  // T98 lots fronting the bent stretch still touch pavement.
  const stampCracked = (st: BombayStreet): void => {
    const half = BOMBAY_STREET_HALF
    const ext = half + BOMBAY_VERGE_W
    for (let p = st.a0; p <= st.a1; p++) {
      const c = centerAt(st, p)
      const lo = Math.min(st.center, c)
      const hi = Math.max(st.center, c)
      const cx = st.axis === 'x' ? p : c
      const cz = st.axis === 'x' ? c : p
      const top = groundTop(cx, cz) // sampled once per cross-section (terraces are street-band aligned)
      // sand drift reach over each asphalt edge for this row (0..~8 vox)
      const driftLo = Math.floor(Math.max(0, valueNoise(p, st.center - 977, 31, seed) - 0.52) * 18)
      const driftHi = Math.floor(Math.max(0, valueNoise(p, st.center + 977, 31, seed) - 0.52) * 18)
      for (let q = lo - ext; q <= hi + ext; q++) {
        const x = st.axis === 'x' ? p : q
        const z = st.axis === 'x' ? q : p
        if (!inWorld(x, z)) continue
        if (q >= lo - half && q <= hi + half) {
          // recessed roadway: bed top at grade-1, open air from grade up
          store.fillBox(x, top, z, x, top + GOUGE_H, z, MAT_AIR)
          store.fillBox(x, top - BED_DEPTH, z, x, top - 1, z, MAT_CRACKED_ASPHALT)
          // hash-dropped patch cells (4×4) punched to mud/sand — potholes +
          // sand blowover breaking the slab up (~10% of cells)
          const h = hash3(x >> 2, 3, z >> 2, seed)
          if (h % 100 < 10) {
            store.setVoxel(x, top - 1, z, (h & 0x100) !== 0 ? MAT_PLAYA_MUD : MAT_SAND)
          }
          // sand drift lapping over the recessed edge at verge level
          if (q <= lo - half + driftLo || q >= hi + half - driftHi) {
            store.setVoxel(x, top, z, MAT_SAND)
          }
        } else {
          // flush sand verge, 1 m each side
          store.fillBox(x, top + 1, z, x, top + GOUGE_H, z, MAT_AIR)
          store.fillBox(x, top - 1, z, x, top, z, MAT_SAND)
        }
      }
    }
  }

  // -- ragged dirt two-track (B37 track() idiom, stamper.ts stampDesert) ----
  // Wandering centreline + uneven-width band of packed dirt gouged into the
  // ground, with two 1-vox-deep wheel ruts. Stubs fade out by hash-dropping
  // surface voxels with rising probability toward the dead end.
  const stampDirt = (st: BombayStreet, fade: boolean): void => {
    const run = Math.max(1, st.a1 - st.a0)
    for (let p = st.a0; p <= st.a1; p++) {
      const c0 = centerAt(st, p)
      const c = c0 + Math.floor((valueNoise(p, c0, 34, seed) - 0.5) * 8) // ±4 wander
      const halfW = 12 + Math.floor(valueNoise(p, c0 + 613, 17, seed) * 5) // 12-16 ≈ BOMBAY_ALLEY_W
      const t = (p - st.a0) / run
      const drop = fade && t > STUB_FADE_FROM ? (t - STUB_FADE_FROM) / (1 - STUB_FADE_FROM) : 0
      const cx = st.axis === 'x' ? p : c
      const cz = st.axis === 'x' ? c : p
      const top = groundTop(cx, cz)
      for (let o = -halfW; o <= halfW; o++) {
        const x = st.axis === 'x' ? p : c + o
        const z = st.axis === 'x' ? c + o : p
        if (!inWorld(x, z)) continue
        // raggedy fade-out: per-voxel hash drop, denser toward the stub end
        if (drop > 0 && (hash3(x, 11, z, seed) & 0xff) < drop * 256) continue
        store.fillBox(x, top + 1, z, x, top + GOUGE_H, z, MAT_AIR) // gouge bumps/dunes
        store.fillBox(x, top - 1, z, x, top, z, MAT_DIRT) // packed-dirt surface, flush
        const ao = Math.abs(o)
        if (ao >= 5 && ao <= 8) {
          store.setVoxel(x, top, z, MAT_AIR) // the two wheel ruts, sunk 1 vox
        }
      }
    }
  }

  // dirt first so avenue asphalt owns the crossings (asphalt continues
  // through a dirt-street junction, not the other way around)
  for (const st of zone.streets) if (st.kind === 'dirt') stampDirt(st, false)
  for (const al of zone.alleys) stampDirt(al, false)
  for (const stub of zone.stubs) stampDirt(stub, true)
  for (const st of zone.streets) if (st.kind === 'asphalt-cracked') stampCracked(st)
  // the ONE junction with the outside world: cracked asphalt from the CA-111
  // frame road down to the Ave-A corner, same sand-drift edges
  stampCracked(zone.spur)
}
