/**
 * T98 — Bombay Beach layout contract tests (V2 determinism, V20 lot mix).
 * Layout-only: stamping is T100+; this locks the declarative zone shape the
 * downstream stampers build against.
 */
import { describe, expect, it } from 'vitest'
import { generateLayout, makeBombay, GROUND_Y, type BombayZone, type Rect } from '../src/sim/gen/layout'

const SEEDS = [7, 42, 1337]

function zone(seed: number): BombayZone {
  const b = generateLayout(seed).bombay
  if (!b) throw new Error(`seed ${seed}: bombay zone missing`)
  return b
}

function contains(outer: Rect, inner: Rect): boolean {
  return inner.x0 >= outer.x0 && inner.x1 <= outer.x1 && inner.z0 >= outer.z0 && inner.z1 <= outer.z1
}

describe('bombay beach layout contract (T98, V2/V20)', () => {
  it('is deterministic: same seed → identical zone (JSON equality)', () => {
    // WHY: the zone must survive reloads + MP lockstep — any wall-clock or
    // iteration-order leak shows up as a JSON diff.
    for (const seed of SEEDS) {
      expect(JSON.stringify(zone(seed))).toBe(JSON.stringify(zone(seed)))
      const districts = generateLayout(seed).districts
      expect(JSON.stringify(makeBombay(seed, districts))).toBe(JSON.stringify(makeBombay(seed, districts)))
    }
  })

  it('emits nothing when its districts do not exist (defensive)', () => {
    const districts = generateLayout(7).districts.filter((d) => d.kind !== 'bombay' && d.kind !== 'bombayBeach')
    expect(makeBombay(7, districts)).toBeNull()
    expect(makeBombay(7, [])).toBeNull()
  })

  it('V20: lot condition mix 35/40/25 ±5%, ruins = burned+collapsed', () => {
    // WHY: the town reads wrong if it's all husks or all tidy — the census
    // mix (35.8% occupied) is the ground truth the zone is built around.
    for (const seed of SEEDS) {
      const z = zone(seed)
      const n = z.lots.length
      expect(n, `seed ${seed}: structure count in the §2.3 band`).toBeGreaterThanOrEqual(60)
      expect(n).toBeLessThanOrEqual(80)
      const count = (c: string): number => z.lots.filter((l) => l.condition === c).length
      const lived = count('lived') / n
      const vacant = count('vacant') / n
      const ruin = (count('burned') + count('collapsed')) / n
      expect(Math.abs(lived - 0.35), `seed ${seed}: lived ${lived}`).toBeLessThanOrEqual(0.05)
      expect(Math.abs(vacant - 0.4), `seed ${seed}: vacant ${vacant}`).toBeLessThanOrEqual(0.05)
      expect(Math.abs(ruin - 0.25), `seed ${seed}: ruin ${ruin}`).toBeLessThanOrEqual(0.05)
      expect(count('burned'), `seed ${seed}: some burned`).toBeGreaterThan(0)
      expect(count('collapsed'), `seed ${seed}: some collapsed`).toBeGreaterThan(0)
    }
  })

  it('V20: interleaved — no street face runs >3 adjacent same-condition lots', () => {
    // WHY: research vibe check #7 — husks must ALTERNATE with lived-in lots
    // on the same street; zoning them into clumps kills the place.
    for (const seed of SEEDS) {
      const z = zone(seed)
      const faces = new Map<string, typeof z.lots>()
      for (const l of z.lots) {
        const f = faces.get(l.face) ?? []
        f.push(l)
        faces.set(l.face, f)
      }
      expect(faces.size).toBe(8) // 2 faces per block × 4 blocks
      for (const [face, lots] of faces) {
        const seq = [...lots].sort((a, b) => a.rect.z0 - b.rect.z0)
        let run = 1
        for (let i = 1; i < seq.length; i++) {
          run = seq[i].condition === seq[i - 1].condition ? run + 1 : 1
          expect(run, `seed ${seed}: ${face} runs ${run}× ${seq[i].condition}`).toBeLessThanOrEqual(3)
        }
      }
    }
  })

  it('street naming quirk: E St exists, Avenue E does not; 2nd St + alleys dirt', () => {
    const z = zone(42)
    const names = z.streets.map((s) => s.name)
    expect(z.streets.length).toBe(11) // 5 streets + 6 avenues
    expect(names).toContain('E St')
    expect(names).not.toContain('Avenue E')
    expect(names).toContain('Aisle of Palms')
    for (const a of ['Avenue A', 'Avenue B', 'Avenue C', 'Avenue F']) expect(names).toContain(a)
    for (const s of ['1st Street', '2nd Street', '3rd Street', '4th Street', '5th Street']) expect(names).toContain(s)
    // 2nd Street is the untagged dirt one; every other named street is
    // cracked asphalt (research §1.1)
    for (const s of z.streets) {
      expect(s.kind).toBe(s.name === '2nd Street' ? 'dirt' : 'asphalt-cracked')
    }
    expect(z.alleys.length).toBe(2)
    for (const a of z.alleys) expect(a.kind).toBe('dirt')
    // alleys sit mid-block between 1st-2nd and 2nd-3rd
    const stC = (name: string): number => z.streets.find((s) => s.name === name)!.center
    expect(z.alleys[0].center).toBe((stC('1st Street') + stC('2nd Street')) >> 1)
    expect(z.alleys[1].center).toBe((stC('2nd Street') + stC('3rd Street')) >> 1)
    // 5th is the only bent street
    for (const s of z.streets) {
      if (s.name === '5th Street') expect(s.bend).toBeDefined()
      else expect(s.bend).toBeUndefined()
    }
    // the spur is the one outside junction: reaches the zone's north edge
    expect(z.spur.a0).toBe(z.town.z0)
    expect(z.spur.center).toBe(stC('1st Street'))
  })

  it('landmarks: all 10 present exactly once, each inside the town rect', () => {
    const kinds = [
      'skiInn', 'market', 'fireStation', 'legion', 'church',
      'commsMast', 'driveIn', 'operaHouse', 'tvWall', 'daVinciFish',
    ]
    for (const seed of SEEDS) {
      const z = zone(seed)
      for (const k of kinds) {
        const hits = z.landmarks.filter((l) => l.kind === k)
        expect(hits.length, `seed ${seed}: ${k}`).toBe(1)
        expect(contains(z.town, hits[0].rect), `seed ${seed}: ${k} inside town`).toBe(true)
      }
      // landmarks never share ground with a lot (lots are dropped under them)
      for (const l of z.landmarks) {
        for (const lot of z.lots) {
          const o =
            l.rect.x0 <= lot.rect.x1 && l.rect.x1 >= lot.rect.x0 &&
            l.rect.z0 <= lot.rect.z1 && l.rect.z1 >= lot.rect.z0
          expect(o, `seed ${seed}: ${l.kind} overlaps a lot`).toBe(false)
        }
      }
    }
  })

  it('berm east of town, inside the shore column, spec dims, 3 ramp cuts', () => {
    // WHY: the berm reveal is THE level-design beat — from any town street
    // the water must be hidden behind a strip strictly east of the grid.
    const z = zone(7)
    expect(z.berm.strip.x0).toBeGreaterThan(z.town.x1)
    expect(contains(z.shore, z.berm.strip)).toBe(true)
    expect(z.berm.h).toBe(40)
    expect(z.berm.crestW).toBe(50)
    expect(z.berm.baseW).toBe(140)
    expect(z.berm.ramps.length).toBe(3)
    const names = z.berm.ramps.map((r) => r.name)
    expect(names).toContain('Avenue C')
    expect(names).toContain('E St')
    // E St ramp = the widest beach-access crossing
    const eSt = z.berm.ramps.find((r) => r.name === 'E St')!
    for (const r of z.berm.ramps) expect(eSt.w).toBeGreaterThanOrEqual(r.w)
    // crest polyline stays on the strip
    for (const p of z.berm.crest) {
      expect(p.x).toBeGreaterThanOrEqual(z.berm.strip.x0)
      expect(p.x).toBeLessThanOrEqual(z.berm.strip.x1)
    }
    // shore stack: berm → playa → sea, water surface 10-20 vox below grade
    expect(z.playa.x0).toBe(z.berm.strip.x1 + 1)
    expect(z.sea.x0).toBe(z.playa.x1 + 1)
    expect(z.playa.x1 - z.playa.x0 + 1).toBeGreaterThanOrEqual(600)
    expect(z.playa.x1 - z.playa.x0 + 1).toBeLessThanOrEqual(800)
    expect(z.sea.y1).toBeGreaterThanOrEqual(GROUND_Y - 20)
    expect(z.sea.y1).toBeLessThanOrEqual(GROUND_Y - 10)
  })

  it('stubs: B/C/E-St dead-end east past 5th, dirt, E St longest', () => {
    const z = zone(1337)
    const fifth = z.streets.find((s) => s.name === '5th Street')!
    expect(z.stubs.length).toBe(3)
    const stub = (name: string) => z.stubs.find((s) => s.name.startsWith(name))!
    for (const s of z.stubs) {
      expect(s.kind).toBe('dirt')
      expect(s.axis).toBe('x')
      expect(s.a0).toBe(fifth.center) // east of 5th
      expect(s.a1).toBeGreaterThan(s.a0)
      expect(s.a1).toBeLessThanOrEqual(z.town.x1) // dead-end short of the berm
      expect(s.a1).toBeLessThan(z.berm.strip.x0)
    }
    const len = (s: { a0: number; a1: number }): number => s.a1 - s.a0
    expect(len(stub('E St'))).toBeGreaterThan(len(stub('Avenue B')))
    expect(len(stub('E St'))).toBeGreaterThan(len(stub('Avenue C')))
    // stubs continue the avenues they belong to
    const ave = (name: string): number => z.streets.find((s) => s.name === name)!.center
    expect(stub('Avenue B').center).toBe(ave('Avenue B'))
    expect(stub('Avenue C').center).toBe(ave('Avenue C'))
    expect(stub('E St').center).toBe(ave('E St'))
  })

  it('beach art: full §1.5 list on the shore, one trailer at the famous 45°', () => {
    for (const seed of SEEDS) {
      const z = zone(seed)
      for (const k of ['swingSet', 'lodestar', 'pilingRow', 'dock', 'textSign', 'star']) {
        expect(z.art.filter((a) => a.kind === k).length, `seed ${seed}: ${k}`).toBe(1)
      }
      const buried = z.art.filter((a) => a.kind === 'buriedTrailer')
      expect(buried.length, `seed ${seed}: buried trailers`).toBeGreaterThanOrEqual(5)
      expect(buried.some((a) => a.tiltDeg === 45), `seed ${seed}: the 45° trailer`).toBe(true)
      for (const a of z.art) {
        expect(a.x, `seed ${seed}: ${a.kind} on the shore`).toBeGreaterThan(z.town.x1)
        expect(a.x).toBeLessThanOrEqual(z.shore.x1)
        expect(a.z).toBeGreaterThanOrEqual(z.shore.z0)
        expect(a.z).toBeLessThanOrEqual(z.shore.z1)
      }
      // swing set stranded mid-playa, not at the waterline
      const swing = z.art.find((a) => a.kind === 'swingSet')!
      expect(swing.x).toBeGreaterThan(z.playa.x0)
      expect(swing.x).toBeLessThan(z.sea.x0 - 200)
    }
  })

  it('lots + streets stay inside the town rect', () => {
    const z = zone(42)
    for (const l of z.lots) expect(contains(z.town, l.rect), `lot at ${l.rect.x0},${l.rect.z0}`).toBe(true)
    for (const s of [...z.streets, ...z.alleys, z.spur, ...z.stubs]) {
      if (s.axis === 'z') {
        expect(s.center - 25).toBeGreaterThanOrEqual(z.town.x0)
        expect(s.center + 25).toBeLessThanOrEqual(z.town.x1)
        expect(s.a0).toBeGreaterThanOrEqual(z.town.z0)
        expect(s.a1).toBeLessThanOrEqual(z.town.z1)
      } else {
        expect(s.center - 25).toBeGreaterThanOrEqual(z.town.z0)
        expect(s.center + 25).toBeLessThanOrEqual(z.town.z1)
        expect(s.a0).toBeGreaterThanOrEqual(z.town.x0)
        expect(s.a1).toBeLessThanOrEqual(z.town.x1)
      }
    }
  })
})
