/**
 * T100 — Bombay Beach terrain stamp tests (V18 geometry preconditions, V9
 * basin shaping, V2 determinism). The LOS probe itself lives with the e2e;
 * here we pin the HEIGHTS that make V18 true: berm crest (and every ramp
 * saddle) above every town-street eye line, sea surface below every street,
 * basin rim that the water can never step over.
 */
import { describe, expect, it } from 'vitest'
import { ChunkStore } from '../src/world/chunks'
import { generateLayout } from '../src/sim/gen/layout'
import { stampBombay_terrain } from '../src/sim/gen/bombay/terrain'
import {
  MAT_AIR,
  MAT_BONE_SHELL,
  MAT_DIRT,
  MAT_PLAYA_MUD,
  MAT_SALT_CRUST,
} from '../src/sim/materials'

const SEED = 7
const EYE = 17 // player eye height in vox above the walking surface

const layout = generateLayout(SEED)
const zone = layout.bombay!
const store = new ChunkStore()
const { seaFill } = stampBombay_terrain(store, layout, zone)
const g = layout.groundY

/** y of the highest solid voxel in column (x,z) — the walking surface top */
function topAt(s: ChunkStore, x: number, z: number): number {
  for (let y = g + 60; y >= 4; y--) {
    if (s.getVoxel(x, y, z) !== MAT_AIR) return y
  }
  return -1
}

function inRampBand(z: number, pad = 0): boolean {
  return zone.berm.ramps.some((r) => Math.abs(z - r.z) <= (r.w >> 1) + pad)
}

/** every street centerline probe point (x, z) on the stamped ground */
function streetProbes(): [number, number][] {
  const pts: [number, number][] = []
  for (const s of [...zone.streets, ...zone.alleys, zone.spur, ...zone.stubs]) {
    for (let a = s.a0; a <= s.a1; a += 173) {
      if (s.axis === 'z') {
        const c = s.center + (s.bend && a >= s.bend.at ? s.bend.offset : 0)
        pts.push([c, a])
      } else {
        pts.push([a, s.center])
      }
    }
  }
  return pts
}

describe('bombay terrain stamp (T100, V18/V9/V2)', () => {
  it('returns the sea box as the waterFill for the CA (V9)', () => {
    // WHY: the CA owns the water mass — the terrain stamper only shapes the
    // basin and hands the box up; a null/drifted box means a dry (or rogue) sea.
    expect(seaFill).toEqual(zone.sea)
  })

  it('V18 heights: crest + saddles above every street eye line; sea below every street', () => {
    // WHY: the berm-reveal beat — water INVISIBLE from every town street,
    // and from the crest you look DOWN at it. Both are pure height facts.
    const tops = streetProbes().map(([x, z]) => topAt(store, x, z))
    const maxStreet = Math.max(...tops)
    const minStreet = Math.min(...tops)
    expect(maxStreet).toBeLessThanOrEqual(g - 1) // datum: west edge street grade
    // every street surface strictly ABOVE the sea surface (look DOWN, V18)
    expect(minStreet).toBeGreaterThan(zone.sea.y1)
    // berm crest row max beats the highest street eye line everywhere
    const strip = zone.berm.strip
    let minCrest = Infinity
    for (let z = strip.z0 + 5; z <= strip.z1; z += 149) {
      if (inRampBand(z, 4)) continue
      let rowMax = -1
      for (let x = strip.x0; x <= strip.x1; x++) rowMax = Math.max(rowMax, topAt(store, x, z))
      minCrest = Math.min(minCrest, rowMax)
    }
    expect(minCrest).toBeGreaterThan(maxStreet + EYE)
    // the ramp cuts must not leak the view either: saddle > eye line too
    for (const r of zone.berm.ramps) {
      let saddle = -1
      for (let x = strip.x0; x <= strip.x1; x++) saddle = Math.max(saddle, topAt(store, x, r.z))
      expect(saddle, `${r.name} saddle`).toBeGreaterThan(maxStreet + EYE)
    }
  })

  it('ramp crossings walkable + drivable: ≤2 vox per step along each centerline', () => {
    // WHY: the ramps are the ONLY way over the berm for players and cars —
    // one 3-vox ledge anywhere on the line and the beach is unreachable.
    for (const r of zone.berm.ramps) {
      let prev = -1
      for (let x = zone.berm.strip.x0 - 50; x <= zone.playa.x0 + 100; x++) {
        const t = topAt(store, x, r.z)
        if (prev >= 0) {
          expect(Math.abs(t - prev), `${r.name} step at x=${x}`).toBeLessThanOrEqual(2)
        }
        prev = t
      }
    }
  })

  it('playa surface is salt-crust family east of the berm foot, mud beneath', () => {
    // WHY: research §1.3 — the beach is NOT sand: crust over mud with cracks
    // and a bone-shell band; a sand/grass surface means the stamp order broke.
    const fam = [MAT_SALT_CRUST, MAT_PLAYA_MUD, MAT_BONE_SHELL]
    let crust = 0
    let total = 0
    let boneNear = 0
    let nearN = 0
    let boneFar = 0
    let farN = 0
    const oldWL = zone.sea.x0 - 180
    for (let z = zone.playa.z0 + 30; z <= zone.playa.z1; z += 111) {
      if (inRampBand(z, 2)) continue // corridors are dirt two-tracks by design
      for (let x = zone.playa.x0 + 20; x <= zone.playa.x1 - 5; x += 37) {
        const t = topAt(store, x, z)
        const m = store.getVoxel(x, t, z)
        expect(fam, `surface at ${x},${z}`).toContain(m)
        expect(store.getVoxel(x, t - 3, z), `bed at ${x},${z}`).toBe(MAT_PLAYA_MUD)
        total++
        if (m === MAT_SALT_CRUST) crust++
        if (Math.abs(x - oldWL) <= 100) {
          nearN++
          if (m === MAT_BONE_SHELL) boneNear++
        } else if (x <= zone.playa.x0 + 240) {
          farN++
          if (m === MAT_BONE_SHELL) boneFar++
        }
      }
    }
    expect(crust / total).toBeGreaterThan(0.5) // crust dominates
    // bone-shell band DENSIFIES toward the old waterline mark
    expect(boneNear / nearN).toBeGreaterThan(boneFar / Math.max(1, farN) + 0.05)
  })

  it('no-flood: rim holds the surface, every westward path tops out ≫ sea level', () => {
    // WHY: V18 "sea never floods over the berm" — the CA will exploit any
    // rim column below the surface or any barrier gap the very first tick.
    const s = zone.sea
    for (let z = s.z0; z <= s.z1; z += 13) {
      expect(topAt(store, s.x0 - 1, z), `rim at z=${z}`).toBeGreaterThanOrEqual(s.y1)
    }
    const zSamples: number[] = zone.berm.ramps.map((r) => r.z)
    for (let z = s.z0 + 7; z <= s.z1; z += 97) zSamples.push(z)
    for (const z of zSamples) {
      let barrier = -1
      for (let x = zone.town.x1 + 1; x < s.x0; x++) barrier = Math.max(barrier, topAt(store, x, z))
      expect(barrier, `barrier at z=${z}`).toBeGreaterThanOrEqual(s.y1 + 8)
    }
    // basin shaped for the fill: mud floor below, open water column inside
    const mx = (s.x0 + s.x1) >> 1
    const mz = (s.z0 + s.z1) >> 1
    expect(store.getVoxel(mx, s.y0 - 1, mz)).toBe(MAT_PLAYA_MUD)
    expect(store.getVoxel(mx, s.y0, mz)).toBe(MAT_AIR)
    expect(store.getVoxel(mx, s.y1, mz)).toBe(MAT_AIR)
  })

  it('terraces: 1-vox steps, no N-S street straddles a step mid-band', () => {
    // WHY: streets/lots stamp ON this ground — a step through a street band
    // would shear the asphalt; along the fall line steps must stay 1 vox.
    for (const z of [zone.town.z0 + 400, zone.town.z0 + 1200]) {
      let prev = topAt(store, zone.town.x0, z)
      for (let x = zone.town.x0 + 1; x < zone.berm.strip.x0 - 1; x++) {
        const t = topAt(store, x, z)
        expect(prev - t, `step at x=${x},z=${z}`).toBeLessThanOrEqual(1)
        expect(t, `rise at x=${x},z=${z}`).toBeLessThanOrEqual(prev)
        prev = t
      }
    }
    // constant height across every N-S street band (center ± 25 + verge 10)
    for (const s of [...zone.streets, ...zone.alleys, zone.spur]) {
      if (s.axis !== 'z') continue
      for (const a of [s.a0 + 100, (s.a0 + s.a1) >> 1, s.a1 - 100]) {
        const c = s.center + (s.bend && a >= s.bend.at ? s.bend.offset : 0)
        const ref = topAt(store, c, a)
        for (let x = c - 35; x <= c + 35; x += 5) {
          expect(topAt(store, x, a), `${s.name} band at x=${x},z=${a}`).toBe(ref)
        }
      }
    }
  })

  it('deterministic: double-stamp into fresh stores is voxel-identical (V2)', () => {
    // WHY: lockstep MP + reload — any wall-clock/iteration-order leak in the
    // stamp desyncs every peer on the first berm shot.
    const store2 = new ChunkStore()
    const out2 = stampBombay_terrain(store2, layout, zone)
    expect(out2.seaFill).toEqual(seaFill)
    const fnv = (s: ChunkStore): number => {
      let h = 0x811c9dc5
      for (let z = zone.town.z0; z <= zone.town.z1; z += 37) {
        for (let x = zone.town.x0; x <= zone.shore.x1; x += 41) {
          for (let y = 12; y <= g + 44; y += 4) {
            h = Math.imul(h ^ s.getVoxel(x, y, z), 0x01000193)
          }
        }
      }
      return h >>> 0
    }
    expect(fnv(store2)).toBe(fnv(store))
  })
})
