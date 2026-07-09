/**
 * T103 — Bombay civic strip stamp tests (V2 determinism, V19-adjacent).
 * Stamps the civic module alone into a fresh store from the seed-7 layout
 * contract and verifies the WP5 acceptance shape: a walkable Ski Inn, facade
 * lettering, a street-side pole sign, and door openings on every shell.
 */
import { describe, expect, it } from 'vitest'
import { ChunkStore } from '../src/world/chunks'
import { generateLayout, type BombayZone, type Layout, type Rect } from '../src/sim/gen/layout'
import { SKI, stampBombay_civic } from '../src/sim/gen/bombay/civic'
import {
  MAT_AIR,
  MAT_CHAR,
  MAT_GALV_METAL,
  MAT_METAL,
  MAT_WOOD,
} from '../src/sim/materials'

const layout: Layout = generateLayout(7)
const zone: BombayZone = (() => {
  if (!layout.bombay) throw new Error('seed 7: bombay zone missing')
  return layout.bombay
})()
const g = layout.groundY

function stamped(): ChunkStore {
  const store = new ChunkStore()
  stampBombay_civic(store, layout, zone)
  return store
}

const store = stamped()

function rect(kind: string): Rect {
  const hit = zone.landmarks.find((l) => l.kind === kind)
  if (!hit) throw new Error(`landmark ${kind} missing`)
  return hit.rect
}

function countMat(s: ChunkStore, box: Rect, y0: number, y1: number, mat: number): number {
  let n = 0
  for (let y = y0; y <= y1; y++) {
    for (let z = box.z0; z <= box.z1; z++) {
      for (let x = box.x0; x <= box.x1; x++) {
        if (s.getVoxel(x, y, z) === mat) n++
      }
    }
  }
  return n
}

function countSolid(s: ChunkStore, box: Rect, y0: number, y1: number): number {
  let n = 0
  for (let y = y0; y <= y1; y++) {
    for (let z = box.z0; z <= box.z1; z++) {
      for (let x = box.x0; x <= box.x1; x++) {
        if (s.getVoxel(x, y, z) !== MAT_AIR) n++
      }
    }
  }
  return n
}

/** FNV-1a over a landmark neighborhood — the determinism fingerprint */
function regionHash(s: ChunkStore, box: Rect, y0: number, y1: number): number {
  let h = 0x811c9dc5
  for (let y = y0; y <= y1; y++) {
    for (let z = box.z0 - 16; z <= box.z1 + 16; z++) {
      for (let x = box.x0 - 16; x <= box.x1 + 16; x++) {
        h = Math.imul(h ^ s.getVoxel(x, y, z), 0x01000193)
      }
    }
  }
  return h >>> 0
}

describe('bombay civic strip (T103, V2/V19)', () => {
  it('Ski Inn: walkable air path ≥2 wide, door → around the bar → back-bar', () => {
    // WHY: WP5 acceptance is literally "player can walk in the Ski Inn door,
    // around the bar, back out" — these bands are that path, and each is
    // wider than 2 voxels so a capsule fits with margin.
    const r = rect('skiInn')
    // through the carved door itself (both wall layers)
    for (let z = r.z0 + SKI.aisle.z0; z <= r.z0 + SKI.aisle.z1; z++) {
      for (let y = g + 2; y <= g + 18; y++) {
        expect(store.getVoxel(r.x0, y, z), `door @z${z},y${y}`).toBe(MAT_AIR)
        expect(store.getVoxel(r.x0 + 1, y, z)).toBe(MAT_AIR)
      }
    }
    for (const band of [SKI.aisle, SKI.barFrontBand, SKI.northPass, SKI.backBar]) {
      expect(band.x1 - band.x0 + 1).toBeGreaterThanOrEqual(2)
      expect(band.z1 - band.z0 + 1).toBeGreaterThanOrEqual(2)
      for (let x = r.x0 + band.x0; x <= r.x0 + band.x1; x++) {
        for (let z = r.z0 + band.z0; z <= r.z0 + band.z1; z++) {
          for (let y = g + 1; y <= g + 14; y++) {
            expect(store.getVoxel(x, y, z), `band air @${x},${y},${z}`).toBe(MAT_AIR)
          }
        }
      }
    }
    // and the bar actually exists to walk around (wood L-counter)
    expect(store.getVoxel(r.x0 + 63, g + 5, r.z0 + 30)).toBe(MAT_WOOD)
    expect(store.getVoxel(r.x0 + 70, g + 5, r.z0 + 53)).toBe(MAT_WOOD) // L-leg
  })

  it('Ski Inn: SKI INN lettering voxels above the door on the front face', () => {
    // WHY: the sign must read from the entrance spur — char voxels on the
    // outer wall plane, in the band between door top and trim. 76 = the
    // exact glyph population of 'SKI INN' in the 4×5 font.
    const r = rect('skiInn')
    const band: Rect = { x0: r.x0, z0: r.z0 + 20, x1: r.x0, z1: r.z0 + 60 }
    expect(countMat(store, band, g + SKI.letterY0, g + SKI.letterY1, MAT_CHAR)).toBe(76)
    // strictly above the door top — never carved away by the opening
    expect(g + SKI.letterY0).toBeGreaterThan(g + 21)
    // the wall below the letter band stays clean (no stray char smear)
    expect(countMat(store, band, g + 2, g + 10, MAT_CHAR)).toBe(0)
  })

  it('Ski Inn: pole sign stands street-side of the facade', () => {
    const r = rect('skiInn')
    const box: Rect = { x0: r.x0 - 15, z0: r.z0, x1: r.x0 - 2, z1: r.z0 + 10 }
    // metal pole (2×2, ~20 tall)
    expect(countMat(store, box, g, g + 13, MAT_METAL)).toBeGreaterThanOrEqual(40)
    // sign box up top: solid panel voxels at head height for a driver
    expect(countSolid(store, box, g + 15, g + 20)).toBeGreaterThanOrEqual(60)
  })

  it('every civic landmark: structure in its rect + door-height opening on the front', () => {
    // WHY: §1.5 placement is the whole point — each building must exist
    // where the layout contract says, and shells without a way in are
    // scenery, not places (WP5: "shells with door openings").
    for (const kind of ['skiInn', 'market', 'fireStation', 'legion', 'church'] as const) {
      const r = rect(kind)
      expect(countSolid(store, r, g + 1, g + 20), `${kind} structure`).toBeGreaterThan(200)
      // find a door: an all-air column pair through the west (street) wall
      let door = false
      for (let z = r.z0 + 2; z <= r.z1 - 2 && !door; z++) {
        let open = true
        for (let y = g + 2; y <= g + 18 && open; y++) {
          if (store.getVoxel(r.x0, y, z) !== MAT_AIR || store.getVoxel(r.x0 + 1, y, z) !== MAT_AIR) open = false
        }
        door = open
      }
      expect(door, `${kind} front door opening`).toBe(true)
    }
    // comms mast: no door — a 30-vox tapering metal mast + 3 galv dish boxes
    const m = rect('commsMast')
    expect(store.getVoxel(m.x0 + 10, g + 29, m.z0 + 10)).toBe(MAT_METAL) // top of the 1×1 tip
    expect(store.getVoxel(m.x0 + 10, g + 30, m.z0 + 10)).toBe(MAT_AIR) // exactly 30 tall
    expect(countMat(store, m, g, g + 20, MAT_GALV_METAL)).toBeGreaterThanOrEqual(100) // dish boxes
  })

  it('church carries the wood cross at the street gable', () => {
    const c = rect('church')
    const box: Rect = { x0: c.x0 - 2, z0: c.z0 + 20, x1: c.x0, z1: c.z0 + 40 }
    expect(countMat(store, box, g + 26, g + 35, MAT_WOOD)).toBeGreaterThanOrEqual(14)
  })

  it('deterministic + idempotent: fresh re-stamp and double-stamp both match (V2)', () => {
    // WHY: lockstep MP — every peer stamps from the same layout; any
    // hidden-state or read-modify dependence desyncs worlds. Double-stamp
    // guards idempotence: re-running the module must not smear.
    const civic = ['skiInn', 'market', 'fireStation', 'legion', 'church', 'commsMast']
    const other = stamped()
    const first = civic.map((k) => regionHash(store, rect(k), g - 2, g + 45))
    expect(civic.map((k) => regionHash(other, rect(k), g - 2, g + 45))).toEqual(first)
    stampBombay_civic(other, layout, zone) // second stamp on the same store
    expect(civic.map((k) => regionHash(other, rect(k), g - 2, g + 45))).toEqual(first)
  })
})
