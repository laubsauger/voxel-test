/**
 * T101 — Bombay Beach street grid stamper tests (WP3).
 * Stamps the streets module directly onto a synthetic flat (and terraced)
 * ground slab — the WP2 terrain module may still be a stub, and T101's
 * height sampling must tolerate flat ground (research §3 WP3).
 */
import { describe, expect, it } from 'vitest'
import { ChunkStore, ChunkKind, CHUNK_COUNT } from '../src/world/chunks'
import { Fnv } from '../src/sim/hash'
import {
  generateLayout,
  GROUND_Y,
  BOMBAY_STREET_HALF,
  type BombayStreet,
  type BombayZone,
  type Layout,
} from '../src/sim/gen/layout'
import { stampBombay_streets } from '../src/sim/gen/bombay/streets'
import {
  MAT_ASPHALT,
  MAT_CRACKED_ASPHALT,
  MAT_DIRT,
  MAT_GRASS,
  MAT_PAINT,
  MAT_PLAYA_MUD,
  MAT_SAND,
} from '../src/sim/materials'

const SEED = 7
const G = GROUND_Y

/** Fnv over all touched chunks — same shape stamper.test.ts uses */
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

interface World { store: ChunkStore; layout: Layout; zone: BombayZone }

/** flat slab like the global stampTerrain (dirt body + grass top), zone-sized.
 * terraceAt: optional x boundaries where the top drops 1 vox each (seaward
 * fall stand-in — the WP2 agent steps the real slope the same way). */
function buildWorld(terraceAt?: [number, number], stamp = true): World {
  const layout = generateLayout(SEED)
  const zone = layout.bombay
  if (!zone) throw new Error('seed 7: bombay zone missing')
  const store = new ChunkStore()
  const R = { x0: zone.town.x0 - 60, z0: zone.town.z0 - 60, x1: zone.town.x1 + 60, z1: zone.town.z1 + 60 }
  const bands: { x0: number; x1: number; top: number }[] = terraceAt
    ? [
        { x0: R.x0, x1: terraceAt[0] - 1, top: G - 1 },
        { x0: terraceAt[0], x1: terraceAt[1] - 1, top: G - 2 },
        { x0: terraceAt[1], x1: R.x1, top: G - 3 },
      ]
    : [{ x0: R.x0, x1: R.x1, top: G - 1 }]
  for (const b of bands) {
    store.fillBox(b.x0, 0, R.z0, b.x1, b.top - 2, R.z1, MAT_DIRT)
    store.fillBox(b.x0, b.top - 1, R.z0, b.x1, b.top, R.z1, MAT_GRASS)
  }
  if (stamp) stampBombay_streets(store, layout, zone)
  return { store, layout, zone }
}

// shared flat-ground stamp: built once, read-only across the content tests
let flatCache: World | null = null
function flat(): World {
  if (!flatCache) flatCache = buildWorld()
  return flatCache
}

/** does mat appear anywhere in the y band at (x,z)? */
function hasMat(store: ChunkStore, x: number, z: number, mat: number, y0 = G - 6, y1 = G + 1): boolean {
  for (let y = y0; y <= y1; y++) if (store.getVoxel(x, y, z) === mat) return true
  return false
}

/** stamped packed-dirt surface at (x,z)? Probes ONLY the slab's grass band
 * (G-2..G-1) — the slab's own dirt body below would match trivially. */
function hasDirtSurface(store: ChunkStore, x: number, z: number): boolean {
  return hasMat(store, x, z, MAT_DIRT, G - 2, G - 1)
}

function streetByName(zone: BombayZone, name: string): BombayStreet {
  const st = zone.streets.find((s) => s.name === name)
  if (!st) throw new Error(`street ${name} missing`)
  return st
}

describe('bombay street grid stamper (T101, V2)', () => {
  it('deterministic double-stamp: two fresh stamps hash identically (and stamp something)', () => {
    // WHY: world gen is MP-lockstep state — any wall-clock/order leak in the
    // street stamp desyncs peers on tick 0.
    const bare = hashStore(buildWorld(undefined, false).store)
    const a = hashStore(flat().store)
    const b = hashStore(buildWorld().store)
    expect(a).toBe(b)
    expect(a).not.toBe(bare) // streets actually wrote voxels
  })

  it('every lot fronts a stamped street surface of its street\'s material within 30 vox', () => {
    // WHY: WP3 accept — "every lot reachable by road". A lot whose fronting
    // street never materialized (or came out the wrong surface) breaks WP4.
    const { store, zone } = flat()
    for (const lot of zone.lots) {
      const st = streetByName(zone, lot.face.split('/')[0])
      const dirt = st.kind === 'dirt'
      const [sx0, sx1] =
        lot.front === 'x-' ? [lot.rect.x0 - 30, lot.rect.x0 - 1] : [lot.rect.x1 + 1, lot.rect.x1 + 30]
      let found = false
      outer: for (let x = sx0; x <= sx1; x++) {
        for (let z = lot.rect.z0; z <= lot.rect.z1; z++) {
          if (dirt ? hasDirtSurface(store, x, z) : hasMat(store, x, z, MAT_CRACKED_ASPHALT)) {
            found = true
            break outer
          }
        }
      }
      expect(found, `lot @${lot.rect.x0},${lot.rect.z0} (${lot.face}) reaches ${st.kind}`).toBe(true)
    }
  })

  it('2nd Street and both alleys are dirt two-tracks — no cracked asphalt mid-block', () => {
    // WHY: research §1.1 — 2nd St is the untagged dirt street; paving it (or
    // the alleys) kills the "half-abandoned grid" read.
    const { store, zone } = flat()
    const second = streetByName(zone, '2nd Street')
    expect(second.kind).toBe('dirt')
    const avenues = zone.streets.filter((s) => s.axis === 'x')
    for (const st of [second, ...zone.alleys]) {
      // sample mid-block rows (>45 vox from every avenue centerline so the
      // avenue asphalt legitimately crossing it doesn't count)
      let rows = 0
      for (let p = st.a0; p <= st.a1; p += 7) {
        if (avenues.some((a) => Math.abs(p - a.center) <= 45)) continue
        rows++
        let dirt = false
        for (let o = -16; o <= 16; o++) {
          const x = st.axis === 'x' ? p : st.center + o
          const z = st.axis === 'x' ? st.center + o : p
          expect(hasMat(store, x, z, MAT_CRACKED_ASPHALT), `${st.name} cracked-free @${p}`).toBe(false)
          if (hasDirtSurface(store, x, z)) dirt = true
        }
        expect(dirt, `${st.name} has dirt surface @${p}`).toBe(true)
      }
      expect(rows).toBeGreaterThan(50) // the sweep actually sampled the run
    }
  })

  it('no clean MAT_ASPHALT (and no lane paint) anywhere in the street bands', () => {
    // WHY: WP3 accept — "no street renders as clean city asphalt"; the whole
    // zone reads sun-rotted, and markings would instantly read city-grid.
    const { store, zone } = flat()
    const all = [...zone.streets, ...zone.alleys, ...zone.stubs, zone.spur]
    for (const st of all) {
      for (let p = st.a0; p <= st.a1; p += 3) {
        const c = st.center + (st.bend && p >= st.bend.at ? st.bend.offset : 0)
        for (let o = -40; o <= 40; o += 2) {
          const x = st.axis === 'x' ? p : c + o
          const z = st.axis === 'x' ? c + o : p
          expect(hasMat(store, x, z, MAT_ASPHALT), `${st.name} clean asphalt @${p},${o}`).toBe(false)
          expect(hasMat(store, x, z, MAT_PAINT), `${st.name} lane paint @${p},${o}`).toBe(false)
        }
      }
    }
  })

  it('Ave-A spur: continuous cracked asphalt from the world frame road to the grid', () => {
    // WHY: exactly ONE junction with the outside world — if the spur gaps,
    // the town is unreachable; if the frame road doesn't meet the zone edge,
    // the "entrance" never reads.
    const { store, layout, zone } = flat()
    const spur = zone.spur
    expect(spur.kind).toBe('asphalt-cracked')
    expect(spur.a0).toBe(zone.town.z0) // starts at the zone edge
    // the frame road north of the zone actually reaches that edge
    const frame = layout.roads
      .filter((r) => r.axis === 'x' && r.asphalt.z1 < zone.town.z0)
      .sort((a, b) => b.asphalt.z1 - a.asphalt.z1)[0]
    expect(frame, 'a world road exists north of the zone').toBeDefined()
    const edge = Math.max(frame.asphalt.z1, ...frame.sidewalks.map((s) => s.z1))
    expect(zone.town.z0 - edge).toBeLessThanOrEqual(2)
    // every row of the run carries cracked asphalt (potholes never sever it)
    for (let z = spur.a0; z <= spur.a1; z += 2) {
      let hit = false
      for (let o = -BOMBAY_STREET_HALF; o <= BOMBAY_STREET_HALF && !hit; o++) {
        hit = hasMat(store, spur.center + o, z, MAT_CRACKED_ASPHALT)
      }
      expect(hit, `spur row z=${z}`).toBe(true)
    }
  })

  it('5th Street honors its bend: bed follows center+offset past the kink', () => {
    // WHY: 5th is THE bent street (research §1.1) — losing the bend data on
    // the way to voxels flattens the town's one distinctive street line.
    const { store, zone } = flat()
    const fifth = streetByName(zone, '5th Street')
    const bend = fifth.bend
    if (!bend) throw new Error('5th Street lost its bend')
    const zPast = Math.min(fifth.a1, bend.at + 150)
    const zBefore = Math.max(fifth.a0, bend.at - 300)
    // past the kink the bed reaches the offset centerline + its far edge...
    const farEdge = fifth.center + bend.offset + BOMBAY_STREET_HALF - 2
    expect(hasMat(store, fifth.center + bend.offset, zPast, MAT_CRACKED_ASPHALT)).toBe(true)
    expect(hasMat(store, farEdge, zPast, MAT_CRACKED_ASPHALT)).toBe(true)
    // ...but before the ramp the street is still on the straight alignment
    // (the far edge is beyond bed+verge there: offset 40 > half 25 + verge 10)
    expect(hasMat(store, farEdge, zBefore, MAT_CRACKED_ASPHALT)).toBe(false)
    expect(hasMat(store, fifth.center, zBefore, MAT_CRACKED_ASPHALT)).toBe(true)
  })

  it('cracked asphalt carries ~8-12% mud/sand patches punched through the bed', () => {
    // WHY: the patch rate IS the "sand-blown, half-maintained" read — 0%
    // reads city-clean, 30%+ reads like no street at all.
    const { store, zone } = flat()
    const aveA = streetByName(zone, 'Avenue A')
    let bed = 0
    let patch = 0
    for (let x = aveA.a0; x <= aveA.a1; x++) {
      for (let o = -BOMBAY_STREET_HALF; o <= BOMBAY_STREET_HALF; o++) {
        const m = store.getVoxel(x, G - 2, aveA.center + o) // bed top = grade-1 on the flat slab
        if (m === MAT_CRACKED_ASPHALT) bed++
        else if (m === MAT_PLAYA_MUD || m === MAT_SAND) patch++
      }
    }
    const frac = patch / (bed + patch)
    expect(bed + patch).toBeGreaterThan(50000)
    expect(frac, `patch fraction ${frac}`).toBeGreaterThan(0.04)
    expect(frac, `patch fraction ${frac}`).toBeLessThan(0.2)
  })

  it('dead-end stubs fade out raggedly instead of ending in a hard rectangle', () => {
    // WHY: WP3 — the stubs peter into the desert toward the berm; a crisp
    // rectangular butt-end reads CAD, not decay.
    const { store, zone } = flat()
    expect(zone.stubs.length).toBe(3)
    for (const stub of zone.stubs) {
      const count = (p0: number, p1: number): number => {
        let n = 0
        for (let p = p0; p <= p1; p++) {
          for (let o = -16; o <= 16; o++) {
            if (hasDirtSurface(store, p, stub.center + o)) n++
          }
        }
        return n
      }
      // head window sits just past 5th Street's asphalt+verge band (extent
      // 35) — inside it the avenue pavement legitimately owns the ground
      const head = count(stub.a0 + 38, stub.a0 + 50) // solid two-track off 5th
      const tail = count(stub.a1 - 12, stub.a1) // raggedy end
      expect(head, `${stub.name} head coverage`).toBeGreaterThan(200)
      expect(tail, `${stub.name} tail thins out`).toBeLessThan(head * 0.5)
    }
  })

  it('streets follow stepped terrain: bed rides each terrace, never floats or buries', () => {
    // WHY: WP2 steps the 20-30 vox seaward fall in 1-vox terraces — a street
    // stamped at flat groundY would float over the low terraces and bury
    // into the high ones. Must also hold when terrain is still a stub (the
    // flat tests above cover that half).
    const layoutProbe = generateLayout(SEED)
    const zoneProbe = layoutProbe.bombay
    if (!zoneProbe) throw new Error('seed 7: bombay zone missing')
    const ns = zoneProbe.streets.filter((s) => s.axis === 'z').map((s) => s.center)
    const t1 = ((ns[1] + ns[2]) >> 1) + 60 // terrace edges clear of any N-S street band
    const t2 = ((ns[2] + ns[3]) >> 1) + 60
    const { store, zone } = buildWorld([t1, t2])
    const aveA = streetByName(zone, 'Avenue A')
    const cases: [number, number][] = [
      [ns[0] + 60, G - 1], // west terrace top
      [((t1 + t2) >> 1) + 40, G - 2], // middle terrace, clear of 3rd St
      [ns[4] - 60, G - 3], // east (seaward) terrace
    ]
    for (const [x, top] of cases) {
      let atGrade = false
      let floating = false
      for (let o = -BOMBAY_STREET_HALF; o <= BOMBAY_STREET_HALF; o++) {
        const z = aveA.center + o
        if (store.getVoxel(x, top - 1, z) === MAT_CRACKED_ASPHALT) atGrade = true
        for (let y = top + 1; y <= top + 4; y++) {
          if (store.getVoxel(x, y, z) === MAT_CRACKED_ASPHALT) floating = true
        }
      }
      expect(atGrade, `bed top at terrace grade-1 @x=${x}`).toBe(true)
      expect(floating, `no bed above terrace grade @x=${x}`).toBe(false)
    }
  })
})
