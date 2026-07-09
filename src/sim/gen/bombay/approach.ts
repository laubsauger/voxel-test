/**
 * T106 — WP8 desert approach dressing + cosmetic rail (research §1/§3 WP8).
 * Last bombay module in the stamp order: everything here is margin-band
 * dressing that reads on the drive in — welcome sign + faded billboard at
 * the spur/CA-111 junction, a leaning utility-pole line down the spur and
 * 1st Street, sparse creosote scrub on the zone's desert margins, and a
 * cosmetic SINGLE-track rail (verified correction — NOT double) on the far
 * side of the world frame road that plays CA-111.
 *
 * Bounds discipline: every rect comes from the layout; scrub never lands on
 * street/lot/landmark rects (grown) and skips columns whose surface already
 * carries a non-ground material. The rail corridor hugs the road's far
 * sidewalk band; its bed straddles ~8 vox of the rim-block edge, gouged
 * clear of dunes first (B37 dirt-track idiom). Deterministic: Prng from
 * layout.seed + hash3 position hashes only (V2).
 */
import { WORLD_VX } from '../../../world/chunks'
import type { ChunkStore } from '../../../world/chunks'
import { Prng } from '../../prng'
import {
  MAT_AIR,
  MAT_ART_RED,
  MAT_ART_TEAL,
  MAT_CHAR,
  MAT_CONCRETE,
  MAT_DIRT,
  MAT_GALV_METAL,
  MAT_GRASS,
  MAT_LEAVES,
  MAT_METAL,
  MAT_PLASTER,
  MAT_RUST,
  MAT_SAND,
  MAT_WOOD,
} from '../../materials'
import { hash3 } from '../stamper'
import type { BombayStreet, BombayZone, Layout, Rect, Road } from '../layout'

/** T106 hash tag — every position hash in this module derives from it */
const TAG = 0x7106

// utility-pole line (research: leaning wood poles, NO wires — voxel wires read badly)
const POLE_STEP = 60
const POLE_H = 26
// rail cross-section, offsets from the corridor centreline zc (gauge 15)
const RAIL_A = -7
const RAIL_B = 8
const BED_LO = -9
const BED_HI = 10
const CLEAR_LO = -11
const CLEAR_HI = 12
/** bombay street half-extent incl. verge (mirrors layout's BB_ROAD_EXT=35) */
const ST_EXT = 35

export function stampBombay_approach(store: ChunkStore, layout: Layout, zone: BombayZone): void {
  const g = layout.groundY
  const sign = stampWelcomeSign(store, zone, g)
  const bill = stampBillboard(store, zone, g)
  stampPoleLine(store, zone, g)
  stampRail(store, layout, zone, g)
  scatterCreosote(store, layout, zone, g, [sign, bill])
}

/**
 * 'Welcome to Bombay Beach' sign at the spur/world-road junction: two wood
 * posts + an 18×8 plaster board carrying a dashed dark glyph band (text
 * suggestion, not letters). Faces north toward CA-111.
 */
function stampWelcomeSign(store: ChunkStore, zone: BombayZone, g: number): Rect {
  const x0 = zone.spur.center + 45 // east of the spur verge, clear of the roadway
  const z = zone.town.z0 + 16
  store.fillBox(x0, g, z, x0, g + 15, z, MAT_WOOD) // posts poke 1 above the board
  store.fillBox(x0 + 17, g, z, x0 + 17, g + 15, z, MAT_WOOD)
  store.fillBox(x0, g + 7, z, x0 + 17, g + 14, z, MAT_PLASTER) // 18×8 board
  // dark glyph band: dashed CHAR runs with hash word-gaps
  for (let x = x0 + 2; x <= x0 + 15; x++) {
    if (hash3(x, 0, z, TAG) % 4 === 0) continue
    store.setVoxel(x, g + 10, z, MAT_CHAR)
    if (hash3(x, 1, z, TAG) % 3 !== 0) store.setVoxel(x, g + 11, z, MAT_CHAR)
  }
  return { x0: x0 - 2, z0: z - 2, x1: x0 + 19, z1: z + 2 }
}

/**
 * Faded billboard near the junction ('The Last Resort' vibe): 2 metal posts,
 * 30×12 bleached plaster board, 2-color ghost of old paint as hash-eroded
 * 4×4 blocks (abstract — the paint job is long gone).
 */
function stampBillboard(store: ChunkStore, zone: BombayZone, g: number): Rect {
  const x0 = zone.spur.center + 84
  const z = zone.town.z0 + 78
  store.fillBox(x0 + 5, g, z, x0 + 5, g + 13, z, MAT_METAL)
  store.fillBox(x0 + 24, g, z, x0 + 24, g + 13, z, MAT_METAL)
  store.fillBox(x0, g + 12, z, x0 + 29, g + 23, z, MAT_PLASTER) // 30×12 board
  for (let y = g + 13; y <= g + 22; y++) {
    for (let x = x0 + 2; x <= x0 + 27; x++) {
      const c = hash3(x >> 2, (y - g) >> 2, z, TAG) % 10 // 4×4 paint blocks
      if (c >= 4) continue // bleached plaster wins most cells
      if (hash3(x, y, z, TAG) % 5 === 0) continue // eroded block edges
      store.setVoxel(x, y, z, c < 2 ? MAT_ART_RED : MAT_ART_TEAL)
    }
  }
  return { x0: x0 - 2, z0: z - 2, x1: x0 + 31, z1: z + 2 }
}

/**
 * Leaning utility-pole line: 2×2 wood poles ~26 tall with an 8-wide crossarm,
 * every ~60 vox down the west side of the spur and 1st Street through town.
 * Each pole leans 1-3 vox off vertical by seed — offset stacks per 8-vox
 * segment so the lean reads as a tilt, not a shear. NO wires.
 */
function stampPoleLine(store: ChunkStore, zone: BombayZone, g: number): void {
  const first = zone.streets.find((s) => s.name === '1st Street')
  const zEnd = first ? first.a1 : zone.spur.a1
  const px = zone.town.x0 + 2 // the 8-vox strip between the frame road and 1st St verge
  const dirs: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  for (let z = zone.town.z0 + 10; z <= zEnd; z += POLE_STEP) {
    const h = hash3(px, 0, z, TAG)
    const lean = 1 + (h % 3)
    const [dx, dz] = dirs[(h >>> 4) & 3]
    for (let y = 0; y < POLE_H; y++) {
      const seg = Math.min(3, y >> 3)
      const off = Math.round((lean * seg) / 3)
      const ox = px + dx * off
      const oz = z + dz * off
      store.fillBox(ox, g + y, oz, ox + 1, g + y, oz + 1, MAT_WOOD)
    }
    // crossarm at the leaned top, 8 wide across the line
    const ax = px + dx * lean
    const az = z + dz * lean
    store.fillBox(ax - 3, g + 23, az, ax + 4, g + 23, az, MAT_WOOD)
  }
}

/**
 * Cosmetic single-track rail on the far (north) side of the CA-111 frame
 * road: raised 3-vox gravel bed, 2 rust rails 15 vox apart, wood/galv ties
 * every 5 vox, 4-6 telegraph poles alongside. The bed drops to grade across
 * the z-road level crossings (short 1-vox ramps) so the roads stay passable.
 */
function stampRail(store: ChunkStore, layout: Layout, zone: BombayZone, g: number): void {
  // CA-111 = nearest world x-road north of the town rect (makeBombay contract)
  let road: Road | null = null
  for (const r of layout.roads) {
    if (r.axis !== 'x' || r.center >= zone.town.z0) continue
    if (!road || r.center > road.center) road = r
  }
  if (!road) return
  const zc = road.sidewalks[0].z0 + 1 // corridor centreline on the far sidewalk band
  const x0 = zone.town.x0
  const x1 = WORLD_VX - 1
  const cross: [number, number][] = layout.roads
    .filter((r) => r.axis === 'z' && r.asphalt.x1 >= x0 && r.asphalt.x0 <= x1)
    .map((r) => [r.asphalt.x0, r.asphalt.x1])
  const bedH = (x: number): number => {
    let d = 3
    for (const [a, b] of cross) d = Math.min(d, x < a ? a - x : x > b ? x - b : 3)
    return d
  }
  for (let x = x0; x <= x1; x++) {
    const h = bedH(x)
    // gouge dunes/anything clear of the corridor (B37 dirt-track idiom)
    store.fillBox(x, g, zc + CLEAR_LO, x, g + 40, zc + CLEAR_HI, MAT_AIR)
    if (h > 0) store.fillBox(x, g, zc + BED_LO, x, g + h - 1, zc + BED_HI, MAT_CONCRETE)
    if (h === 3 && x % 5 === 0) {
      // tie replaces the bed's top layer — mostly wood, the odd galv swap-in
      const tieMat = (hash3(x, 2, zc, TAG) & 3) === 0 ? MAT_GALV_METAL : MAT_WOOD
      store.fillBox(x, g + 2, zc + BED_LO, x, g + 2, zc + BED_HI, tieMat)
    }
    store.setVoxel(x, g + h, zc + RAIL_A, MAT_RUST)
    store.setVoxel(x, g + h, zc + RAIL_B, MAT_RUST)
  }
  // telegraph poles alongside, inland of the bed (never on a crossing)
  const pr = new Prng((layout.seed ^ 0x7106b0) >>> 0)
  const n = 4 + pr.nextInt(3)
  const span = x1 - x0 + 1
  for (let i = 0; i < n; i++) {
    let px = x0 + Math.floor(((i + 0.5) * span) / n) + pr.nextInt(41) - 20
    for (const [a, b] of cross) if (px >= a - 8 && px <= b + 8) px = b + 20
    px = Math.min(px, x1)
    const pz = zc - 13
    store.fillBox(px, g - 2, pz, px, g + 21, pz, MAT_WOOD)
    store.fillBox(px, g + 18, pz - 3, px, g + 18, pz + 3, MAT_WOOD) // crossarm
  }
}

/**
 * Creosote scrub: sparse olive shrubs (1-2 vox wood stem, 4-12 vox leaf
 * blob) hash-scattered over the zone's desert margins + the playa's berm-side
 * edge. Big bare gaps (research: sparse); never on streets/lots/landmarks/
 * playa salt, and never where the ground already carries a foreign material.
 */
function scatterCreosote(store: ChunkStore, layout: Layout, zone: BombayZone, g: number, extraExcl: Rect[]): void {
  const t = zone.town
  const aveA = zone.streets.find((s) => s.axis === 'x')
  const stz0 = aveA ? aveA.center - ST_EXT - 5 : zone.spur.a1
  let eastEdge = 0
  let stz1 = 0
  for (const s of zone.streets) {
    if (s.axis !== 'z') continue
    eastEdge = Math.max(eastEdge, s.center + (s.bend?.offset ?? 0))
    stz1 = Math.max(stz1, s.a1)
  }
  const regions: Rect[] = [
    { x0: t.x0 + 10, z0: t.z0 + 4, x1: t.x1 - 4, z1: stz0 - 6 }, // approach band by the spur
    { x0: eastEdge + ST_EXT + 6, z0: stz0, x1: t.x1 - 4, z1: stz1 }, // east margin past 5th
    { x0: t.x0 + 10, z0: stz1 + 6, x1: t.x1 - 4, z1: t.z1 - 4 }, // south margin
    // playa edge: the strip west of the berm — off the salt crust proper
    { x0: zone.shore.x0 + 2, z0: zone.shore.z0 + 4, x1: zone.berm.strip.x0 - 4, z1: zone.shore.z1 - 4 },
  ]
  const excl: Rect[] = [...extraExcl]
  const streetRect = (s: BombayStreet, grow: number): Rect =>
    s.axis === 'z'
      ? { x0: s.center - ST_EXT - grow, z0: s.a0 - grow, x1: s.center + ST_EXT + (s.bend?.offset ?? 0) + grow, z1: s.a1 + grow }
      : { x0: s.a0 - grow, z0: s.center - ST_EXT - grow, x1: s.a1 + grow, z1: s.center + ST_EXT + grow }
  for (const s of [...zone.streets, ...zone.alleys, zone.spur, ...zone.stubs]) excl.push(streetRect(s, 8))
  for (const l of zone.lots) excl.push(growRect(l.rect, 6))
  for (const l of zone.landmarks) excl.push(growRect(l.rect, 6))
  excl.push({ x0: t.x0, z0: t.z0, x1: t.x0 + 9, z1: t.z1 }) // utility-pole strip

  const seed = (layout.seed ^ 0xc9e07e) >>> 0
  for (const r of regions) {
    if (r.x1 - r.x0 < 12 || r.z1 - r.z0 < 12) continue
    for (let cz = r.z0; cz <= r.z1; cz += 72) {
      for (let cx = r.x0; cx <= r.x1; cx += 72) {
        const h = hash3(cx, 3, cz, seed)
        if (h % 100 >= 30) continue // ~70% of cells stay bare
        const x = cx + ((h >>> 8) % 56)
        const z = cz + ((h >>> 16) % 56)
        if (x > r.x1 - 3 || z > r.z1 - 3) continue
        if (excl.some((e) => x >= e.x0 - 2 && x <= e.x1 + 2 && z >= e.z0 - 2 && z <= e.z1 + 2)) continue
        // occupancy: only claim ground nothing else has dressed
        const surf = store.getVoxel(x, g - 1, z)
        if (surf !== MAT_AIR && surf !== MAT_GRASS && surf !== MAT_SAND && surf !== MAT_DIRT) continue
        if (store.getVoxel(x, g, z) !== MAT_AIR || store.getVoxel(x, g + 2, z) !== MAT_AIR) continue
        stampCreosoteBush(store, x, z, g, (h ^ seed) >>> 0)
      }
    }
  }
}

/** one creosote bush: 1-2 vox wood stem, ragged 4-12 vox MAT_LEAVES blob */
function stampCreosoteBush(store: ChunkStore, x: number, z: number, g: number, seed: number): void {
  const p = new Prng(seed)
  const stemH = 1 + p.nextInt(2)
  store.fillBox(x, g, z, x, g + stemH - 1, z, MAT_WOOD)
  const cy = g + stemH
  store.setVoxel(x, cy, z, MAT_LEAVES)
  const n = 3 + p.nextInt(9) // 4-12 leaf voxels incl. the core
  for (let i = 0; i < n; i++) {
    const vx = x + p.nextInt(3) - 1
    const vy = cy + p.nextInt(2)
    const vz = z + p.nextInt(3) - 1
    if (store.getVoxel(vx, vy, vz) === MAT_AIR) store.setVoxel(vx, vy, vz, MAT_LEAVES)
  }
}

function growRect(r: Rect, by: number): Rect {
  return { x0: r.x0 - by, z0: r.z0 - by, x1: r.x1 + by, z1: r.z1 + by }
}
