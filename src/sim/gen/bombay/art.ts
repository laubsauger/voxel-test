/**
 * T104 — WP6 Bombay Beach in-grid Biennale art installations
 * (docs/research/bombay-beach.md §1.5 + §3 WP6).
 *
 * Stamped from zone data only: landmark rects (driveIn/operaHouse/tvWall/
 * daVinciFish) + the textSign/star BombayArt entries + the E-St stub (scrap
 * creature). Deterministic (V2): all variation comes from pure position
 * hashes (hash3) — no wall clock, no Prng stream shared with other WPs, and
 * circles are rasterized with exact Math.sqrt/round (no transcendentals).
 *
 * V19: these pieces carry the zone's sanctioned ≤5% art chroma (opera blue +
 * the four art pops). Everything structural stays neutral/rust/galv.
 *
 * Ground: each piece probes the store for the local surface (terrain/streets
 * are stamped before art in stampBombay's fixed order) and falls back to
 * layout.groundY on a bare store (unit tests).
 */
import type { ChunkStore } from '../../../world/chunks'
import {
  MAT_AIR,
  MAT_ART_PINK,
  MAT_ART_RED,
  MAT_ART_TEAL,
  MAT_ART_YELLOW,
  MAT_CHAR,
  MAT_CONCRETE,
  MAT_GALV_METAL,
  MAT_OPERA_BLUE,
  MAT_PLASTER,
  MAT_RUST,
  MAT_WOOD,
} from '../../materials'
import { hash3 } from '../stamper'
import type { BombayArt, BombayZone, Layout, Rect } from '../layout'

/** the four sanctioned art-pop chroma mats (T99) */
const ART_POPS = [MAT_ART_RED, MAT_ART_YELLOW, MAT_ART_TEAL, MAT_ART_PINK]
/** TV-box palette: art pops + opera blue (research: "each painted a
 * different vibrant color") */
const TV_PALETTE = [MAT_ART_RED, MAT_ART_YELLOW, MAT_ART_TEAL, MAT_ART_PINK, MAT_OPERA_BLUE]

/** first air voxel above the local ground column; layout.groundY on a bare
 * store (art stamps after terrain/streets, so the probe sees real grade) */
function surfaceY(store: ChunkStore, layout: Layout, x: number, z: number): number {
  for (let y = layout.groundY + 79; y >= 2; y--) {
    if (store.getVoxel(x, y, z) !== MAT_AIR) return y + 1
  }
  return layout.groundY
}

/** 4-way symmetric 1-thick circle rasterizer (exact sqrt — V2-safe).
 * Calls plot(da, db) for offsets from the center in the circle plane. */
function circle(r: number, plot: (da: number, db: number) => void): void {
  for (let a = -r; a <= r; a++) {
    const b = Math.round(Math.sqrt(r * r - a * a))
    plot(a, b)
    plot(a, -b)
    plot(b, a)
    plot(-b, a)
  }
}

export function stampBombay_art(store: ChunkStore, layout: Layout, zone: BombayZone): void {
  const lm = (k: string): Rect | null => zone.landmarks.find((l) => l.kind === k)?.rect ?? null

  const driveIn = lm('driveIn')
  if (driveIn) stampDriveIn(store, layout, driveIn)
  const opera = lm('operaHouse')
  if (opera) stampOperaHouse(store, layout, opera)
  const tv = lm('tvWall')
  if (tv) stampTvWall(store, layout, tv)
  const fish = lm('daVinciFish')
  if (fish) stampDaVinciFish(store, layout, fish)

  const sign = zone.art.find((a) => a.kind === 'textSign')
  if (sign) stampTextSign(store, layout, sign)
  const star = zone.art.find((a) => a.kind === 'star')
  if (star) stampStar(store, layout, star)
  stampScrapCreature(store, layout, zone)
}

// ---------------------------------------------------------------------------
// Drive-In — 2 rows × 4 wheel-less rust car hulks facing a white box-trailer
// screen on short posts at the rect's berm (east/x1) end (research §1.5).
// ---------------------------------------------------------------------------
function stampDriveIn(store: ChunkStore, layout: Layout, r: Rect): void {
  const cz = (r.z0 + r.z1) >> 1

  // white screen: plaster box-trailer 60 wide × 8 thick × 30 tall on 2 short
  // galv posts, broad face toward the car rows (west)
  const sx1 = r.x1 - 4
  const sx0 = sx1 - 7
  const sz0 = cz - 30
  const sz1 = cz + 29
  const sg = surfaceY(store, layout, sx0, cz)
  store.fillBox(sx0 + 3, sg, sz0 + 6, sx0 + 4, sg + 5, sz0 + 7, MAT_GALV_METAL)
  store.fillBox(sx0 + 3, sg, sz1 - 7, sx0 + 4, sg + 5, sz1 - 6, MAT_GALV_METAL)
  store.fillBox(sx0, sg + 6, sz0, sx1, sg + 35, sz1, MAT_PLASTER)

  // 2 rows × 4 wheel-less hulks, all noses toward the screen (+x), whole-voxel
  // offset jitter + silhouette variant per car from a position hash
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 4; col++) {
      const h = hash3(r.x0 + row, 41, r.z0 + col, 0xa47ca5)
      const jx = h % 7 // 0..6 — rows stay separated
      const jz = (h >>> 3) % 8 // 0..7 — 28-vox pitch keeps hulks disjoint
      const x0 = r.x0 + 12 + row * 62 + jx
      const z0 = r.z0 + 6 + col * 28 + jz
      stampCarHulk(store, layout, x0, z0, (h >>> 7) % 3)
    }
  }
}

/** one MAT_RUST hulk, ~44×20×12, sitting frameless on the dirt. variant:
 * 0 sedan, 1 wagon, 2 pickup — cabin carved hollow (glassless windows). */
function stampCarHulk(store: ChunkStore, layout: Layout, x0: number, z0: number, variant: number): void {
  const g = surfaceY(store, layout, x0 + 22, z0 + 10)
  // body slab (no wheels — sunk to the ground)
  store.fillBox(x0, g, z0, x0 + 43, g + 5, z0 + 19, MAT_RUST)
  if (variant === 0) {
    // sedan: mid cabin, hood + trunk decks
    store.fillBox(x0 + 12, g + 6, z0 + 2, x0 + 30, g + 11, z0 + 17, MAT_RUST)
    store.fillBox(x0 + 14, g + 7, z0 + 2, x0 + 28, g + 10, z0 + 17, MAT_AIR)
  } else if (variant === 1) {
    // wagon: long roof to the tail, B-pillar splits two window bays
    store.fillBox(x0 + 10, g + 6, z0 + 2, x0 + 40, g + 11, z0 + 17, MAT_RUST)
    store.fillBox(x0 + 12, g + 7, z0 + 2, x0 + 22, g + 10, z0 + 17, MAT_AIR)
    store.fillBox(x0 + 26, g + 7, z0 + 2, x0 + 38, g + 10, z0 + 17, MAT_AIR)
  } else {
    // pickup: short cab up front, open bed rails behind
    store.fillBox(x0 + 6, g + 6, z0 + 2, x0 + 17, g + 11, z0 + 17, MAT_RUST)
    store.fillBox(x0 + 8, g + 7, z0 + 2, x0 + 15, g + 10, z0 + 17, MAT_AIR)
    store.fillBox(x0 + 20, g + 6, z0 + 1, x0 + 43, g + 8, z0 + 2, MAT_RUST)
    store.fillBox(x0 + 20, g + 6, z0 + 17, x0 + 43, g + 8, z0 + 18, MAT_RUST)
    store.fillBox(x0 + 42, g + 6, z0 + 3, x0 + 43, g + 8, z0 + 16, MAT_RUST)
  }
}

// ---------------------------------------------------------------------------
// Opera House — trailer-shell conversion, MAT_OPERA_BLUE with a 2-vox art-pop
// speckle facade band (the flip-flop wall read), wide-open double-door front
// (dark interior + tiny stage), small marquee slab (research §1.5).
// ---------------------------------------------------------------------------
function stampOperaHouse(store: ChunkStore, layout: Layout, r: Rect): void {
  const cz = (r.z0 + r.z1) >> 1
  // 56×28 trailer base near the street (front = +x per the lot row)
  const bx1 = r.x1 - 6
  const bx0 = bx1 - 27
  const bz0 = cz - 28
  const bz1 = cz + 27
  const g = surfaceY(store, layout, (bx0 + bx1) >> 1, cz)
  const H = 20

  // shell: 2-thick walls/roof, hollow, dark floor + back wall inside
  store.fillBox(bx0, g, bz0, bx1, g + H - 1, bz1, MAT_OPERA_BLUE)
  store.fillBox(bx0 + 2, g + 1, bz0 + 2, bx1 - 2, g + H - 3, bz1 - 2, MAT_AIR)
  store.fillBox(bx0 + 2, g, bz0 + 2, bx1 - 2, g, bz1 - 2, MAT_CHAR)
  store.fillBox(bx0 + 1, g + 1, bz0 + 2, bx0 + 1, g + H - 3, bz1 - 2, MAT_CHAR)
  store.fillBox(bx0, g + H - 1, bz0, bx1, g + H - 1, bz1, MAT_GALV_METAL)

  // tiny stage platform against the back wall
  store.fillBox(bx0 + 2, g + 1, cz - 10, bx0 + 7, g + 2, cz + 9, MAT_WOOD)

  // wide-open double door on the front face (10 wide × 11 tall)
  store.fillBox(bx1 - 1, g + 1, cz - 5, bx1, g + 11, cz + 4, MAT_AIR)

  // flip-flop speckle band: two rows of 2×2 art-pop blocks set INTO the front
  // face above the door. Index rotation guarantees all four pops appear.
  for (let i = 0; bz0 + i * 2 <= bz1; i++) {
    const z = bz0 + i * 2
    for (let row = 0; row < 2; row++) {
      const m = ART_POPS[(i + row + (hash3(z, row, bx1, 0x0be7a) % 4)) % 4]
      store.fillBox(bx1, g + 13 + row * 2, z, bx1, g + 14 + row * 2, Math.min(z + 1, bz1), m)
    }
  }

  // marquee slab over the door + a few dark glyph blocks on its lip
  store.fillBox(bx1 + 1, g + 12, cz - 8, bx1 + 4, g + 13, cz + 7, MAT_PLASTER)
  for (let z = cz - 6; z <= cz + 5; z += 2) {
    if (hash3(z, 3, bx1, 0x0be7b) % 3 === 0) continue
    store.setVoxel(bx1 + 4, g + 13, z, MAT_CHAR)
  }
}

// ---------------------------------------------------------------------------
// TV wall — 24-30 painted-TV boxes (6-8 vox cubes, one vibrant mat each, char
// screen face recessed 1 vox): a haphazard wall of 2-4-high stacks fronting
// 4th St (+x) plus a scatter of singles in the yard (research §1.5).
// ---------------------------------------------------------------------------
function stampTvWall(store: ChunkStore, layout: Layout, r: Rect): void {
  const wallX = r.x1 - 14 // stack anchor; boxes ≤8 + jitter stay off the street

  // the wall: 6 stacks along z, alternating 3-4 / 2-3 boxes high so the total
  // box count is guaranteed in the 24-40 band with any hash draw
  let stackIdx = 0
  for (let z = r.z0 + 8; z + 8 <= r.z1 - 6; z += 11) {
    const hs = hash3(r.x0, stackIdx, r.z0, 0x7e1e50)
    const levels = (stackIdx % 2 === 0 ? 3 : 2) + (hs & 1) // 2..4 high
    let y = surfaceY(store, layout, wallX, z)
    let prev = -1
    for (let l = 0; l < levels; l++) {
      const hb = hash3(stackIdx, l, z, 0x7e1e51)
      const s = 6 + (hb % 3) // 6-8 vox cube
      let ci = (hb >>> 4) % TV_PALETTE.length
      if (ci === prev) ci = (ci + 1) % TV_PALETTE.length // touching boxes never share a mat
      prev = ci
      const ox = (hb >>> 8) % 2
      const oz = ((hb >>> 10) % 3) - 1 // haphazard ±1 offsets
      stampTvBox(store, wallX + ox, y, z + oz, s, TV_PALETTE[ci], 0)
      y += s
    }
    stackIdx++
  }

  // scattered singles on a loose 3×3 pad grid in the yard (never touching)
  for (let i = 0; i < 9; i++) {
    const h = hash3(r.x0, 100 + i, r.z1, 0x7e1e52)
    const x = r.x0 + 8 + (i % 3) * 18 + (h % 7) - 3
    const z = r.z0 + 10 + ((i / 3) | 0) * 24 + ((h >>> 8) % 7) - 3
    const s = 6 + ((h >>> 16) % 3)
    stampTvBox(store, x, surfaceY(store, layout, x, z), z, s, TV_PALETTE[(h >>> 20) % TV_PALETTE.length], (h >>> 24) % 4)
  }
}

/** one painted TV: s³ color cube, front face opened as a bezel with a
 * MAT_CHAR screen recessed 1 vox. face: 0 +x, 1 -x, 2 +z, 3 -z. */
function stampTvBox(store: ChunkStore, x0: number, y0: number, z0: number, s: number, mat: number, face: number): void {
  const x1 = x0 + s - 1
  const z1 = z0 + s - 1
  const y1 = y0 + s - 1
  store.fillBox(x0, y0, z0, x1, y1, z1, mat)
  if (face === 0) {
    store.fillBox(x1, y0 + 1, z0 + 1, x1, y1 - 1, z1 - 1, MAT_AIR)
    store.fillBox(x1 - 1, y0 + 1, z0 + 1, x1 - 1, y1 - 1, z1 - 1, MAT_CHAR)
  } else if (face === 1) {
    store.fillBox(x0, y0 + 1, z0 + 1, x0, y1 - 1, z1 - 1, MAT_AIR)
    store.fillBox(x0 + 1, y0 + 1, z0 + 1, x0 + 1, y1 - 1, z1 - 1, MAT_CHAR)
  } else if (face === 2) {
    store.fillBox(x0 + 1, y0 + 1, z1, x1 - 1, y1 - 1, z1, MAT_AIR)
    store.fillBox(x0 + 1, y0 + 1, z1 - 1, x1 - 1, y1 - 1, z1 - 1, MAT_CHAR)
  } else {
    store.fillBox(x0 + 1, y0 + 1, z0, x1 - 1, y1 - 1, z0, MAT_AIR)
    store.fillBox(x0 + 1, y0 + 1, z0 + 1, x1 - 1, y1 - 1, z0 + 1, MAT_CHAR)
  }
}

// ---------------------------------------------------------------------------
// Da Vinci Fish — 12 m (120 vox) rusted fish skeleton on a 3×3 galv pole
// ~24 tall: 2×2 rust spine, rib hoops every 8 vox, forked tail plate, boxy
// head (research §1.5: kinetic sculpture near 2nd/E-St).
// ---------------------------------------------------------------------------
function stampDaVinciFish(store: ChunkStore, layout: Layout, r: Rect): void {
  const fx = (r.x0 + r.x1) >> 1
  const fz = (r.z0 + r.z1) >> 1
  const g = surfaceY(store, layout, fx, fz)
  const zHead = fz - 60
  const zTail = fz + 59 // 120-vox spine

  // 3×3 galv pole up to the spine
  store.fillBox(fx - 1, g, fz - 1, fx + 1, g + 23, fz + 1, MAT_GALV_METAL)
  // 2×2 rust spine at pole height
  store.fillBox(fx - 1, g + 24, zHead, fx, g + 25, zTail, MAT_RUST)

  // rib hoops every 8 vox, radius swelling mid-body then tapering to the tail
  for (let z = zHead + 8; z <= zTail - 8; z += 8) {
    const t = (z - zHead) / (zTail - zHead)
    const rr = 4 + Math.round(5 * (1 - Math.abs(2 * t - 1))) // 4..9..4
    const yc = g + 24 - rr // hoop top touches the spine
    circle(rr, (da, db) => {
      store.setVoxel(fx + da, yc + db, z, MAT_RUST)
    })
  }

  // boxy head with a carved mouth + galv eyes
  store.fillBox(fx - 2, g + 21, zHead, fx + 1, g + 27, zHead + 10, MAT_RUST)
  store.fillBox(fx - 2, g + 22, zHead, fx + 1, g + 23, zHead + 3, MAT_AIR)
  store.setVoxel(fx - 2, g + 26, zHead + 5, MAT_GALV_METAL)
  store.setVoxel(fx + 1, g + 26, zHead + 5, MAT_GALV_METAL)

  // forked tail-fin plate past the spine end
  store.fillBox(fx - 1, g + 18, zTail - 5, fx, g + 31, zTail, MAT_RUST)
  store.fillBox(fx - 1, g + 22, zTail - 2, fx, g + 27, zTail, MAT_AIR)
}

// ---------------------------------------------------------------------------
// "The only other thing is nothing" — galv text-band sign: 2-line band of
// dark glyph blocks (reads as lettering at distance; no per-letter voxeling).
// Faces the town (-x) so it reads from the berm crest.
// ---------------------------------------------------------------------------
function stampTextSign(store: ChunkStore, layout: Layout, a: BombayArt): void {
  const g = surfaceY(store, layout, a.x, a.z)
  // posts + 40-wide × 8-tall × 2-thick band
  store.fillBox(a.x, g, a.z - 20, a.x + 1, g + 13, a.z - 19, MAT_GALV_METAL)
  store.fillBox(a.x, g, a.z + 18, a.x + 1, g + 13, a.z + 19, MAT_GALV_METAL)
  store.fillBox(a.x, g + 6, a.z - 20, a.x + 1, g + 13, a.z + 19, MAT_GALV_METAL)
  // two lines of hashed glyph blocks with word gaps
  for (let line = 0; line < 2; line++) {
    const y = line === 0 ? g + 11 : g + 8
    for (let z = a.z - 17; z <= a.z + 15; z += 3) {
      const h = hash3(z, line, a.x, 0x516e ^ a.seed)
      if (h % 4 === 0) continue // word gap
      const w = 1 + (h % 2)
      store.fillBox(a.x, y, z, a.x, y + 1, Math.min(z + w, a.z + 16), MAT_CHAR)
    }
  }
}

// ---------------------------------------------------------------------------
// Concrete star (5-point approx, ~10 vox) wrapped in a 1-vox char "barbed"
// ring — off the Ave C ramp (research §1.5).
// ---------------------------------------------------------------------------
const STAR_ROWS = [
  '.....X.....',
  '....XXX....',
  '....XXX....',
  'XXXXXXXXXXX',
  '.XXXXXXXXX.',
  '..XXXXXXX..',
  '..XXXXXXX..',
  '.XXXX.XXXX.',
  '.XXX...XXX.',
  'XXX.....XXX',
]

function stampStar(store: ChunkStore, layout: Layout, a: BombayArt): void {
  const g = surfaceY(store, layout, a.x, a.z)
  // 2-thick upright concrete star standing on its legs
  for (let i = 0; i < STAR_ROWS.length; i++) {
    const y = g + (STAR_ROWS.length - 1 - i)
    for (let j = 0; j < 11; j++) {
      if (STAR_ROWS[i][j] !== 'X') continue
      store.setVoxel(a.x - 1, y, a.z - 5 + j, MAT_CONCRETE)
      store.setVoxel(a.x, y, a.z - 5 + j, MAT_CONCRETE)
    }
  }
  // continuous char wire ring around it (touches the star's wide row) + barbs
  circle(6, (da, db) => {
    const y = g + 5 + db
    if (y < g) return
    store.setVoxel(a.x - 1, y, a.z + da, MAT_CHAR)
    store.setVoxel(a.x, y, a.z + da, MAT_CHAR)
  })
  for (const [dz, dy] of [[7, 0], [-7, 0], [0, 7]]) {
    store.setVoxel(a.x - 1, g + 5 + dy, a.z + dz, MAT_CHAR)
    store.setVoxel(a.x, g + 5 + dy, a.z + dz, MAT_CHAR)
  }
}

// ---------------------------------------------------------------------------
// ONE generic rusted-scrap creature — quadruped massing ~30 long, rust with
// galv patches, by the E-St stub. Research §1.5: explicitly NOT a Breceda
// dinosaur (those live at Borrego Springs).
// ---------------------------------------------------------------------------
function stampScrapCreature(store: ChunkStore, layout: Layout, zone: BombayZone): void {
  const stub = zone.stubs.find((s) => s.name.startsWith('E St'))
  if (!stub) return
  const h = hash3(stub.a1, 9, stub.center, 0xc7ea7)
  const x0 = stub.a1 - 50 + (h % 7) - 3
  const z0 = stub.center + 45 + ((h >>> 8) % 7) - 3 // south of the stub track
  const g = surfaceY(store, layout, x0 + 15, z0 + 4)

  // body 30×8×7, welded-scrap read: rust with hashed galv patches
  for (let x = x0; x <= x0 + 29; x++) {
    for (let y = g + 9; y <= g + 15; y++) {
      for (let z = z0; z <= z0 + 7; z++) {
        store.setVoxel(x, y, z, (hash3(x, y, z, 0x5c8a9) & 7) < 2 ? MAT_GALV_METAL : MAT_RUST)
      }
    }
  }
  // 4 legs
  for (const [lx, lz] of [[x0 + 2, z0 + 1], [x0 + 2, z0 + 5], [x0 + 25, z0 + 1], [x0 + 25, z0 + 5]]) {
    store.fillBox(lx, g, lz, lx + 1, g + 8, lz + 1, MAT_RUST)
  }
  // neck + head at the front (+x), stepped tail at the back
  store.fillBox(x0 + 26, g + 16, z0 + 2, x0 + 29, g + 21, z0 + 5, MAT_RUST)
  store.fillBox(x0 + 27, g + 22, z0 + 1, x0 + 34, g + 25, z0 + 6, MAT_RUST)
  store.setVoxel(x0 + 34, g + 24, z0 + 1, MAT_GALV_METAL)
  store.setVoxel(x0 + 34, g + 24, z0 + 6, MAT_GALV_METAL)
  for (let i = 0; i < 7; i++) {
    store.fillBox(x0 - 1 - i, g + 13 - i, z0 + 3, x0 - i, g + 14 - i, z0 + 4, MAT_RUST)
  }
}
