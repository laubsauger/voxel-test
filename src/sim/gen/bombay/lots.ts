/**
 * T102 — Bombay Beach mobile homes with condition variants (WP4, research
 * §1.6/§3-WP4). Per BombayLot: a trailer (standard 56×28 or long single-wide
 * 84×32), or one of 2-3 zone-wide CMU stucco bungalows, dressed by
 * lot.condition:
 *   lived (35%)     — intact, white/pastel body, ONE art-pop accent door,
 *                     carport awning, porch step, fence, swamp cooler, tank,
 *                     parked car, minimal junk
 *   vacant (40%)    — greyed body, ~30% window glass dropped + open door,
 *                     graffiti blobs (art pops ONLY on wall faces), sand
 *                     drift wedge at the base, junk scatter, rust wreck
 *   burned (~10%)   — MAT_CHAR shell with ~40% voxel drop, one roof end
 *                     caved in + char slump, char spill on the ground
 *   collapsed (~15%)— half-height rubble pile (char/galv/wood/rust mix) in
 *                     the footprint + scattered debris
 * Plus: static rust-box car wrecks (no wheels — stampScene vehicle spawns
 * come from layout, so no real vehicles here) and a boat hulk on 2-3 lots
 * zone-wide. V19: the mass stays bleached/rust neutrals; art-pop chroma is
 * accents only (doors + graffiti). Deterministic per lot.seed (V2) — Prng +
 * position hashing only — no nondeterministic randomness (V2).
 */
import type { ChunkStore } from '../../../world/chunks'
import type { BombayLot, BombayZone, Layout, Rect, Side } from '../layout'
import { Prng } from '../../prng'
import {
  MAT_AIR,
  MAT_ART_PINK,
  MAT_ART_RED,
  MAT_ART_TEAL,
  MAT_ART_YELLOW,
  MAT_ASPHALT,
  MAT_BONE_SHELL,
  MAT_CHAR,
  MAT_CONCRETE,
  MAT_GALV_METAL,
  MAT_GLASS,
  MAT_METAL,
  MAT_PAINT,
  MAT_PLASTER,
  MAT_RUST,
  MAT_SAND,
  MAT_WOOD,
} from '../../materials'

// trailer verticals mirror the desert stampTrailer (stamper.ts): skirt at
// base..base+1, walls base+2..base+26, roof slab base+27 (+corrugation
// ridges base+28). Collapsed rubble stays ≤ base+12 — half the shell.
const WALL_TOP = 26
const ROOF_Y = 27
const RUBBLE_MAX = 12

const ART_POPS = [MAT_ART_RED, MAT_ART_YELLOW, MAT_ART_TEAL, MAT_ART_PINK] as const

/** deterministic integer hash (pure fn of position+seed — V2-safe) */
function hash3(x: number, y: number, z: number, seed: number): number {
  let h = (seed ^ Math.imul(x + 1, 0x9e3779b1) ^ Math.imul(y + 1, 0x85ebca6b) ^ Math.imul(z + 1, 0xc2b2ae35)) >>> 0
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d) >>> 0
  return (h ^ (h >>> 13)) >>> 0
}

function mix32(a: number, b: number): number {
  let h = (Math.imul(a ^ 0x9e3779b1, 0x85ebca6b) ^ Math.imul(b, 0xc2b2ae35)) >>> 0
  h ^= h >>> 16
  return Math.imul(h, 0x2c1b3c6d) >>> 0
}

// ---------------------------------------------------------------------------
// lot-local frame: d = distance in from the front street edge (0..D-1),
// a = along the street edge (0..W-1). Handles all four Side values so the
// stamp is orientation-agnostic (layout currently emits x-/x+ only).
// ---------------------------------------------------------------------------
interface Frame {
  rect: Rect
  front: Side
  D: number // lot depth (front → back)
  W: number // lot width (along the street)
}

function makeFrame(rect: Rect, front: Side): Frame {
  const alongX = front === 'x-' || front === 'x+'
  return {
    rect,
    front,
    D: (alongX ? rect.x1 - rect.x0 : rect.z1 - rect.z0) + 1,
    W: (alongX ? rect.z1 - rect.z0 : rect.x1 - rect.x0) + 1,
  }
}

function toWorld(f: Frame, d: number, a: number): [number, number] {
  switch (f.front) {
    case 'x-': return [f.rect.x0 + d, f.rect.z0 + a]
    case 'x+': return [f.rect.x1 - d, f.rect.z0 + a]
    case 'z-': return [f.rect.x0 + a, f.rect.z0 + d]
    case 'z+': return [f.rect.x0 + a, f.rect.z1 - d]
  }
}

function setL(store: ChunkStore, f: Frame, d: number, a: number, y: number, mat: number): void {
  const [x, z] = toWorld(f, d, a)
  store.setVoxel(x, y, z, mat)
}

function getL(store: ChunkStore, f: Frame, d: number, a: number, y: number): number {
  const [x, z] = toWorld(f, d, a)
  return store.getVoxel(x, y, z)
}

function boxL(store: ChunkStore, f: Frame, d0: number, a0: number, d1: number, a1: number, y0: number, y1: number, mat: number): void {
  const [xa, za] = toWorld(f, d0, a0)
  const [xb, zb] = toWorld(f, d1, a1)
  store.fillBox(Math.min(xa, xb), y0, Math.min(za, zb), Math.max(xa, xb), y1, Math.max(za, zb), mat)
}

/** position-hash in lot-local coords (world-independent would break V2 —
 * this uses WORLD coords so double-stamps agree and lots never mirror-twin) */
function hashL(f: Frame, d: number, a: number, y: number, seed: number): number {
  const [x, z] = toWorld(f, d, a)
  return hash3(x, y, z, seed)
}

/** first free y above the existing surface at (x,z); layout ground when the
 * column is empty (isolated stamps/tests). Keeps trailers seated when the
 * terrain WP slopes the town a couple of voxels seaward. */
function groundBase(store: ChunkStore, x: number, z: number, g: number): number {
  for (let y = g + 8; y >= g - 24; y--) {
    if (store.getVoxel(x, y, z) !== MAT_AIR) return y + 1
  }
  return g
}

// ---------------------------------------------------------------------------
// structure shells
// ---------------------------------------------------------------------------
type LotKind = 'std' | 'long' | 'bungalow'

interface Placement {
  kind: LotKind
  set: number // front setback (d of the front wall)
  a0: number // near edge along the street
  LD: number // structure depth extent
  LW: number // structure width extent
}

interface ShellStyle {
  bodyMat: number
  door: 'accent' | 'open'
  accentMat: number
  /** fraction ×100 of window glass voxels dropped (broken) */
  windowDropPct: number
  /** fraction ×100 of shell voxels dropped (burned husk) */
  shellDropPct: number
  dropSeed: number
}

/** trailer shell: metal skirt band, hollow body, corrugated galv roof,
 * window bands on the long faces, door on the front face */
function buildTrailerShell(store: ChunkStore, f: Frame, base: number, pl: Placement, s: ShellStyle): void {
  const d0 = pl.set
  const d1 = pl.set + pl.LD - 1
  const a0 = pl.a0
  const a1 = pl.a0 + pl.LW - 1
  const drop = (d: number, a: number, y: number): boolean =>
    s.shellDropPct > 0 && hashL(f, d, a, y, s.dropSeed) % 100 < s.shellDropPct

  const perim: [number, number][] = []
  for (let d = d0; d <= d1; d++) { perim.push([d, a0], [d, a1]) }
  for (let a = a0 + 1; a <= a1 - 1; a++) { perim.push([d0, a], [d1, a]) }

  // skirt (metal band at the base) + walls
  for (const [d, a] of perim) {
    for (let y = base; y <= base + 1; y++) if (!drop(d, a, y)) setL(store, f, d, a, y, MAT_METAL)
    for (let y = base + 2; y <= base + WALL_TOP; y++) if (!drop(d, a, y)) setL(store, f, d, a, y, s.bodyMat)
  }
  // interior floor slab (chassis deck)
  boxL(store, f, d0 + 1, a0 + 1, d1 - 1, a1 - 1, base + 2, base + 2, s.shellDropPct > 0 ? MAT_CHAR : MAT_WOOD)

  // corrugated galv roof: slab + ridge lines every 4 across the width
  const roofMat = s.shellDropPct > 0 ? MAT_CHAR : MAT_GALV_METAL
  for (let d = d0; d <= d1; d++) {
    for (let a = a0; a <= a1; a++) {
      if (drop(d, a, ROOF_Y)) continue
      setL(store, f, d, a, base + ROOF_Y, roofMat)
      if ((a - a0) % 4 === 0) setL(store, f, d, a, base + ROOF_Y + 1, roofMat)
    }
  }

  // window bands at eye height on the two LONG faces (mullion every 7th)
  const wy0 = base + 12
  const wy1 = base + 17
  const glassAt = (d: number, a: number, k: number): void => {
    for (let y = wy0; y <= wy1; y++) {
      if (k % 7 === 0) continue // mullion keeps the wall voxel
      const broken = s.windowDropPct > 0 && hashL(f, d, a, y, s.dropSeed ^ 0x91d0) % 100 < s.windowDropPct
      setL(store, f, d, a, y, broken || s.shellDropPct > 0 ? MAT_AIR : MAT_GLASS)
    }
  }
  const doorC = a0 + (pl.LW >> 1)
  if (pl.LW >= pl.LD) {
    // long faces = front/back: windows flank the door on the front
    for (let a = a0 + 3; a <= a1 - 3; a++) {
      if (Math.abs(a - doorC) > 5) glassAt(d0, a, a - a0)
      glassAt(d1, a, a - a0)
    }
  } else {
    // long faces = the sides
    for (let d = d0 + 3; d <= d1 - 3; d++) {
      glassAt(d, a0, d - d0)
      glassAt(d, a1, d - d0)
    }
  }

  // door on the front face — the ONE art-pop accent when lived (V19)
  const doorMat = s.door === 'accent' ? s.accentMat : MAT_AIR
  for (let a = doorC - 2; a <= doorC + 2; a++) {
    for (let y = base + 2; y <= base + 18; y++) setL(store, f, d0, a, y, doorMat)
  }
}

/** CMU stucco bungalow: concrete slab, plaster walls, flat roof + parapet */
function buildBungalowShell(store: ChunkStore, f: Frame, base: number, pl: Placement, s: ShellStyle): void {
  const d0 = pl.set
  const d1 = pl.set + pl.LD - 1
  const a0 = pl.a0
  const a1 = pl.a0 + pl.LW - 1
  const wallMat = s.shellDropPct > 0 ? MAT_CHAR : s.bodyMat
  const drop = (d: number, a: number, y: number): boolean =>
    s.shellDropPct > 0 && hashL(f, d, a, y, s.dropSeed) % 100 < s.shellDropPct

  boxL(store, f, d0, a0, d1, a1, base, base, MAT_CONCRETE) // slab
  for (let d = d0; d <= d1; d++) {
    for (let a = a0; a <= a1; a++) {
      const onPerim = d === d0 || d === d1 || a === a0 || a === a1
      if (onPerim) {
        for (let y = base + 1; y <= base + 23; y++) if (!drop(d, a, y)) setL(store, f, d, a, y, wallMat)
        if (!drop(d, a, 25)) setL(store, f, d, a, base + 25, wallMat) // parapet
      }
      if (!drop(d, a, 24)) setL(store, f, d, a, base + 24, s.shellDropPct > 0 ? MAT_CHAR : MAT_ASPHALT) // flat tar roof
    }
  }

  // punched windows (band + mullions) on the side faces
  for (let d = d0 + 4; d <= d1 - 4; d++) {
    for (let y = base + 10; y <= base + 16; y++) {
      if ((d - d0) % 8 < 3) continue // pier between windows
      const broken = s.windowDropPct > 0 && hashL(f, d, a0, y, s.dropSeed ^ 0x91d0) % 100 < s.windowDropPct
      setL(store, f, d, a0, y, broken || s.shellDropPct > 0 ? MAT_AIR : MAT_GLASS)
      const broken2 = s.windowDropPct > 0 && hashL(f, d, a1, y, s.dropSeed ^ 0x91d1) % 100 < s.windowDropPct
      setL(store, f, d, a1, y, broken2 || s.shellDropPct > 0 ? MAT_AIR : MAT_GLASS)
    }
  }
  // front door
  const doorC = a0 + (pl.LW >> 1)
  const doorMat = s.door === 'accent' ? s.accentMat : MAT_AIR
  for (let a = doorC - 2; a <= doorC + 2; a++) {
    for (let y = base + 1; y <= base + 17; y++) setL(store, f, d0, a, y, doorMat)
  }
}

// ---------------------------------------------------------------------------
// yard dressing
// ---------------------------------------------------------------------------

/** carport: galv awning slab on 2 posts beside the structure (lived) */
function stampCarport(store: ChunkStore, f: Frame, base: number, pl: Placement): void {
  const ca0 = pl.a0 + pl.LW + 1
  const ca1 = Math.min(f.W - 4, ca0 + 15)
  if (ca1 - ca0 < 6) return
  const cd0 = pl.set
  const cd1 = Math.min(pl.set + 19, pl.set + pl.LD - 1)
  boxL(store, f, cd0, ca0, cd1, ca1, base + 20, base + 20, MAT_GALV_METAL)
  boxL(store, f, cd0, ca1, cd0, ca1, base, base + 19, MAT_METAL)
  boxL(store, f, cd1, ca1, cd1, ca1, base, base + 19, MAT_METAL)
}

/** chain-link (galv posts + rails) or pallet (wood) fence on the lot edges,
 * with a gate gap centered on the front */
function stampFenceRing(store: ChunkStore, f: Frame, base: number, p: Prng): void {
  const chain = p.next() < 0.6
  const gateC = f.W >> 1
  const edge = (fixed: number, axis: 'd' | 'a', lo: number, hi: number, isFront: boolean): void => {
    for (let u = lo; u <= hi; u++) {
      if (isFront && Math.abs(u - gateC) <= 6) continue // gate gap
      const d = axis === 'd' ? u : fixed
      const a = axis === 'd' ? fixed : u
      if (chain) {
        if ((u - lo) % 10 === 0) boxL(store, f, d, a, d, a, base, base + 7, MAT_GALV_METAL) // post
        setL(store, f, d, a, base + 3, MAT_GALV_METAL)
        setL(store, f, d, a, base + 7, MAT_GALV_METAL)
      } else {
        if ((u - lo) % 7 === 6) continue // pallet gap
        boxL(store, f, d, a, d, a, base, base + 4, MAT_WOOD)
      }
    }
  }
  edge(1, 'a', 1, f.W - 2, true) // front
  edge(f.D - 2, 'a', 1, f.W - 2, false) // back
  edge(1, 'd', 1, f.D - 2, false) // sides
  edge(f.W - 2, 'd', 1, f.D - 2, false)
}

/** rooftop swamp-cooler box (galv) */
function stampCooler(store: ChunkStore, f: Frame, roofTop: number, pl: Placement, p: Prng): void {
  const cd = pl.set + 6 + p.nextInt(Math.max(1, pl.LD - 14))
  const ca = pl.a0 + 4 + p.nextInt(Math.max(1, pl.LW - 12))
  boxL(store, f, cd, ca, cd + 5, ca + 5, roofTop + 1, roofTop + 5, MAT_GALV_METAL)
}

/** backyard water tank: 8×8 galv drum with cut corners */
function stampTank(store: ChunkStore, f: Frame, base: number, pl: Placement): void {
  const td = Math.min(f.D - 12, pl.set + pl.LD + 10)
  const ta = pl.a0 + 2
  for (let d = 0; d < 8; d++) {
    for (let a = 0; a < 8; a++) {
      const corner = (d === 0 || d === 7) && (a === 0 || a === 7)
      if (corner) continue
      boxL(store, f, td + d, ta + a, td + d, ta + a, base, base + 11, MAT_GALV_METAL)
    }
  }
  boxL(store, f, td + 1, ta + 1, td + 6, ta + 6, base + 12, base + 12, MAT_PLASTER) // lid
}

/** scattered junk voxels (rust/wood) in the open yard */
function stampJunk(store: ChunkStore, f: Frame, base: number, pl: Placement, p: Prng, n: number): void {
  for (let i = 0; i < n; i++) {
    const d = 2 + p.nextInt(f.D - 4)
    const a = 2 + p.nextInt(f.W - 4)
    const mat = p.next() < 0.6 ? MAT_RUST : MAT_WOOD
    if (d >= pl.set - 1 && d <= pl.set + pl.LD && a >= pl.a0 - 1 && a <= pl.a0 + pl.LW) continue // inside the shell
    setL(store, f, d, a, base, mat)
    if (p.next() < 0.35) setL(store, f, d, a, base + 1, mat)
  }
}

/** static dead-car massing (~44×20×14): hull + hollow cabin, NO wheels.
 * hullMat MAT_RUST = wreck; MAT_METAL + glass = the lived lot's parked car. */
function stampCarBox(store: ChunkStore, f: Frame, base: number, d0: number, a0: number, alongA: boolean, hullMat: number, intact: boolean): void {
  const len = 44
  const wid = 20
  const dExt = alongA ? wid : len
  const aExt = alongA ? len : wid
  boxL(store, f, d0, a0, d0 + dExt - 1, a0 + aExt - 1, base, base + 6, hullMat) // body slab
  // cabin over the middle 24 of the length
  const c0 = 10
  const c1 = 33
  const cd0 = d0 + (alongA ? 0 : c0)
  const cd1 = d0 + (alongA ? dExt - 1 : c1)
  const ca0 = a0 + (alongA ? c0 : 0)
  const ca1 = a0 + (alongA ? c1 : aExt - 1)
  boxL(store, f, cd0, ca0, cd1, ca1, base + 7, base + 13, hullMat)
  boxL(store, f, cd0 + 1, ca0 + 1, cd1 - 1, ca1 - 1, base + 8, base + 12, MAT_AIR) // hollow
  // window band around the cabin (pillar every 6th cell)
  const winMat = intact ? MAT_GLASS : MAT_AIR
  let k = 0
  for (let d = cd0; d <= cd1; d++) {
    for (let a = ca0; a <= ca1; a++) {
      if (d !== cd0 && d !== cd1 && a !== ca0 && a !== ca1) continue
      if (k++ % 6 === 0) continue
      for (let y = base + 8; y <= base + 11; y++) setL(store, f, d, a, y, winMat)
    }
  }
}

/** bleached boat hulk on its trailer-less keel in the back yard, ~30×10×6 */
function stampBoatHulk(store: ChunkStore, f: Frame, base: number, seed: number): void {
  const bd = f.D - 10 // hull centreline near the back edge
  const ba0 = Math.max(4, f.W - 41)
  for (let i = 0; i < 30; i++) {
    const hw = i < 22 ? 4 : Math.max(1, 4 - (i - 22)) // bow taper
    for (let off = -hw; off <= hw; off++) {
      const d = bd + off
      const a = ba0 + i
      const rusty = hash3(i, off, 3, seed) % 100 < 18
      setL(store, f, d, a, base, rusty ? MAT_RUST : MAT_PLASTER) // bottom
      if (Math.abs(off) === hw) {
        for (let y = base + 1; y <= base + 4; y++) setL(store, f, d, a, y, rusty ? MAT_RUST : MAT_PLASTER)
        setL(store, f, d, a, base + 5, MAT_WOOD) // gunwale
      }
    }
  }
}

// ---------------------------------------------------------------------------
// condition dressing
// ---------------------------------------------------------------------------

/** graffiti: 2-4 art-pop blobs, ONLY replacing wall-face voxels (V19) */
function stampGraffiti(store: ChunkStore, f: Frame, base: number, pl: Placement, p: Prng, bodyMat: number): void {
  const n = 2 + p.nextInt(3)
  for (let i = 0; i < n; i++) {
    const face = p.nextInt(4)
    const mat = ART_POPS[p.nextInt(ART_POPS.length)]
    const r = 1 + p.nextInt(2)
    const alongLen = face < 2 ? pl.LW : pl.LD
    const u0 = 4 + p.nextInt(Math.max(1, alongLen - 8))
    const y0 = base + 4 + p.nextInt(6)
    for (let du = -r; du <= r; du++) {
      for (let dy = -r; dy <= r; dy++) {
        if (du * du + dy * dy > r * r + 1) continue
        const u = u0 + du
        const d = face === 0 ? pl.set : face === 1 ? pl.set + pl.LD - 1 : pl.set + u
        const a = face === 0 ? pl.a0 + u : face === 1 ? pl.a0 + u : face === 2 ? pl.a0 : pl.a0 + pl.LW - 1
        const y = y0 + dy
        if (getL(store, f, d, a, y) === bodyMat) setL(store, f, d, a, y, mat)
      }
    }
  }
}

/** windblown sand wedge against the front wall (vacant husks) */
function stampSandDrift(store: ChunkStore, f: Frame, base: number, pl: Placement, seed: number): void {
  for (let a = pl.a0 - 2; a <= pl.a0 + pl.LW + 1; a++) {
    const h = hash3(a, 7, 1, seed) % 4 // 0..3
    for (let j = 0; j < 3; j++) {
      const hj = h - j
      if (hj <= 0) continue
      const d = pl.set - 1 - j
      if (d < 1) break
      boxL(store, f, d, a, d, a, base, base + hj - 1, MAT_SAND)
    }
  }
}

/** burned: cave one roof end in + char slump inside, char spill outside */
function stampBurnDamage(store: ChunkStore, f: Frame, base: number, pl: Placement, p: Prng, seed: number): void {
  const d0 = pl.set
  const d1 = pl.set + pl.LD - 1
  const a0 = pl.a0
  const a1 = pl.a0 + pl.LW - 1
  // collapse end: half the footprint along the longer axis
  const alongA = pl.LW >= pl.LD
  const half = p.next() < 0.5
  const halfW = pl.LW >> 1
  const halfD = pl.LD >> 1
  const inCaved = (d: number, a: number): boolean =>
    alongA ? (half ? a - a0 < halfW : a - a0 >= halfW) : (half ? d - d0 < halfD : d - d0 >= halfD)
  for (let d = d0; d <= d1; d++) {
    for (let a = a0; a <= a1; a++) {
      if (!inCaved(d, a)) continue
      // strip roof + upper walls over the caved end
      boxL(store, f, d, a, d, a, base + 14, base + ROOF_Y + 1, MAT_AIR)
      // slumped char heap on the floor
      const h = hash3(d, 11, a, seed) % 5
      if (h > 0) {
        const m = hash3(d, 13, a, seed) % 100
        boxL(store, f, d, a, d, a, base + 2, base + 2 + h, m < 80 ? MAT_CHAR : m < 95 ? MAT_GALV_METAL : MAT_RUST)
      }
    }
  }
  // char spill on the ground around the shell
  for (let d = Math.max(1, d0 - 6); d <= Math.min(f.D - 2, d1 + 6); d++) {
    for (let a = Math.max(1, a0 - 6); a <= Math.min(f.W - 2, a1 + 6); a++) {
      if (d > d0 && d < d1 && a > a0 && a < a1) continue // interior has its own floor
      if (hash3(d, 17, a, seed) % 100 < 40) setL(store, f, d, a, base - 1, MAT_CHAR)
    }
  }
}

/** collapsed: half-height rubble dome (char/galv/wood/rust) + stray debris */
function stampRubble(store: ChunkStore, f: Frame, base: number, pl: Placement, p: Prng, seed: number): void {
  const d0 = pl.set
  const d1 = pl.set + pl.LD - 1
  const a0 = pl.a0
  const a1 = pl.a0 + pl.LW - 1
  for (let d = d0; d <= d1; d++) {
    for (let a = a0; a <= a1; a++) {
      const edge = Math.min(d - d0, d1 - d, a - a0, a1 - a)
      const coarse = hash3(d >> 2, 5, a >> 2, seed) % 8
      let h = 2 + coarse + (hash3(d, 6, a, seed) % 3) - 1
      h = Math.min(RUBBLE_MAX, Math.round(h * Math.min(1, (edge + 2) / 6)))
      if (h <= 0) continue
      for (let y = 0; y < h; y++) {
        const m = hash3(d, 20 + y, a, seed) % 100
        const mat = m < 30 ? MAT_CHAR : m < 55 ? MAT_GALV_METAL : m < 80 ? MAT_WOOD : MAT_RUST
        setL(store, f, d, a, base + y, mat)
      }
    }
  }
  // stray debris around the pile
  for (let i = 0; i < 10; i++) {
    const d = 2 + p.nextInt(f.D - 4)
    const a = 2 + p.nextInt(f.W - 4)
    const m = p.nextInt(3)
    setL(store, f, d, a, base, m === 0 ? MAT_CHAR : m === 1 ? MAT_GALV_METAL : MAT_WOOD)
  }
}

// ---------------------------------------------------------------------------
// per-lot stamp
// ---------------------------------------------------------------------------
function stampLot(store: ChunkStore, g: number, lot: BombayLot, bungalow: boolean, boat: boolean): void {
  const f = makeFrame(lot.rect, lot.front)
  const p = new Prng(lot.seed)

  // footprint kind + placement (deterministic from lot.seed)
  let kind: LotKind = bungalow ? 'bungalow' : p.next() < 0.3 && f.D >= 100 ? 'long' : 'std'
  if (kind === 'bungalow' && f.W < 58) kind = 'std' // defensive
  const dims: Record<LotKind, [number, number]> = {
    std: [28, 56], // standard single-wide parallel to the street (door faces it)
    long: [84, 32], // long single-wide runs down the lot depth
    bungalow: [60, 46],
  }
  const [LD, LW] = dims[kind]
  const set = 8 + p.nextInt(8)
  const a0 = 6 + p.nextInt(8)
  const pl: Placement = { kind, set, a0, LD, LW }

  // seat on the existing surface (terrain WP slopes the town seaward)
  const [cx, cz] = toWorld(f, set + (LD >> 1), a0 + (LW >> 1))
  const base = groundBase(store, cx, cz, g)

  // clear the footprint + a working margin, then a sand pad so nothing floats
  boxL(store, f, Math.max(0, set - 3), Math.max(0, a0 - 3), Math.min(f.D - 1, set + LD + 2), Math.min(f.W - 1, a0 + LW + 2), base, base + 44, MAT_AIR)
  boxL(store, f, Math.max(0, set - 3), Math.max(0, a0 - 3), Math.min(f.D - 1, set + LD + 2), Math.min(f.W - 1, a0 + LW + 2), base - 2, base - 1, MAT_SAND)

  const accentMat = ART_POPS[p.nextInt(ART_POPS.length)]
  const dropSeed = mix32(lot.seed, 0xd20b)

  switch (lot.condition) {
    case 'lived': {
      // white/pastel mass, art chroma ONLY on the door (V19)
      const roll = p.next()
      const bodyMat = kind === 'bungalow' ? MAT_PLASTER : roll < 0.45 ? MAT_PLASTER : roll < 0.75 ? MAT_PAINT : MAT_BONE_SHELL
      const style: ShellStyle = { bodyMat, door: 'accent', accentMat, windowDropPct: 0, shellDropPct: 0, dropSeed }
      if (kind === 'bungalow') buildBungalowShell(store, f, base, pl, style)
      else buildTrailerShell(store, f, base, pl, style)
      // porch step at the door
      const doorC = a0 + (LW >> 1)
      boxL(store, f, Math.max(1, set - 3), doorC - 2, set - 1, doorC + 2, base, base + 1, MAT_WOOD)
      stampCarport(store, f, base, pl)
      stampFenceRing(store, f, base, p)
      stampCooler(store, f, kind === 'bungalow' ? base + 25 : base + ROOF_Y, pl, p)
      if (set + LD + 18 < f.D - 2) stampTank(store, f, base, pl)
      stampJunk(store, f, base, pl, p, 2)
      if (p.next() < 0.5) {
        // the household's (still barely running) car, parked out back
        const cd0 = set + LD + 6
        if (cd0 + 20 <= f.D - 3) stampCarBox(store, f, base, cd0, 6 + p.nextInt(Math.max(1, f.W - 54)), true, MAT_METAL, true)
      }
      break
    }
    case 'vacant': {
      const roll = p.next()
      const bodyMat = kind === 'bungalow' ? MAT_PLASTER : roll < 0.6 ? MAT_GALV_METAL : roll < 0.85 ? MAT_PLASTER : MAT_BONE_SHELL
      const style: ShellStyle = { bodyMat, door: 'open', accentMat, windowDropPct: 30, shellDropPct: 0, dropSeed }
      if (kind === 'bungalow') buildBungalowShell(store, f, base, pl, style)
      else buildTrailerShell(store, f, base, pl, style)
      stampGraffiti(store, f, base, pl, p, bodyMat)
      stampSandDrift(store, f, base, pl, mix32(lot.seed, 0x5a4d))
      stampJunk(store, f, base, pl, p, 6 + p.nextInt(6))
      if (p.next() < 0.4) {
        const cd0 = set + LD + 6
        if (cd0 + 20 <= f.D - 3) stampCarBox(store, f, base, cd0, 6 + p.nextInt(Math.max(1, f.W - 54)), true, MAT_RUST, false)
      }
      break
    }
    case 'burned': {
      const style: ShellStyle = { bodyMat: MAT_CHAR, door: 'open', accentMat, windowDropPct: 100, shellDropPct: 40, dropSeed }
      if (kind === 'bungalow') buildBungalowShell(store, f, base, pl, style)
      else buildTrailerShell(store, f, base, pl, style)
      stampBurnDamage(store, f, base, pl, p, mix32(lot.seed, 0xf12e))
      if (p.next() < 0.3) {
        const cd0 = set + LD + 6
        if (cd0 + 20 <= f.D - 3) stampCarBox(store, f, base, cd0, 6 + p.nextInt(Math.max(1, f.W - 54)), true, MAT_RUST, false)
      }
      break
    }
    case 'collapsed': {
      stampRubble(store, f, base, pl, p, mix32(lot.seed, 0xc011))
      if (p.next() < 0.3) {
        const cd0 = set + LD + 6
        if (cd0 + 20 <= f.D - 3) stampCarBox(store, f, base, cd0, 6 + p.nextInt(Math.max(1, f.W - 54)), true, MAT_RUST, false)
      }
      break
    }
  }

  if (boat) stampBoatHulk(store, f, base, mix32(lot.seed, 0xb047))
}

/** rank lots by a salted hash of their seed; take the n smallest (stable) */
function pickSet(lots: BombayLot[], salt: number, n: number): Set<number> {
  const ranked = lots
    .map((l, i) => [mix32(l.seed, salt), i] as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
  return new Set(ranked.slice(0, n).map((r) => r[1]))
}

export function stampBombay_lots(store: ChunkStore, layout: Layout, zone: BombayZone): void {
  const g = layout.groundY
  const lots = zone.lots
  if (lots.length === 0) return
  // zone-wide sprinkles: 2-3 CMU bungalow footprints, 2-3 boat hulks
  const zh = lots.reduce((h, l) => mix32(h, l.seed), 0xb17a) >>> 0
  const bungalows = pickSet(lots, 0x5b1a, 2 + (zh & 1))
  const boats = pickSet(lots, 0xb047, 2 + ((zh >>> 1) & 1))
  for (let i = 0; i < lots.length; i++) {
    stampLot(store, g, lots[i], bungalows.has(i), boats.has(i))
  }
}
