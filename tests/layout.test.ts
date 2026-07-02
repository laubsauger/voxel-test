import { describe, expect, it } from 'vitest'
import {
  generateLayout,
  GROUND_Y,
  STAIR_RISE,
  STAIR_RUN,
  STAIR_STEPS,
  STAIR_TREAD,
  STAIR_W,
  STORY_H,
  WALL_T,
  type Rect,
} from '../src/sim/gen/layout'
import { WORLD_VX, WORLD_VY, WORLD_VZ } from '../src/world/chunks'

function overlaps(a: Rect, b: Rect): boolean {
  return a.x0 <= b.x1 && a.x1 >= b.x0 && a.z0 <= b.z1 && a.z1 >= b.z0
}

function contains(outer: Rect, inner: Rect): boolean {
  return inner.x0 >= outer.x0 && inner.x1 <= outer.x1 && inner.z0 >= outer.z0 && inner.z1 <= outer.z1
}

describe('suburb layout generator (T19, V2)', () => {
  it('is deterministic: same seed → identical layout (JSON equality)', () => {
    expect(JSON.stringify(generateLayout(1234))).toBe(JSON.stringify(generateLayout(1234)))
  })

  it('different seeds → different layouts', () => {
    expect(JSON.stringify(generateLayout(1))).not.toBe(JSON.stringify(generateLayout(2)))
  })

  it('produces a full suburb: roads, lots, houses, some pools and cars', () => {
    const l = generateLayout(42)
    expect(l.roads.length).toBeGreaterThanOrEqual(4)
    expect(l.lots.length).toBeGreaterThanOrEqual(8)
    expect(l.houses.length).toBe(l.lots.length) // one house per lot
    expect(l.pools.length).toBeGreaterThan(0)
    expect(l.props.length).toBeGreaterThan(0)
    expect(l.groundY).toBe(GROUND_Y)
    expect(GROUND_Y).toBeGreaterThanOrEqual(40)
    expect(GROUND_Y).toBeLessThanOrEqual(64)
  })

  it('roads (asphalt + sidewalks) never overlap houses or pools', () => {
    const l = generateLayout(7)
    const roadRects = l.roads.flatMap((r) => [r.asphalt, ...r.sidewalks])
    for (const h of l.houses) {
      for (const r of roadRects) {
        expect(overlaps(r, h.rect), `road ${JSON.stringify(r)} overlaps house ${JSON.stringify(h.rect)}`).toBe(false)
        if (h.ell) expect(overlaps(r, h.ell)).toBe(false)
      }
    }
    for (const p of l.pools) {
      for (const r of roadRects) expect(overlaps(r, p.basin)).toBe(false)
    }
  })

  it('houses, pools, driveways stay inside their lot (driveway may reach the sidewalk)', () => {
    const l = generateLayout(99)
    const lotById = new Map(l.lots.map((lot) => [lot.id, lot]))
    for (const h of l.houses) {
      const lot = lotById.get(h.lotId)!
      expect(contains(lot.rect, h.rect)).toBe(true)
      if (h.ell) expect(contains(lot.rect, h.ell)).toBe(true)
      // driveway is allowed to extend LOT_GAP past the front edge to meet the sidewalk
      const grow: Rect = { x0: lot.rect.x0, z0: lot.rect.z0 - 4, x1: lot.rect.x1, z1: lot.rect.z1 + 4 }
      expect(contains(grow, h.driveway)).toBe(true)
      // house never overlaps its own pool
      for (const p of l.pools.filter((p) => p.lotId === h.lotId)) {
        expect(overlaps(h.rect, p.basin)).toBe(false)
        if (h.ell) expect(overlaps(h.ell, p.basin)).toBe(false)
        expect(contains(lot.rect, p.basin)).toBe(true)
      }
    }
  })

  it('everything is inside arena bounds', () => {
    const l = generateLayout(31337)
    const rects: Rect[] = [
      ...l.roads.flatMap((r) => [r.asphalt, ...r.sidewalks]),
      ...l.lots.map((x) => x.rect),
      ...l.houses.flatMap((h) => [h.rect, h.driveway, ...(h.ell ? [h.ell] : [])]),
      ...l.pools.map((p) => p.basin),
    ]
    for (const r of rects) {
      expect(r.x0).toBeGreaterThanOrEqual(0)
      expect(r.z0).toBeGreaterThanOrEqual(0)
      expect(r.x1).toBeLessThan(WORLD_VX)
      expect(r.z1).toBeLessThan(WORLD_VZ)
      expect(r.x0).toBeLessThanOrEqual(r.x1)
      expect(r.z0).toBeLessThanOrEqual(r.z1)
    }
    for (const p of l.pools) {
      expect(p.basin.y0).toBeGreaterThan(0)
      expect(p.basin.y1).toBeLessThan(GROUND_Y)
    }
    for (const prop of l.props) {
      expect(prop.x).toBeGreaterThanOrEqual(0)
      expect(prop.x).toBeLessThan(WORLD_VX)
      expect(prop.z).toBeGreaterThanOrEqual(0)
      expect(prop.z).toBeLessThan(WORLD_VZ)
      expect(prop.y).toBeGreaterThan(0)
      expect(prop.y).toBeLessThan(WORLD_VY)
    }
    for (const t of l.trees) {
      expect(t.x - t.canopyR).toBeGreaterThanOrEqual(0)
      expect(t.x + 1 + t.canopyR).toBeLessThan(WORLD_VX)
      expect(t.z - t.canopyR).toBeGreaterThanOrEqual(0)
      expect(t.z + 1 + t.canopyR).toBeLessThan(WORLD_VZ)
      expect(GROUND_Y + t.trunkH + 2 * t.canopyR).toBeLessThan(WORLD_VY)
    }
    for (const s of l.shrubs) {
      expect(s.x - s.r).toBeGreaterThanOrEqual(0)
      expect(s.x + s.r).toBeLessThan(WORLD_VX)
      expect(s.z - s.r).toBeGreaterThanOrEqual(0)
      expect(s.z + s.r).toBeLessThan(WORLD_VZ)
    }
  })

  it('stairs: every multi-story house has a walkable straight run that never blocks the door (T41)', () => {
    // WHY: upper floors are gameplay space — they must be reachable by the Jolt
    // capsule (step-climb 0.4 m) through the front door without obstruction.
    for (const seed of [42, 7, 99]) {
      const l = generateLayout(seed)
      let multi = 0
      for (const h of l.houses) {
        if (h.floors < 2) {
          expect(h.stairs).toBeNull()
          continue
        }
        multi++
        const s = h.stairs!
        // rise/run within capsule limits: riser 0.2 m < Jolt 0.4 m step-up,
        // tread ≥ 0.3 m ≥ capsule radius, integer step count covers the story
        expect(STAIR_RISE).toBeLessThanOrEqual(4)
        expect(STAIR_TREAD).toBeGreaterThanOrEqual(3)
        expect(STAIR_STEPS * STAIR_RISE).toBe(STORY_H)
        expect(s.rect.x1 - s.rect.x0 + 1).toBe(STAIR_RUN)
        expect(s.rect.z1 - s.rect.z0 + 1).toBe(STAIR_W)
        // inside the interior (walls are WALL_T thick)
        expect(s.rect.x0).toBeGreaterThanOrEqual(h.rect.x0 + WALL_T)
        expect(s.rect.x1).toBeLessThanOrEqual(h.rect.x1 - WALL_T)
        expect(s.rect.z0).toBeGreaterThanOrEqual(h.rect.z0 + WALL_T)
        expect(s.rect.z1).toBeLessThanOrEqual(h.rect.z1 - WALL_T)
        // against the back wall, far from the front-wall door
        const frontZ = h.door.side === 'z-' ? h.rect.z0 : h.rect.z1
        const distToFront = Math.min(Math.abs(s.rect.z0 - frontZ), Math.abs(s.rect.z1 - frontZ))
        expect(distToFront).toBeGreaterThanOrEqual(10)
      }
      expect(multi, `seed ${seed} should have multi-story houses`).toBeGreaterThan(0)
    }
  })

  it('pool guarantee: ≥2 pools and one within 200 voxels of spawn, any seed', () => {
    // WHY: spawn is the central road crossing (voxel 512,512) — pools are a
    // headline water-sim feature and must be reachable without a map hike,
    // regardless of what the per-lot 35% roll produced.
    for (const seed of [1337, 1, 42, 7, 99, 31337]) {
      const l = generateLayout(seed)
      expect(l.pools.length, `seed ${seed} pool count`).toBeGreaterThanOrEqual(2)
      const min = Math.min(
        ...l.pools.map((p) => {
          const dx = 512 < p.basin.x0 ? p.basin.x0 - 512 : 512 > p.basin.x1 ? 512 - p.basin.x1 : 0
          const dz = 512 < p.basin.z0 ? p.basin.z0 - 512 : 512 > p.basin.z1 ? 512 - p.basin.z1 : 0
          return Math.hypot(dx, dz)
        }),
      )
      expect(min, `seed ${seed} nearest pool distance`).toBeLessThanOrEqual(200)
      // forced pools still live inside their lot, clear of the house
      const lotById = new Map(l.lots.map((lot) => [lot.id, lot]))
      for (const p of l.pools) {
        const lot = lotById.get(p.lotId)!
        expect(contains(lot.rect, { x0: p.basin.x0, z0: p.basin.z0, x1: p.basin.x1, z1: p.basin.z1 })).toBe(true)
        const h = l.houses[p.lotId]
        expect(overlaps(h.rect, p.basin)).toBe(false)
        if (h.ell) expect(overlaps(h.ell, p.basin)).toBe(false)
        expect(overlaps(h.driveway, p.basin)).toBe(false)
        expect(overlaps(h.path, p.basin)).toBe(false)
      }
    }
  })

  it('vegetation: trees exist and never intersect houses or driveways (T42)', () => {
    // WHY: trees must add life without blocking gameplay routes — a canopy
    // over a driveway clips parked cars, a trunk in a house corrupts walls.
    for (const seed of [42, 7, 99]) {
      const l = generateLayout(seed)
      expect(l.trees.length, `seed ${seed} trees`).toBeGreaterThan(10)
      expect(l.shrubs.length, `seed ${seed} shrubs`).toBeGreaterThan(5)
      for (const t of l.trees) {
        const canopy: Rect = { x0: t.x - t.canopyR, z0: t.z - t.canopyR, x1: t.x + 1 + t.canopyR, z1: t.z + 1 + t.canopyR }
        for (const h of l.houses) {
          expect(overlaps(canopy, h.rect), `tree(${t.x},${t.z}) r${t.canopyR} vs house`).toBe(false)
          if (h.ell) expect(overlaps(canopy, h.ell), `tree(${t.x},${t.z}) vs ell`).toBe(false)
          expect(overlaps(canopy, h.driveway), `tree(${t.x},${t.z}) vs driveway`).toBe(false)
        }
        // trunk never inside a pool basin (deck kept clear)
        for (const p of l.pools) {
          const trunk: Rect = { x0: t.x, z0: t.z, x1: t.x + 1, z1: t.z + 1 }
          expect(overlaps(trunk, p.basin)).toBe(false)
        }
      }
    }
  })

  it('house openings sit within their walls', () => {
    const l = generateLayout(5)
    for (const h of l.houses) {
      const w = h.rect.x1 - h.rect.x0 + 1
      const d = h.rect.z1 - h.rect.z0 + 1
      for (const o of [h.door, ...h.windows]) {
        const wallLen = o.side === 'x-' || o.side === 'x+' ? d : w
        expect(o.offset).toBeGreaterThanOrEqual(1)
        expect(o.offset + o.w).toBeLessThanOrEqual(wallLen - 1)
        expect(o.floor).toBeLessThan(h.floors)
        expect(o.sill + o.h).toBeLessThanOrEqual(h.storyH)
      }
    }
  })
})
