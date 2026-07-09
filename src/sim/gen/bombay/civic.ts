/**
 * T103 — WP5 Bombay civic strip (docs/research/bombay-beach.md §1.5, §3 WP5).
 *
 * Ski Inn (the only bar — walkable interior: L-shaped bar, stools, tables,
 * jukebox, pool table, dollar-bill wall band, 'SKI INN' facade lettering +
 * freestanding pole sign), Bombay Market, 1-bay volunteer fire station,
 * American Legion hall with chain-link fenced gravel lot + flag pole, small
 * gable church with a wood cross, and the comms mast + 3 dish boxes.
 *
 * Every write is a pure function of the zone's landmark rects (layout.ts
 * makeBombay) plus position hashes → deterministic AND idempotent (V2):
 * stamping twice yields the same voxels. All civic fronts face their street
 * to the west ('x-' — each rect's x0 edge sits on a N-S street verge), so
 * the Ski Inn facade + pole sign read from the Avenue A entrance spur.
 * Chroma stays tiny (V19): art-pop mats appear only as dollar-wall flecks,
 * the jukebox, shelf bottles, sign trim and the Legion flag.
 */
import type { ChunkStore } from '../../../world/chunks'
import {
  MAT_AIR,
  MAT_ART_PINK,
  MAT_ART_RED,
  MAT_ART_TEAL,
  MAT_ART_YELLOW,
  MAT_BONE_SHELL,
  MAT_CHAR,
  MAT_CONCRETE,
  MAT_GALV_METAL,
  MAT_GLASS,
  MAT_GRASS,
  MAT_METAL,
  MAT_PLASTER,
  MAT_PLAYA_MUD,
  MAT_ROOFTILE,
  MAT_SAND,
  MAT_WOOD,
} from '../../materials'
import { DOOR_H, DOOR_W, type BombayLandmark, type BombayZone, type Layout, type Rect } from '../layout'
import { hash3, stampWalls, wallOpening } from '../stamper'

const ART_POPS = [MAT_ART_RED, MAT_ART_YELLOW, MAT_ART_TEAL, MAT_ART_PINK] as const

/** Ski Inn interior/facade offsets shared with tests (all relative to rect) */
export const SKI = {
  wallTop: 29, // single story ~30 tall incl. flat roof slab
  doorOff: 35, // (80 - DOOR_W) >> 1 — centered on the front face
  letterY0: 22, // 'SKI INN' band sits between door top (21) and trim (27)
  letterY1: 26,
  // guaranteed-clear walk bands (≥2 wide): door → aisle → bar front →
  // north pass → behind the bar (the V-accept "in, around the bar, out")
  aisle: { x0: 2, x1: 56, z0: 36, z1: 43 },
  barFrontBand: { x0: 52, x1: 56, z0: 6, z1: 43 },
  northPass: { x0: 52, x1: 90, z0: 6, z1: 9 },
  backBar: { x0: 70, x1: 90, z0: 12, z1: 30 },
} as const

/** 4×5 glyphs, rows top→bottom, bit 3 = leftmost column */
const FONT4: Record<string, readonly number[]> = {
  S: [0b1111, 0b1000, 0b1111, 0b0001, 0b1111],
  K: [0b1001, 0b1010, 0b1100, 0b1010, 0b1001],
  I: [0b1111, 0b0110, 0b0110, 0b0110, 0b1111],
  N: [0b1001, 0b1101, 0b1011, 0b1001, 0b1001],
}

/**
 * Voxel lettering on a x = const wall plane, read by a viewer standing west
 * looking +x. Facing +x with up +y puts the viewer's LEFT at -z (up×fwd), so
 * left-to-right reading advances +z from zStart (was -z — mirrored 'IKS', the
 * bug the first tour screenshot caught).
 */
function stampTextXFace(
  store: ChunkStore,
  text: string,
  x: number,
  yTop: number,
  zStart: number,
  mat: number,
): void {
  let z = zStart
  for (const ch of text) {
    if (ch === ' ') {
      z += 4
      continue
    }
    const glyph = FONT4[ch]
    if (!glyph) throw new Error(`T103 stampTextXFace: no glyph for '${ch}'`)
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 4; col++) {
        if ((glyph[row] >> (3 - col)) & 1) store.setVoxel(x, yTop - row, z + col, mat)
      }
    }
    z += 5 // 4 columns + 1 gap
  }
}

/** shared shell: floor slab at g, walls, flat concrete roof, cleared interior */
function stampShell(
  store: ChunkStore,
  r: Rect,
  g: number,
  wallTop: number,
  wallMat: number,
  floorMat: number,
): void {
  store.fillBox(r.x0, g, r.z0, r.x1, g, r.z1, floorMat)
  stampWalls(store, r, g + 1, wallTop, wallMat)
  store.fillBox(r.x0 + 2, g + 1, r.z0 + 2, r.x1 - 2, wallTop, r.z1 - 2, MAT_AIR)
  store.fillBox(r.x0, wallTop + 1, r.z0, r.x1, wallTop + 2, r.z1, MAT_CONCRETE)
}

// ---------------------------------------------------------------------------
// Ski Inn — 100×80, the lowest bar in the Western Hemisphere
// ---------------------------------------------------------------------------
function stampSkiInn(store: ChunkStore, r: Rect, g: number): void {
  const top = g + SKI.wallTop
  // tan sand-tone shell, wood floor, dark wood trim band under the roof line
  store.fillBox(r.x0, g, r.z0, r.x1, g, r.z1, MAT_WOOD)
  stampWalls(store, r, g + 1, top, MAT_SAND)
  stampWalls(store, r, top - 2, top, MAT_WOOD)
  store.fillBox(r.x0 + 2, g + 1, r.z0 + 2, r.x1 - 2, top, r.z1 - 2, MAT_AIR)
  store.fillBox(r.x0, top + 1, r.z0, r.x1, top + 2, r.z1, MAT_CONCRETE)
  // galv swamp-cooler box on the flat roof
  store.fillBox(r.x0 + 40, top + 3, r.z0 + 30, r.x0 + 47, top + 8, r.z0 + 37, MAT_GALV_METAL)

  // openings — front door centered on the street face, windows clear of the
  // letter band (z 24..56) and the trim
  wallOpening(store, r, 'x-', SKI.doorOff, DOOR_W, g + 1, g + DOOR_H, MAT_AIR)
  wallOpening(store, r, 'x-', 8, 10, g + 12, g + 19, MAT_GLASS)
  wallOpening(store, r, 'x-', 62, 10, g + 12, g + 19, MAT_GLASS)
  for (const side of ['z-', 'z+'] as const) {
    wallOpening(store, r, side, 15, 10, g + 12, g + 19, MAT_GLASS)
    wallOpening(store, r, side, 70, 10, g + 12, g + 19, MAT_GLASS)
  }

  // 'SKI INN' char lettering above the door (5 tall, reads from the spur).
  // Width 33 (6 glyphs ×5 − trailing gap + space 4), centered on the door.
  stampTextXFace(store, 'SKI INN', r.x0, g + SKI.letterY1, r.z0 + 24, MAT_CHAR) // band z 24..56, reads left→right from the street

  // dollar-bill wall — inner wall band: bone-shell speckle + sparse art
  // flecks (~1/16, V19-tiny). Guard on the wall mat so windows/door survive.
  const bandY0 = g + 8
  const bandY1 = g + 22
  const paintDollar = (x: number, y: number, z: number): void => {
    if (store.getVoxel(x, y, z) !== MAT_SAND) return
    const h = hash3(x, y, z, 0x7103d011)
    store.setVoxel(x, y, z, (h & 15) === 0 ? ART_POPS[(h >>> 4) & 3] : MAT_BONE_SHELL)
  }
  for (let y = bandY0; y <= bandY1; y++) {
    for (let z = r.z0 + 2; z <= r.z1 - 2; z++) {
      paintDollar(r.x0 + 1, y, z)
      paintDollar(r.x1 - 1, y, z)
    }
    for (let x = r.x0 + 2; x <= r.x1 - 2; x++) {
      paintDollar(x, y, r.z0 + 1)
      paintDollar(x, y, r.z1 - 1)
    }
  }

  // --- interior (offsets keep the SKI walk bands clear by construction) ---
  // L-shaped bar: main run parallel to the front + leg toward the east wall
  store.fillBox(r.x0 + 62, g + 1, r.z0 + 12, r.x0 + 65, g + 10, r.z0 + 55, MAT_WOOD)
  store.fillBox(r.x0 + 66, g + 1, r.z0 + 52, r.x0 + 85, g + 10, r.z0 + 55, MAT_WOOD)
  // back-bar shelf against the east wall + a few art-pop bottles on top
  store.fillBox(r.x0 + 95, g + 1, r.z0 + 14, r.x0 + 96, g + 12, r.z0 + 50, MAT_WOOD)
  for (let z = r.z0 + 14; z <= r.z0 + 50; z++) {
    const h = hash3(r.x0 + 95, 1, z, 0x7103b071)
    if ((h & 3) === 0) store.setVoxel(r.x0 + 95, g + 13, z, ART_POPS[(h >>> 2) & 3])
  }
  // 5 stools: 1×1 wood posts w/ seat, at the bar front + one at the L-leg
  for (const dz of [16, 24, 32, 48]) {
    store.fillBox(r.x0 + 60, g + 1, r.z0 + dz, r.x0 + 60, g + 7, r.z0 + dz, MAT_WOOD)
  }
  store.fillBox(r.x0 + 74, g + 1, r.z0 + 58, r.x0 + 74, g + 7, r.z0 + 58, MAT_WOOD)
  // 2 tables (pedestal + top) + 2 chairs each, north-west corner
  for (const tz of [10, 22]) {
    store.fillBox(r.x0 + 17, g + 1, r.z0 + tz + 3, r.x0 + 18, g + 6, r.z0 + tz + 4, MAT_WOOD)
    store.fillBox(r.x0 + 14, g + 7, r.z0 + tz, r.x0 + 21, g + 7, r.z0 + tz + 7, MAT_WOOD)
    for (const [cx, back] of [
      [r.x0 + 10, r.x0 + 10],
      [r.x0 + 24, r.x0 + 25],
    ]) {
      store.fillBox(cx, g + 1, r.z0 + tz + 3, cx + 1, g + 4, r.z0 + tz + 4, MAT_WOOD)
      store.fillBox(back, g + 5, r.z0 + tz + 3, back, g + 8, r.z0 + tz + 4, MAT_WOOD)
    }
  }
  // jukebox: art-teal box + metal cap, against the south wall by the door
  store.fillBox(r.x0 + 6, g + 1, r.z0 + 70, r.x0 + 11, g + 11, r.z0 + 73, MAT_ART_TEAL)
  store.fillBox(r.x0 + 6, g + 12, r.z0 + 70, r.x0 + 11, g + 12, r.z0 + 73, MAT_METAL)
  // pool table: wood body + rail, grass felt inset on top
  store.fillBox(r.x0 + 20, g + 1, r.z0 + 60, r.x0 + 43, g + 7, r.z0 + 71, MAT_WOOD)
  store.fillBox(r.x0 + 21, g + 7, r.z0 + 61, r.x0 + 42, g + 7, r.z0 + 70, MAT_GRASS)

  // freestanding pole sign on the street verge (x0-10 = 27 vox off the
  // street centerline → past the 25-vox asphalt, on the sand verge)
  store.fillBox(r.x0 - 10, g, r.z0 + 4, r.x0 - 9, g + 20, r.z0 + 5, MAT_METAL)
  store.fillBox(r.x0 - 14, g + 14, r.z0 + 4, r.x0 - 5, g + 21, r.z0 + 5, MAT_PLASTER)
  store.fillBox(r.x0 - 13, g + 17, r.z0 + 4, r.x0 - 6, g + 18, r.z0 + 5, MAT_CHAR)
  store.fillBox(r.x0 - 14, g + 21, r.z0 + 4, r.x0 - 5, g + 21, r.z0 + 5, MAT_ART_RED)
}

// ---------------------------------------------------------------------------
// the rest of the strip — shells with door openings, no interiors (§3 WP5)
// ---------------------------------------------------------------------------
function stampMarket(store: ChunkStore, r: Rect, g: number): void {
  stampShell(store, r, g, g + 24, MAT_PLASTER, MAT_CONCRETE)
  wallOpening(store, r, 'x-', 25, DOOR_W, g + 1, g + DOOR_H, MAT_AIR)
  wallOpening(store, r, 'x-', 6, 14, g + 12, g + 19, MAT_GLASS) // window band,
  wallOpening(store, r, 'x-', 40, 14, g + 12, g + 19, MAT_GLASS) // door splits it
  // faded sign band over the windows: bone-shell whitewash, sparse yellow
  for (let z = r.z0 + 4; z <= r.z1 - 4; z++) {
    for (let y = g + 20; y <= g + 23; y++) {
      store.setVoxel(r.x0, y, z, (hash3(r.x0, y, z, 0x7103a3e7) & 7) === 0 ? MAT_ART_YELLOW : MAT_BONE_SHELL)
    }
  }
}

function stampFireStation(store: ChunkStore, r: Rect, g: number): void {
  stampShell(store, r, g, g + 26, MAT_CONCRETE, MAT_CONCRETE)
  // 1-bay garage: big opening framed in a galv roll-door track + lintel
  wallOpening(store, r, 'x-', 5, 1, g + 1, g + 22, MAT_GALV_METAL)
  wallOpening(store, r, 'x-', 32, 1, g + 1, g + 22, MAT_GALV_METAL)
  wallOpening(store, r, 'x-', 5, 28, g + 21, g + 22, MAT_GALV_METAL)
  wallOpening(store, r, 'x-', 6, 26, g + 1, g + 20, MAT_AIR)
  wallOpening(store, r, 'x-', 40, DOOR_W, g + 1, g + DOOR_H, MAT_AIR) // crew door
  wallOpening(store, r, 'x-', 50, 8, g + 12, g + 19, MAT_GLASS)
}

function stampLegion(store: ChunkStore, r: Rect, g: number): void {
  // hall on the street, chain-link fenced gravel lot behind it (south)
  const hall: Rect = { x0: r.x0, z0: r.z0, x1: r.x1, z1: r.z0 + 55 }
  stampShell(store, hall, g, g + 26, MAT_PLASTER, MAT_CONCRETE)
  wallOpening(store, hall, 'x-', 23, DOOR_W, g + 1, g + DOOR_H, MAT_AIR)
  wallOpening(store, hall, 'x-', 6, 10, g + 12, g + 19, MAT_GLASS)
  wallOpening(store, hall, 'x-', 38, 10, g + 12, g + 19, MAT_GLASS)
  // flag pole (metal, 24 tall) on the verge + a small art-red flag
  store.fillBox(r.x0 - 6, g, r.z0 + 10, r.x0 - 6, g + 23, r.z0 + 10, MAT_METAL)
  store.fillBox(r.x0 - 6, g + 20, r.z0 + 11, r.x0 - 6, g + 23, r.z0 + 14, MAT_ART_RED)
  // gravel lot: playa-mud surface + chain-link (galv rails y+4/y+7, posts
  // every 10) with a street-side gate gap
  const lot: Rect = { x0: r.x0, z0: r.z0 + 58, x1: r.x1, z1: r.z1 }
  store.fillBox(lot.x0, g - 1, lot.z0, lot.x1, g - 1, lot.z1, MAT_PLAYA_MUD)
  const gate0 = lot.z0 + 15
  const gate1 = lot.z0 + 26
  const post = (x: number, z: number): void => {
    store.fillBox(x, g, z, x, g + 6, z, MAT_GALV_METAL)
  }
  for (let x = lot.x0; x <= lot.x1; x++) {
    for (const y of [g + 3, g + 6]) {
      store.setVoxel(x, y, lot.z0, MAT_GALV_METAL)
      store.setVoxel(x, y, lot.z1, MAT_GALV_METAL)
    }
    if ((x - lot.x0) % 10 === 0) {
      post(x, lot.z0)
      post(x, lot.z1)
    }
  }
  for (let z = lot.z0; z <= lot.z1; z++) {
    const inGate = z >= gate0 && z <= gate1
    for (const y of [g + 3, g + 6]) {
      if (!inGate) store.setVoxel(lot.x0, y, z, MAT_GALV_METAL)
      store.setVoxel(lot.x1, y, z, MAT_GALV_METAL)
    }
    if ((z - lot.z0) % 10 === 0) {
      if (!inGate) post(lot.x0, z)
      post(lot.x1, z)
    }
  }
}

function stampChurch(store: ChunkStore, r: Rect, g: number): void {
  const top = g + 24
  store.fillBox(r.x0, g, r.z0, r.x1, g, r.z1, MAT_CONCRETE)
  stampWalls(store, r, g + 1, top, MAT_PLASTER)
  store.fillBox(r.x0 + 2, g + 1, r.z0 + 2, r.x1 - 2, top, r.z1 - 2, MAT_AIR)
  // gable roof, ridge along x → the gable end faces the street (house idiom:
  // solid stepped levels, slope 1 up : 2 in)
  const roofY = top + 1
  for (let lvl = 0; r.z0 + 2 * lvl <= r.z1 - 2 * lvl; lvl++) {
    store.fillBox(r.x0, roofY + lvl, r.z0 + 2 * lvl, r.x1, roofY + lvl, r.z1 - 2 * lvl, MAT_ROOFTILE)
  }
  wallOpening(store, r, 'x-', 25, DOOR_W, g + 1, g + DOOR_H, MAT_AIR)
  wallOpening(store, r, 'x-', 8, 9, g + 10, g + 17, MAT_GLASS)
  wallOpening(store, r, 'x-', 43, 9, g + 10, g + 17, MAT_GLASS)
  // wood cross (8 tall) on the street gable, backed by the solid roof steps
  const zc = r.z0 + 29
  store.fillBox(r.x0 - 1, g + 27, zc, r.x0 - 1, g + 34, zc, MAT_WOOD)
  store.fillBox(r.x0 - 1, g + 32, zc - 3, r.x0 - 1, g + 32, zc + 3, MAT_WOOD)
}

function stampCommsMast(store: ChunkStore, r: Rect, g: number): void {
  // concrete pad + 30-vox tapering lattice mast (3×3 ring → 2×2 → 1×1)
  store.fillBox(r.x0, g - 1, r.z0, r.x1, g - 1, r.z1, MAT_CONCRETE)
  const cx = r.x0 + 10
  const cz = r.z0 + 10
  for (let y = g; y <= g + 11; y++) {
    if ((y - g) % 4 === 0) {
      store.fillBox(cx - 1, y, cz - 1, cx + 1, y, cz + 1, MAT_METAL)
      store.setVoxel(cx, y, cz, MAT_AIR) // hollow lattice ring
    } else {
      for (const [dx, dz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
        store.setVoxel(cx + dx, y, cz + dz, MAT_METAL)
      }
    }
  }
  store.fillBox(cx - 1, g + 12, cz - 1, cx, g + 21, cz, MAT_METAL)
  store.fillBox(cx, g + 22, cz, cx, g + 29, cz, MAT_METAL)
  // 3 dish boxes: two on the pad, one mounted on the mast
  store.fillBox(r.x0 + 2, g, r.z0 + 2, r.x0 + 5, g + 3, r.z0 + 5, MAT_GALV_METAL)
  store.fillBox(r.x0 + 14, g, r.z0 + 3, r.x0 + 17, g + 3, r.z0 + 6, MAT_GALV_METAL)
  store.fillBox(cx + 1, g + 15, cz, cx + 2, g + 17, cz + 1, MAT_GALV_METAL)
}

// ---------------------------------------------------------------------------

export function stampBombay_civic(store: ChunkStore, layout: Layout, zone: BombayZone): void {
  const g = layout.groundY
  const lm = (kind: BombayLandmark['kind']): Rect => {
    const hit = zone.landmarks.find((l) => l.kind === kind)
    if (!hit) throw new Error(`T103 stampBombay_civic: landmark '${kind}' missing from zone`)
    return hit.rect
  }
  stampSkiInn(store, lm('skiInn'), g)
  stampMarket(store, lm('market'), g)
  stampFireStation(store, lm('fireStation'), g)
  stampLegion(store, lm('legion'), g)
  stampChurch(store, lm('church'), g)
  stampCommsMast(store, lm('commsMast'), g)
}
