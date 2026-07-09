/**
 * T102 — Bombay Beach lot stamping (WP4). Stamps ONLY the lots module onto a
 * fresh store (streets/terrain are other WPs) and checks the condition
 * visual contract: every lot builds something, lived lots carry no char,
 * burned lots do, collapsed lots stay half-height, vacant husks are lighter
 * than lived-in lots, art-pop chroma stays an accent (V19 proxy), and the
 * stamp is deterministic (V2).
 */
import { describe, expect, it } from 'vitest'
import { ChunkStore, ChunkKind, CHUNK_COUNT } from '../src/world/chunks'
import { Fnv } from '../src/sim/hash'
import { generateLayout, type BombayLot, type Layout, type Rect } from '../src/sim/gen/layout'
import { stampBombay_lots } from '../src/sim/gen/bombay/lots'
import {
  MAT_AIR,
  MAT_ART_PINK,
  MAT_ART_RED,
  MAT_ART_TEAL,
  MAT_ART_YELLOW,
  MAT_CHAR,
  MAT_DIRT,
  MAT_OPERA_BLUE,
  MAT_SAND,
} from '../src/sim/materials'

const SEEDS = [7, 42]
const ART_IDS = new Set([MAT_OPERA_BLUE, MAT_ART_RED, MAT_ART_YELLOW, MAT_ART_TEAL, MAT_ART_PINK])

interface Stamped { store: ChunkStore; layout: Layout; lots: BombayLot[] }

function stamped(seed: number): Stamped {
  const layout = generateLayout(seed)
  const zone = layout.bombay
  if (!zone) throw new Error(`seed ${seed}: bombay zone missing`)
  const store = new ChunkStore()
  stampBombay_lots(store, layout, zone)
  return { store, layout, lots: zone.lots }
}

/** per-material voxel counts in the lot rect column band around ground */
function census(store: ChunkStore, rect: Rect, g: number): Map<number, number> {
  const counts = new Map<number, number>()
  for (let y = g - 2; y <= g + 45; y++) {
    for (let z = rect.z0; z <= rect.z1; z++) {
      for (let x = rect.x0; x <= rect.x1; x++) {
        const m = store.getVoxel(x, y, z)
        if (m === MAT_AIR) continue
        counts.set(m, (counts.get(m) ?? 0) + 1)
      }
    }
  }
  return counts
}

/** structure voxels = non-air minus ground dressing (sand pad/drift, dirt) */
function structureCount(counts: Map<number, number>): number {
  let n = 0
  for (const [m, c] of counts) {
    if (m === MAT_SAND || m === MAT_DIRT) continue
    n += c
  }
  return n
}

function maxHeight(store: ChunkStore, rect: Rect, g: number): number {
  for (let y = g + 45; y >= g - 2; y--) {
    for (let z = rect.z0; z <= rect.z1; z++) {
      for (let x = rect.x0; x <= rect.x1; x++) {
        if (store.getVoxel(x, y, z) !== MAT_AIR) return y
      }
    }
  }
  return g - 3
}

/** Fnv over all touched chunks — same shape stamper.test.ts hashes with */
function hashStore(s: ChunkStore): number {
  const h = new Fnv()
  for (let i = 0; i < CHUNK_COUNT; i++) {
    const c = s.chunkAt(i)
    if (c.kind === ChunkKind.Empty) continue
    h.u32(i).u8(c.kind)
    if (c.kind === ChunkKind.Uniform) h.u8(c.mat)
    else h.bytes(c.data!)
  }
  return h.value
}

describe('bombay lot stamping (T102, V19/V20)', () => {
  for (const seed of SEEDS) {
    describe(`seed ${seed}`, () => {
      const { store, layout, lots } = stamped(seed)
      const g = layout.groundY
      const lotCensus = lots.map((l) => census(store, l.rect, g))

      it('every lot has structure voxels in its rect', () => {
        // WHY: a lot with nothing stamped is a bald patch in the town grid —
        // the V20 condition mix only reads if every lot actually built.
        for (let i = 0; i < lots.length; i++) {
          expect(structureCount(lotCensus[i]), `lot ${i} (${lots[i].condition})`).toBeGreaterThan(50)
        }
      })

      it('lived lots carry no char; burned lots do', () => {
        // WHY: char is the burn signifier — a charred "lived-in" home or a
        // clean "burned" shell breaks the condition read at a glance.
        for (let i = 0; i < lots.length; i++) {
          const chars = lotCensus[i].get(MAT_CHAR) ?? 0
          if (lots[i].condition === 'lived') expect(chars, `lot ${i} lived`).toBe(0)
          if (lots[i].condition === 'burned') expect(chars, `lot ${i} burned`).toBeGreaterThan(100)
        }
      })

      it('collapsed lots stay at most half trailer height', () => {
        // WHY: "collapsed" must read as a rubble pile, not a standing shell —
        // trailer shells top out at g+28, so ruins stay ≤ g+14.
        for (let i = 0; i < lots.length; i++) {
          if (lots[i].condition !== 'collapsed') continue
          expect(maxHeight(store, lots[i].rect, g), `lot ${i} collapsed`).toBeLessThanOrEqual(g + 14)
        }
      })

      it('vacant husks average fewer structure voxels than lived-in lots', () => {
        // WHY: vacancy is told through subtraction — broken windows, open
        // door, no carport/fence/tank. If husks match lived mass, the
        // dressing never happened.
        const avg = (cond: string): number => {
          const idx = lots.map((l, i) => [l, i] as const).filter(([l]) => l.condition === cond)
          const total = idx.reduce((s, [, i]) => s + structureCount(lotCensus[i]), 0)
          return total / idx.length
        }
        expect(avg('vacant')).toBeLessThan(avg('lived'))
      })

      it('V19: art-pop chroma is <5% of non-air voxels across all lots', () => {
        // WHY: the 80/15/5 palette rule — art color is an accent (doors,
        // graffiti). A colorful town mass is the one unmistakable failure.
        let art = 0
        let total = 0
        for (const counts of lotCensus) {
          for (const [m, c] of counts) {
            total += c
            if (ART_IDS.has(m)) art += c
          }
        }
        expect(total).toBeGreaterThan(0)
        expect(art / total).toBeLessThan(0.05)
        expect(art, 'some accents exist (doors/graffiti)').toBeGreaterThan(0)
      })

      it('is deterministic: double-stamp produces identical voxels (V2)', () => {
        // WHY: the stamp runs on every lockstep peer + every reload — any
        // Math.random or iteration-order leak diverges the world hash.
        expect(hashStore(stamped(seed).store)).toBe(hashStore(stamped(seed).store))
      })
    })
  }
})
