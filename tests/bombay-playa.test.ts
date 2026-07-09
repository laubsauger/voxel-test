/**
 * T105 — Bombay Beach playa dressing (V18 discipline, V2 determinism).
 * Stamps terrain first (the playa module clips against the REAL surface),
 * then the playa dressing, and checks the postcard pieces: the isolated
 * swing set, the half-buried tilted ruins (welded, no floaters), the
 * shrinking piling row + derelict dock, the Lodestar, and the waterline
 * band (scum line at sea level).
 */
import { describe, expect, it } from 'vitest'
import { ChunkStore } from '../src/world/chunks'
import { generateLayout } from '../src/sim/gen/layout'
import { stampBombay_terrain } from '../src/sim/gen/bombay/terrain'
import { stampBombay_playa } from '../src/sim/gen/bombay/playa'
import {
  MAT_AIR,
  MAT_ART_PINK,
  MAT_ART_RED,
  MAT_ART_TEAL,
  MAT_ART_YELLOW,
  MAT_BONE_SHELL,
  MAT_CHAR,
  MAT_GALV_METAL,
  MAT_GLASS,
  MAT_METAL,
  MAT_PLASTER,
  MAT_RUST,
  MAT_WOOD,
} from '../src/sim/materials'

const SEED = 7

const layout = generateLayout(SEED)
const zone = layout.bombay!
const store = new ChunkStore()
stampBombay_terrain(store, layout, zone)
stampBombay_playa(store, layout, zone)
const g = layout.groundY
const CREST = g + zone.berm.h - 1 // berm crest walk level — the V18 reveal line

/** every material the playa dressing builds structures from (terrain mats —
 * crust/mud/bone/sand/dirt/concrete riprap — are deliberately NOT in here) */
const STRUCT = new Set([
  MAT_WOOD, MAT_GALV_METAL, MAT_PLASTER, MAT_RUST, MAT_CHAR, MAT_METAL, MAT_GLASS,
  MAT_ART_RED, MAT_ART_YELLOW, MAT_ART_TEAL, MAT_ART_PINK,
])

function topAt(x: number, z: number): number {
  for (let y = g + 60; y >= 4; y--) {
    if (store.getVoxel(x, y, z) !== MAT_AIR) return y
  }
  return -1
}

/** median of surface probes — robust local grade reference */
function surfRef(pts: [number, number][]): number {
  const t = pts.map(([x, z]) => topAt(x, z)).sort((a, b) => a - b)
  return t[t.length >> 1]
}

function art(kind: string): { x: number; z: number; len?: number; tiltDeg?: number } {
  const a = zone.art.find((e) => e.kind === kind)
  if (!a) throw new Error(`art entry ${kind} missing`)
  return a
}

describe('bombay playa dressing (T105, V18/V2)', () => {
  it('swing set: A-frames + 2 hanging char seats, ALONE (no structure within 40 vox), below the crest line', () => {
    // WHY: the swing is THE recession marker — it only lands if it stands
    // alone mid-playa; and V18 dies if anything here pokes above the berm
    // crest line the town-side reveal depends on.
    const a = art('swingSet')
    let galv = 0
    let topY = -1
    const seats: [number, number, number][] = []
    for (let x = a.x - 16; x <= a.x + 16; x++) {
      for (let z = a.z - 16; z <= a.z + 16; z++) {
        for (let y = g - 20; y <= g + 45; y++) {
          const m = store.getVoxel(x, y, z)
          if (m === MAT_GALV_METAL) {
            galv++
            topY = Math.max(topY, y)
          } else if (m === MAT_CHAR && store.getVoxel(x, y + 1, z) === MAT_RUST && store.getVoxel(x, y - 1, z) === MAT_AIR) {
            seats.push([x, y, z])
          }
        }
      }
    }
    const st = surfRef([[a.x + 70, a.z + 70], [a.x - 70, a.z - 70], [a.x + 70, a.z - 70]])
    expect(galv, 'galv A-frame mass').toBeGreaterThan(150)
    expect(topY - st, 'top bar height above the crust').toBeGreaterThanOrEqual(30)
    expect(topY, 'V18: swing stays below the crest walk level').toBeLessThanOrEqual(CREST)
    expect(seats.length, 'two char seats hanging on rust chains').toBe(2)
    for (const [, sy] of seats) {
      expect(sy - st, 'seat hangs ~8 above the ground').toBeGreaterThanOrEqual(6)
      expect(sy - st).toBeLessThanOrEqual(11)
    }
    // isolation ring: NOTHING structural within 40 vox of the swing footprint
    let intruders = 0
    for (let x = a.x - 56; x <= a.x + 56; x++) {
      for (let z = a.z - 56; z <= a.z + 56; z++) {
        if (Math.abs(x - a.x) <= 16 && Math.abs(z - a.z) <= 16) continue
        for (let y = g - 20; y <= g + 60; y++) {
          if (STRUCT.has(store.getVoxel(x, y, z))) intruders++
        }
      }
    }
    expect(intruders, 'no non-swing structure within 40 vox').toBe(0)
  })

  it('buried ruins: 5 shells welded into the playa, zero floaters, one visibly tilted, all under the crest', () => {
    // WHY: the collapse system now works at scale — one disconnected shell
    // voxel and the ruin shatters on the first damage tick; and the famous
    // 45° trailer must READ tilted, not just carry a tiltDeg field.
    const trailers = zone.art.filter((e) => e.kind === 'buriedTrailer')
    expect(trailers.length).toBe(5)
    const lode = art('lodestar')
    const swing = art('swingSet')
    const p = zone.playa
    const RUIN = new Set([MAT_GALV_METAL, MAT_PLASTER, MAT_RUST])

    // phase A: coarse-locate ruin voxels in the berm-foot band (the swing and
    // Lodestar also live in this x band — mask their boxes out)
    const hits: [number, number][] = [] // [z, x] coarse columns with ruin mats
    for (let z = p.z0; z <= p.z1; z += 4) {
      for (let x = p.x0; x <= p.x0 + 340; x += 4) {
        if (Math.abs(x - lode.x) <= 110 && Math.abs(z - lode.z) <= 110) continue
        if (Math.abs(x - swing.x) <= 60 && Math.abs(z - swing.z) <= 60) continue
        for (let y = g - 26; y <= g + 40; y++) {
          if (RUIN.has(store.getVoxel(x, y, z))) {
            hits.push([z, x])
            break
          }
        }
      }
    }
    // cluster by z gaps (the placer guarantees ≥60 vox of separation)
    hits.sort((a, b) => a[0] - b[0])
    const clusters: { z0: number; z1: number; x0: number; x1: number }[] = []
    for (const [z, x] of hits) {
      const c = clusters[clusters.length - 1]
      if (c && z - c.z1 <= 60) {
        c.z1 = Math.max(c.z1, z)
        c.x0 = Math.min(c.x0, x)
        c.x1 = Math.max(c.x1, x)
      } else {
        clusters.push({ z0: z, z1: z, x0: x, x1: x })
      }
    }
    expect(clusters.length, 'one shell per buriedTrailer entry').toBe(5)

    let tilted = 0
    for (const c of clusters) {
      const x0 = c.x0 - 8
      const x1 = c.x1 + 8
      const z0 = c.z0 - 8
      const z1 = c.z1 + 8
      // exact voxel set + ground-anchored flood (anchor = sits on terrain)
      const cells = new Map<string, [number, number, number]>()
      const anchors: string[] = []
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          for (let y = g - 26; y <= g + 40; y++) {
            if (!RUIN.has(store.getVoxel(x, y, z))) continue
            const k = `${x},${y},${z}`
            cells.set(k, [x, y, z])
            const below = store.getVoxel(x, y - 1, z)
            if (below !== MAT_AIR && !RUIN.has(below)) anchors.push(k)
          }
        }
      }
      expect(cells.size, `ruin at z≈${c.z0} is a real shell`).toBeGreaterThan(400)
      const reach = new Set<string>(anchors)
      const stack = anchors.slice()
      while (stack.length > 0) {
        const [cx, cy, cz] = cells.get(stack.pop()!)!
        for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
          const nk = `${cx + dx},${cy + dy},${cz + dz}`
          if (cells.has(nk) && !reach.has(nk)) {
            reach.add(nk)
            stack.push(nk)
          }
        }
      }
      expect(cells.size - reach.size, `floaters in ruin at z≈${c.z0}`).toBe(0)
      // V18: every ruin stays under the crest walk level
      let maxY = -1
      for (const [, [, y]] of cells) maxY = Math.max(maxY, y)
      expect(maxY, `ruin at z≈${c.z0} under the crest`).toBeLessThanOrEqual(CREST)
      // tilt read: occupied-column top profile shifts monotonically along an axis
      const prof = (axis: 0 | 1): number[] => {
        const tops = new Map<number, number>()
        for (const [, [x, y, z]] of cells) {
          const key = axis === 0 ? x : z
          tops.set(key, Math.max(tops.get(key) ?? -1, y))
        }
        return [...tops.entries()].sort((a, b) => a[0] - b[0]).map(([, y]) => y)
      }
      for (const axis of [0, 1] as const) {
        const t = prof(axis)
        if (t.length < 12) continue
        const head = t.slice(0, 6).reduce((a, b) => a + b, 0) / 6
        const tail = t.slice(-6).reduce((a, b) => a + b, 0) / 6
        if (Math.abs(tail - head) >= 12) {
          tilted++
          break
        }
      }
    }
    expect(tilted, 'at least the 45° entry reads visibly tilted').toBeGreaterThanOrEqual(1)
  })

  it('piling row: 10-14 bone-capped stumps shrinking seaward; dock deck partial (collapsed seaward)', () => {
    // WHY: vibe #9 — the pilings sell the vanished pier; the shrink toward
    // the water is the recession read. The dock must be derelict: deck over
    // the shore bays only, bare posts toward the water.
    const a = art('pilingRow')
    const len = a.len ?? 600
    // per-x stump columns inside the staggered row corridor
    const cols = new Map<number, { top: number; bone: boolean }>()
    for (let x = a.x - 4; x <= a.x + len + 6; x++) {
      for (let z = a.z - 10; z <= a.z + 10; z++) {
        for (let y = g - 24; y <= g + 20; y++) {
          if (store.getVoxel(x, y, z) !== MAT_WOOD) continue
          const cur = cols.get(x) ?? { top: -1, bone: false }
          if (y > cur.top) {
            cur.top = y
            cur.bone = store.getVoxel(x, y + 1, z) === MAT_BONE_SHELL
          }
          cols.set(x, cur)
        }
      }
    }
    // cluster contiguous x columns into stumps
    const xs = [...cols.keys()].sort((a2, b) => a2 - b)
    const stumps: { x: number; top: number; bone: boolean }[] = []
    for (const x of xs) {
      const c = cols.get(x)!
      const last = stumps[stumps.length - 1]
      if (last && x - last.x <= 2) {
        last.x = x
        last.top = Math.max(last.top, c.top + (c.bone ? 1 : 0))
        last.bone = last.bone || c.bone
      } else {
        stumps.push({ x, top: c.top + (c.bone ? 1 : 0), bone: c.bone })
      }
    }
    expect(stumps.length, 'stump count').toBeGreaterThanOrEqual(10)
    expect(stumps.length, 'stump count').toBeLessThanOrEqual(14)
    expect(stumps.filter((s) => s.bone).length / stumps.length, 'salt-rime caps').toBeGreaterThanOrEqual(0.8)
    const hOf = (s: { x: number; top: number }): number =>
      s.top - surfRef([[s.x, a.z + 14], [s.x, a.z + 17], [s.x, a.z - 14]])
    const h0 = hOf(stumps[0])
    const hN = hOf(stumps[stumps.length - 1])
    expect(h0, 'berm-foot stump height').toBeGreaterThanOrEqual(4)
    expect(h0).toBeLessThanOrEqual(8)
    expect(hN, 'seaward stump height').toBeGreaterThanOrEqual(1)
    expect(hN).toBeLessThanOrEqual(4)
    expect(h0 - hN, 'heights shrink seaward').toBeGreaterThanOrEqual(2)

    // dock: wood posts + galv deck over the shore bays, NONE past the collapse
    const d = art('dock')
    const dl = d.len ?? 140
    let posts = 0
    let deckNear = 0
    let deckFar = 0
    for (let x = d.x - 2; x <= d.x + dl + 4; x++) {
      for (let z = d.z - 8; z <= d.z + 8; z++) {
        for (let y = g - 26; y <= g + 12; y++) {
          const m = store.getVoxel(x, y, z)
          if (m === MAT_WOOD) posts++
          else if (m === MAT_GALV_METAL) {
            if (x <= d.x + Math.round(dl * 0.72)) deckNear++
            else deckFar++
          }
        }
      }
    }
    expect(posts, 'dock post frame').toBeGreaterThan(200)
    expect(deckNear, 'deck plates over the shore bays').toBeGreaterThan(400)
    expect(deckFar, 'seaward end is bare posts (half-collapsed)').toBe(0)
  })

  it('lodestar: ≥120 vox of rust-dominant nose-down plane + glass-flower art pops, above the crest', () => {
    // WHY: the Lodestar is the horizon landmark — the ONE piece that may
    // (must) poke above the berm crest; rust-dominant per the 80/15/5
    // palette, with the tiny sanctioned glass-flower chroma at the cockpit.
    const a = art('lodestar')
    let top = -1
    let rust = 0
    let galv = 0
    let pops = 0
    let glass = 0
    for (let x = a.x - 90; x <= a.x + 90; x++) {
      for (let z = a.z - 90; z <= a.z + 90; z++) {
        for (let y = g - 30; y <= g + 160; y++) {
          const m = store.getVoxel(x, y, z)
          if (m === MAT_RUST) rust++
          else if (m === MAT_GALV_METAL) galv++
          else if (m === MAT_ART_RED || m === MAT_ART_YELLOW || m === MAT_ART_TEAL || m === MAT_ART_PINK) pops++
          else if (m === MAT_GLASS) glass++
          if (STRUCT.has(m)) top = Math.max(top, y)
        }
      }
    }
    const st = surfRef([[a.x - 80, a.z - 80], [a.x + 80, a.z - 80], [a.x - 80, a.z + 80], [a.x + 80, a.z + 80], [a.x, a.z + 80]])
    expect(top - st, 'sculpture height above the crust').toBeGreaterThanOrEqual(120)
    expect(top - st).toBeLessThanOrEqual(155)
    expect(top, 'the horizon icon pokes above the crest — by design').toBeGreaterThan(CREST)
    expect(rust, 'rust fuselage mass').toBeGreaterThan(5000)
    expect(rust, 'rust dominant over galv wings').toBeGreaterThan(galv)
    expect(pops, 'glass-flower art-pop cluster').toBeGreaterThanOrEqual(3)
    expect(pops).toBeLessThanOrEqual(6)
    expect(glass, 'glass petals').toBeGreaterThanOrEqual(1)
  })

  it('waterline: salt-scum line traces the water edge at sea level; speckle densifies; beached hulk', () => {
    // WHY: research §1.4 — "foam lines of salt scum at the edge"; the shore
    // must read as remains (bone), not sand, and the scum line pins the
    // water edge visually AT the sea surface y.
    const sea = zone.sea
    let hit = 0
    let n = 0
    for (let z = zone.playa.z0 + 20; z <= zone.playa.z1 - 20; z += 97) {
      n++
      for (let x = sea.x0 - 3; x <= sea.x0 - 1; x++) {
        if (store.getVoxel(x, sea.y1, z) === MAT_BONE_SHELL && store.getVoxel(x, sea.y1 + 1, z) === MAT_AIR) {
          hit++
          break
        }
      }
    }
    expect(hit / n, 'scum line coverage at sea.y1').toBeGreaterThan(0.9)

    // speckle intensification: bone surface fraction near the water beats mid-playa
    const boneFrac = (x0: number, x1: number): number => {
      let bone = 0
      let tot = 0
      for (let z = zone.playa.z0 + 40; z <= zone.playa.z1 - 40; z += 53) {
        for (let x = x0; x <= x1; x += 7) {
          const m = store.getVoxel(x, topAt(x, z), z)
          if (!STRUCT.has(m)) {
            tot++
            if (m === MAT_BONE_SHELL) bone++
          }
        }
      }
      return bone / tot
    }
    const near = boneFrac(sea.x0 - 40, sea.x0 - 5)
    const mid = boneFrac(zone.playa.x0 + 260, zone.playa.x0 + 320)
    expect(near, 'bone speckle densifies at the waterline').toBeGreaterThan(mid + 0.03)

    // beached boat hulk: a listing wood/rust mass near the waterline (clear of the dock)
    const d = art('dock')
    let boat = 0
    let boatTop = -1
    for (let x = sea.x0 - 80; x <= sea.x0 - 40; x++) {
      for (let z = zone.playa.z0; z <= zone.playa.z1; z++) {
        if (Math.abs(z - d.z) <= 20) continue
        for (let y = g - 26; y <= g + 12; y++) {
          const m = store.getVoxel(x, y, z)
          if (m === MAT_WOOD || m === MAT_RUST) {
            boat++
            boatTop = Math.max(boatTop, y)
          }
        }
      }
    }
    expect(boat, 'boat hulk mass').toBeGreaterThan(400)
    expect(boatTop, 'V18: hulk stays under the crest').toBeLessThanOrEqual(CREST)
  })

  it('deterministic: double-stamp produces the identical playa write stream (V2)', () => {
    // WHY: MP lockstep + reload parity — any hash/order/probe leak in the
    // playa stamps desyncs every client on the first beach visit.
    const run = (): { h: number; n: number } => {
      const l = generateLayout(SEED)
      const z = l.bombay!
      const s = new ChunkStore()
      stampBombay_terrain(s, l, z)
      let h = 0
      let n = 0
      const mix = (v: number): void => {
        h = (Math.imul(h, 31) + (v | 0)) | 0
      }
      const origSet = s.setVoxel.bind(s)
      const origFill = s.fillBox.bind(s)
      s.setVoxel = (x, y, zz, m): void => {
        mix(x); mix(y); mix(zz); mix(m); n++
        origSet(x, y, zz, m)
      }
      s.fillBox = (x0, y0, z0, x1, y1, z1, m): void => {
        mix(x0); mix(y0); mix(z0); mix(x1); mix(y1); mix(z1); mix(m); n++
        origFill(x0, y0, z0, x1, y1, z1, m)
      }
      stampBombay_playa(s, l, z)
      return { h, n }
    }
    const a = run()
    const b = run()
    expect(a.n, 'playa actually stamps something').toBeGreaterThan(2000)
    expect(b.n).toBe(a.n)
    expect(b.h).toBe(a.h)
  })
})
