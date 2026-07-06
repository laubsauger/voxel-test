import { describe, expect, it } from 'vitest'
import {
  generateLayout,
  isCarKind,
  GROUND_Y,
  propRect,
  SPAWN_VX,
  SPAWN_VZ,
  STAIR_RISE,
  STAIR_RUN,
  STAIR_STEPS,
  STAIR_TREAD,
  STAIR_W,
  STORY_H,
  TOWER_STORY_H,
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

describe('town layout generator (T19/T50, V2)', () => {
  it('is deterministic: same seed → identical layout (JSON equality)', () => {
    for (const seed of [1234, 42, 31337]) {
      expect(JSON.stringify(generateLayout(seed))).toBe(JSON.stringify(generateLayout(seed)))
    }
  })

  it('different seeds → different layouts', () => {
    expect(JSON.stringify(generateLayout(1))).not.toBe(JSON.stringify(generateLayout(2)))
  })

  it('produces a full town: roads, lots, houses, districts, some pools and cars', () => {
    const l = generateLayout(42)
    expect(l.roads.length).toBeGreaterThanOrEqual(4)
    expect(l.roads.filter((r) => r.kind === 'arterial').length).toBe(2) // central cross
    expect(l.lots.length).toBeGreaterThanOrEqual(8)
    expect(l.houses.length).toBe(l.lots.length) // one house per lot
    expect(l.pools.length).toBeGreaterThan(0)
    expect(l.props.some((p) => isCarKind(p.kind))).toBe(true)
    expect(l.groundY).toBe(GROUND_Y)
    expect(GROUND_Y).toBeGreaterThanOrEqual(40)
    expect(GROUND_Y).toBeLessThanOrEqual(64)
  })

  it('districts: 4×4 downtown core + nature ring + coast, disjoint, in bounds (T50/B32)', () => {
    // WHY: districts are the world's macro structure — overlapping or
    // missing districts would stamp buildings into each other. B32 — the grid
    // generalized to an 8×8 block field (4× world): the T50 4×4 plan stays as
    // the centered downtown core, the ring is nature/park + desert + airport,
    // plus the south-edge coast strip.
    const l = generateLayout(7)
    expect(l.districts.length).toBe(101) // 10×10 blocks + 1 beach strip (B35: 5× world)
    const byKind = new Map<string, number>()
    for (const d of l.districts) byKind.set(d.kind, (byKind.get(d.kind) ?? 0) + 1)
    // downtown core (unchanged from the T50 4×4 plan — centered regardless of size)
    expect(byKind.get('suburb')).toBe(5)
    expect(byKind.get('rowhouse')).toBe(4)
    expect(byKind.get('commercial')).toBe(4)
    // ring: 3 core parks + 77 nature-ring parks (grows with the world surface)
    expect(byKind.get('park')).toBe(80)
    expect(byKind.get('desert')).toBe(4)
    expect(byKind.get('airport')).toBe(3)
    expect(byKind.get('beach')).toBe(1)
    for (let i = 0; i < l.districts.length; i++) {
      const a = l.districts[i]
      expect(a.rect.x0).toBeGreaterThanOrEqual(0)
      expect(a.rect.z0).toBeGreaterThanOrEqual(0)
      expect(a.rect.x1).toBeLessThan(WORLD_VX)
      expect(a.rect.z1).toBeLessThan(WORLD_VZ)
      for (let j = i + 1; j < l.districts.length; j++) {
        expect(overlaps(a.rect, l.districts[j].rect), `districts ${i}/${j} overlap`).toBe(false)
      }
    }
    // spawn (central crossing) is surrounded by suburb blocks
    const nearSpawn = l.districts.filter((d) => {
      const cx = (d.rect.x0 + d.rect.x1) / 2
      const cz = (d.rect.z0 + d.rect.z1) / 2
      return Math.abs(cx - SPAWN_VX) < 300 && Math.abs(cz - SPAWN_VZ) < 300
    })
    expect(nearSpawn.length).toBeGreaterThan(0)
    for (const d of nearSpawn) expect(d.kind).toBe('suburb')
  })

  it('roads (asphalt + sidewalks) never overlap houses, pools, towers or rowhouses', () => {
    const l = generateLayout(7)
    const roadRects = l.roads.flatMap((r) => [r.asphalt, ...r.sidewalks])
    for (const h of l.houses) {
      for (const r of roadRects) {
        expect(overlaps(r, h.rect), `road ${JSON.stringify(r)} overlaps house ${JSON.stringify(h.rect)}`).toBe(false)
        if (h.ell) expect(overlaps(r, h.ell)).toBe(false)
        if (h.garage) expect(overlaps(r, h.garage)).toBe(false)
      }
    }
    for (const p of l.pools) {
      for (const r of roadRects) expect(overlaps(r, p.basin)).toBe(false)
    }
    for (const t of l.towers) {
      for (const r of roadRects) expect(overlaps(r, t.rect)).toBe(false)
    }
    for (const b of l.rowBlocks) {
      for (const r of roadRects) expect(overlaps(r, b.rect)).toBe(false)
    }
  })

  it('houses, pools, driveways stay inside their lot (driveway may reach the sidewalk)', () => {
    const l = generateLayout(99)
    const lotById = new Map(l.lots.map((lot) => [lot.id, lot]))
    for (const h of l.houses) {
      const lot = lotById.get(h.lotId)!
      expect(contains(lot.rect, h.rect)).toBe(true)
      if (h.ell) expect(contains(lot.rect, h.ell)).toBe(true)
      if (h.garage) expect(contains(lot.rect, h.garage)).toBe(true)
      if (h.patio) expect(contains(lot.rect, h.patio)).toBe(true)
      if (h.shed) expect(contains(lot.rect, h.shed)).toBe(true)
      for (const bed of h.gardens) expect(contains(lot.rect, bed)).toBe(true)
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
      ...l.houses.flatMap((h) => [h.rect, h.driveway, ...(h.ell ? [h.ell] : []), ...(h.garage ? [h.garage] : [])]),
      ...l.pools.map((p) => p.basin),
      ...l.rowBlocks.map((b) => b.rect),
      ...l.towers.map((t) => t.rect),
      ...l.parking.map((p) => p.rect),
      ...l.plazas,
      ...l.parkPaths,
      ...l.ponds.map((p) => ({ x0: p.box.x0, z0: p.box.z0, x1: p.box.x1, z1: p.box.z1 })),
      ...l.farmhouses.flatMap((f) => [f.house, f.barn, f.porch]),
      l.villa.deck,
      l.villa.cabana,
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
      const fr = propRect(prop)
      expect(fr.x0).toBeGreaterThanOrEqual(0)
      expect(fr.x1).toBeLessThan(WORLD_VX)
      expect(fr.z0).toBeGreaterThanOrEqual(0)
      expect(fr.z1).toBeLessThan(WORLD_VZ)
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
    // towers must fit under the world ceiling with roof furniture on top
    for (const t of l.towers) {
      expect(GROUND_Y + t.floors * t.storyH + 12).toBeLessThan(WORLD_VY)
    }
  })

  it('towers: 5-15 stories, explorable core/stairs/shaft inside, disjoint (T50)', () => {
    // WHY: towers are the headline destructible set-pieces — a malformed core
    // means unreachable floors, an overlap means corrupted geometry.
    for (const seed of [42, 7, 99]) {
      const l = generateLayout(seed)
      expect(l.towers.length, `seed ${seed} towers`).toBeGreaterThanOrEqual(4)
      const comDistricts = l.districts.filter((d) => d.kind === 'commercial')
      for (const t of l.towers) {
        expect(t.floors).toBeGreaterThanOrEqual(5)
        expect(t.floors).toBeLessThanOrEqual(15)
        expect([0, 1], 'tower has a valid P23 style').toContain(t.style)
        expect(t.storyH).toBe(TOWER_STORY_H)
        // tower sits inside a commercial district
        expect(comDistricts.some((d) => contains(d.rect, t.rect)), `tower outside commercial districts`).toBe(true)
        // core + shaft + stairs nested inside the footprint walls
        const interior: Rect = { x0: t.rect.x0 + WALL_T, z0: t.rect.z0 + WALL_T, x1: t.rect.x1 - WALL_T, z1: t.rect.z1 - WALL_T }
        expect(contains(interior, t.core)).toBe(true)
        expect(contains(t.core, t.stairs)).toBe(true)
        expect(contains(t.core, t.shaft)).toBe(true)
        expect(overlaps(t.stairs, t.shaft), 'stairs overlap shaft').toBe(false)
        // stair run geometry supports the capsule (same limits as houses)
        expect(t.stairs.x1 - t.stairs.x0 + 1).toBe(TOWER_STORY_H / STAIR_RISE * STAIR_TREAD)
        expect(t.stairs.z1 - t.stairs.z0 + 1).toBe(STAIR_W)
      }
      for (let i = 0; i < l.towers.length; i++) {
        for (let j = i + 1; j < l.towers.length; j++) {
          expect(overlaps(l.towers[i].rect, l.towers[j].rect), `towers ${i}/${j} overlap`).toBe(false)
        }
        for (const p of l.parking) {
          expect(overlaps(l.towers[i].rect, p.rect), 'tower overlaps parking').toBe(false)
        }
      }
    }
  })

  it('P23 towers: 2+ facade styles seeded per tower, both appear across the skyline', () => {
    // WHY: every commercial tower used to be an identical glass box — a seeded
    // per-tower style makes the skyline vary. Both styles must actually occur.
    const seen = new Set<number>()
    for (const seed of [42, 7, 99, 1337, 31337]) {
      const l = generateLayout(seed)
      for (const t of l.towers) {
        expect([0, 1]).toContain(t.style)
        seen.add(t.style)
      }
    }
    expect(seen.has(0), 'glass-curtain towers occur').toBe(true)
    expect(seen.has(1), 'masonry towers occur').toBe(true)
  })

  it('P21 farmhouses: rural compounds on SOME park blocks, bigger than suburb houses, clear of paths/ponds', () => {
    // WHY: the nature rim needs an occasional rural set-piece — a big farmhouse
    // + barn (+ silo) compound, distinct from suburb houses, placed on a subset
    // of park blocks and kept clear of the park path cross / plaza / pond.
    let total = 0
    for (const seed of [42, 7, 99, 1337]) {
      const l = generateLayout(seed)
      const parks = l.districts.filter((d) => d.kind === 'park')
      expect(l.farmhouses.length, `seed ${seed} has farmhouses`).toBeGreaterThan(0)
      expect(l.farmhouses.length, `seed ${seed} occasional (not every park)`).toBeLessThan(parks.length)
      total += l.farmhouses.length
      for (const f of l.farmhouses) {
        // whole compound sits inside a single park district
        expect(
          parks.some((d) => contains(d.rect, f.house) && contains(d.rect, f.barn)),
          'compound inside a park district',
        ).toBe(true)
        // long footprint — clearly bigger than a suburb house
        expect(f.house.x1 - f.house.x0 + 1, 'farmhouse is long').toBeGreaterThanOrEqual(88)
        expect(overlaps(f.house, f.barn), 'barn separate from house').toBe(false)
        // clear of park paths + plaza
        for (const path of l.parkPaths) {
          expect(overlaps(f.house, path), 'house off the paths').toBe(false)
          expect(overlaps(f.barn, path), 'barn off the paths').toBe(false)
        }
        // clear of ponds
        for (const p of l.ponds) {
          const pr: Rect = { x0: p.box.x0, z0: p.box.z0, x1: p.box.x1, z1: p.box.z1 }
          expect(overlaps(f.house, pr), 'house off the pond').toBe(false)
          expect(overlaps(f.barn, pr), 'barn off the pond').toBe(false)
        }
      }
    }
    expect(total, 'a few farmhouses across the sampled seeds').toBeGreaterThan(4)
  })

  it('rowhouses: units tile each row exactly, 2-3 stories, inside their district (T50)', () => {
    for (const seed of [42, 7]) {
      const l = generateLayout(seed)
      expect(l.rowBlocks.length, `seed ${seed} row blocks`).toBe(8) // 2 rows × 4 districts
      const rowDistricts = l.districts.filter((d) => d.kind === 'rowhouse')
      for (const b of l.rowBlocks) {
        expect(rowDistricts.some((d) => contains(d.rect, b.rect))).toBe(true)
        expect(b.units.length).toBeGreaterThanOrEqual(4)
        // units tile the row footprint exactly (party walls shared, no gaps)
        let x = b.rect.x0
        for (const u of b.units) {
          expect(u.x0).toBe(x)
          expect(u.floors).toBeGreaterThanOrEqual(2)
          expect(u.floors).toBeLessThanOrEqual(3)
          // wide enough for the interior stair run (STAIR_W + party walls)
          expect(u.x1 - u.x0 + 1).toBeGreaterThanOrEqual(STAIR_W + 2 * WALL_T + 4)
          x = u.x1 + 1
        }
        expect(x - 1).toBe(b.rect.x1)
      }
    }
  })

  it('parks: paths + at least one pond emitted for the water sim (T50)', () => {
    for (const seed of [42, 7, 99]) {
      const l = generateLayout(seed)
      const parks = l.districts.filter((d) => d.kind === 'park')
      expect(l.ponds.length, `seed ${seed} ponds`).toBeGreaterThanOrEqual(1)
      for (const p of l.ponds) {
        const rect: Rect = { x0: p.box.x0, z0: p.box.z0, x1: p.box.x1, z1: p.box.z1 }
        expect(parks.some((d) => contains(d.rect, rect)), 'pond outside park districts').toBe(true)
        expect(p.box.y0).toBe(GROUND_Y - p.depth)
        expect(p.box.y1).toBeLessThan(GROUND_Y) // freeboard below the meadow surface
        expect(p.lobes.length).toBeGreaterThan(0)
        // pond keeps clear of the park path cross
        for (const path of l.parkPaths) expect(overlaps(rect, path), 'pond under a path').toBe(false)
      }
      expect(l.parkPaths.length).toBeGreaterThanOrEqual(parks.length * 3)
      for (const path of l.parkPaths) {
        expect(parks.some((d) => contains(d.rect, path))).toBe(true)
      }
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

  it('T51: interiors, garages, balconies, chimneys, rooflines, backyards appear and never collide', () => {
    // WHY: detail features must add variety without breaking houses — a
    // partition across the stairs or furniture inside a wall corrupts play space.
    let garages = 0
    let balconies = 0
    let chimneys = 0
    let hips = 0
    let sheds = 0
    let patios = 0
    for (const seed of [42, 7, 99, 1337]) {
      const l = generateLayout(seed)
      for (const h of l.houses) {
        expect(h.partitions.length, 'rooms per house').toBeGreaterThanOrEqual(h.floors >= 1 ? 1 : 0)
        const interior: Rect = { x0: h.rect.x0 + WALL_T, z0: h.rect.z0 + WALL_T, x1: h.rect.x1 - WALL_T, z1: h.rect.z1 - WALL_T }
        for (const p of h.partitions) {
          expect(p.floor).toBeLessThan(h.floors)
          const wall: Rect = p.axis === 'x' ? { x0: p.a0, z0: p.c, x1: p.a1, z1: p.c } : { x0: p.c, z0: p.a0, x1: p.c, z1: p.a1 }
          expect(contains(interior, wall), `partition outside interior`).toBe(true)
          // door gap inside the wall span
          expect(p.doorAt).toBeGreaterThanOrEqual(p.a0)
          expect(p.doorAt + 8).toBeLessThanOrEqual(p.a1)
          // never crosses the stair run
          if (h.stairs) expect(overlaps(wall, h.stairs.rect), 'partition through stairs').toBe(false)
        }
        if (h.garage) {
          garages++
          expect(overlaps(h.garage, h.rect), 'garage inside house').toBe(false)
          // attached: garage touches the house side wall
          expect(h.garage.x1 === h.rect.x0 - 1 || h.garage.x0 === h.rect.x1 + 1).toBe(true)
        }
        if (h.balcony) {
          balconies++
          expect(h.floors).toBe(2)
          expect(h.balconyDoor).not.toBeNull()
          expect(h.balconyDoor!.floor).toBe(1)
        }
        if (h.chimney) {
          chimneys++
          expect(h.roof).not.toBe('flat')
          expect(h.chimney.x).toBeGreaterThanOrEqual(h.rect.x0)
          expect(h.chimney.x + 2).toBeLessThanOrEqual(h.rect.x1)
          expect(h.chimney.z).toBeGreaterThanOrEqual(h.rect.z0)
          expect(h.chimney.z + 2).toBeLessThanOrEqual(h.rect.z1)
        }
        if (h.roof === 'hip') hips++
        if (h.shed) {
          sheds++
          for (const p of l.pools.filter((p) => p.lotId === h.lotId)) {
            expect(overlaps(h.shed, { x0: p.basin.x0, z0: p.basin.z0, x1: p.basin.x1, z1: p.basin.z1 })).toBe(false)
          }
        }
        if (h.patio) {
          patios++
          expect(overlaps(h.patio, h.rect)).toBe(false)
        }
      }
      // furniture props land inside their house interior
      const furnitureKinds = new Set(['table', 'chair', 'bed', 'counter', 'sofa'])
      const furniture = l.props.filter((p) => furnitureKinds.has(p.kind))
      expect(furniture.length, `seed ${seed} furniture`).toBeGreaterThan(l.houses.length) // several pieces per house
      for (const f of furniture) {
        const fr = propRect(f)
        expect(
          l.houses.some((h) => contains({ x0: h.rect.x0 + WALL_T, z0: h.rect.z0 + WALL_T, x1: h.rect.x1 - WALL_T, z1: h.rect.z1 - WALL_T }, fr)),
          `furniture ${f.kind} at (${f.x},${f.z}) outside every house`,
        ).toBe(true)
      }
    }
    // variety exists across the sample (probabilistic features, 4 seeds × 20 lots)
    expect(garages, 'garages').toBeGreaterThan(0)
    expect(balconies, 'balconies').toBeGreaterThan(0)
    expect(chimneys, 'chimneys').toBeGreaterThan(0)
    expect(hips, 'hip roofs').toBeGreaterThan(0)
    expect(sheds, 'sheds').toBeGreaterThan(0)
    expect(patios, 'patios').toBeGreaterThan(0)
  })

  it('villa (B19): spawn lot carries the showcase — big house, ≥8×4m pool with shallow end, deck, cabana', () => {
    // WHY: the villa is the first thing the player sees and the spawn-pool
    // guarantee for the water sim — its pool must be large and close.
    for (const seed of [1337, 1, 42, 7, 99, 31337]) {
      const l = generateLayout(seed)
      const v = l.villa
      const lot = l.lots.find((x) => x.id === v.lotId)!
      const h = l.houses[v.lotId]
      expect(h.floors, 'villa is 2-story').toBe(2)
      expect(h.roof).toBe('hip')
      expect(h.balcony).not.toBeNull()
      expect(h.chimney).not.toBeNull()
      const pool = l.pools.find((p) => p.lotId === v.lotId)!
      expect(pool, 'villa pool exists').toBeTruthy()
      expect(pool.basin.x1 - pool.basin.x0 + 1).toBeGreaterThanOrEqual(80) // ≥ 8 m
      expect(pool.basin.z1 - pool.basin.z0 + 1).toBeGreaterThanOrEqual(40) // ≥ 4 m
      expect(pool.shallow, 'two-depth pool').toBeTruthy()
      expect(pool.shallow!.y1).toBeLessThan(pool.basin.y1) // raised floor below waterline
      // spawn proximity: nearest pool ≤ 200 voxels (20 m) from the crossing
      const dx = SPAWN_VX < pool.basin.x0 ? pool.basin.x0 - SPAWN_VX : SPAWN_VX > pool.basin.x1 ? SPAWN_VX - pool.basin.x1 : 0
      const dz = SPAWN_VZ < pool.basin.z0 ? pool.basin.z0 - SPAWN_VZ : SPAWN_VZ > pool.basin.z1 ? SPAWN_VZ - pool.basin.z1 : 0
      expect(Math.hypot(dx, dz), `seed ${seed} villa pool distance`).toBeLessThanOrEqual(200)
      // deck wraps the pool; cabana sits apart from house and pool, inside the lot
      expect(contains(v.deck, { x0: pool.basin.x0, z0: pool.basin.z0, x1: pool.basin.x1, z1: pool.basin.z1 })).toBe(true)
      expect(contains(lot.rect, v.cabana)).toBe(true)
      expect(overlaps(v.cabana, h.rect)).toBe(false)
      expect(overlaps(v.cabana, { x0: pool.basin.x0, z0: pool.basin.z0, x1: pool.basin.x1, z1: pool.basin.z1 })).toBe(false)
      // pools overall: ≥2 in the world
      expect(l.pools.length, `seed ${seed} pool count`).toBeGreaterThanOrEqual(2)
      // forced pools still live inside their lot, clear of the house
      const lotById = new Map(l.lots.map((lot) => [lot.id, lot]))
      for (const p of l.pools) {
        const plot = lotById.get(p.lotId)!
        expect(contains(plot.rect, { x0: p.basin.x0, z0: p.basin.z0, x1: p.basin.x1, z1: p.basin.z1 })).toBe(true)
        const hh = l.houses[p.lotId]
        expect(overlaps(hh.rect, p.basin)).toBe(false)
        if (hh.ell) expect(overlaps(hh.ell, p.basin)).toBe(false)
        expect(overlaps(hh.driveway, p.basin)).toBe(false)
        expect(overlaps(hh.path, p.basin)).toBe(false)
      }
    }
  })

  it('vegetation: trees exist and never intersect houses, driveways, towers or rowhouses (T42/T50)', () => {
    // WHY: trees must add life without blocking gameplay routes — a canopy
    // over a driveway clips parked cars, a trunk in a tower corrupts walls.
    for (const seed of [42, 7, 99]) {
      const l = generateLayout(seed)
      expect(l.trees.length, `seed ${seed} trees`).toBeGreaterThan(30)
      expect(l.shrubs.length, `seed ${seed} shrubs`).toBeGreaterThan(5)
      for (const t of l.trees) {
        const canopy: Rect = { x0: t.x - t.canopyR, z0: t.z - t.canopyR, x1: t.x + 1 + t.canopyR, z1: t.z + 1 + t.canopyR }
        for (const h of l.houses) {
          expect(overlaps(canopy, h.rect), `tree(${t.x},${t.z}) r${t.canopyR} vs house`).toBe(false)
          if (h.ell) expect(overlaps(canopy, h.ell), `tree(${t.x},${t.z}) vs ell`).toBe(false)
          expect(overlaps(canopy, h.driveway), `tree(${t.x},${t.z}) vs driveway`).toBe(false)
        }
        for (const tw of l.towers) {
          expect(overlaps(canopy, tw.rect), `tree(${t.x},${t.z}) vs tower`).toBe(false)
        }
        const trunk: Rect = { x0: t.x, z0: t.z, x1: t.x + 1, z1: t.z + 1 }
        for (const b of l.rowBlocks) {
          expect(overlaps(trunk, b.rect), `tree trunk(${t.x},${t.z}) vs rowhouse`).toBe(false)
        }
        // trunk never inside a pool basin or pond (decks/shores kept clear)
        for (const p of l.pools) {
          expect(overlaps(trunk, p.basin)).toBe(false)
        }
        for (const p of l.ponds) {
          expect(overlaps(trunk, { x0: p.box.x0, z0: p.box.z0, x1: p.box.x1, z1: p.box.z1 })).toBe(false)
        }
      }
    }
  })

  it('house openings sit within their walls', () => {
    const l = generateLayout(5)
    for (const h of l.houses) {
      const w = h.rect.x1 - h.rect.x0 + 1
      const d = h.rect.z1 - h.rect.z0 + 1
      for (const o of [h.door, ...h.windows, ...(h.balconyDoor ? [h.balconyDoor] : [])]) {
        const wallLen = o.side === 'x-' || o.side === 'x+' ? d : w
        expect(o.offset).toBeGreaterThanOrEqual(1)
        expect(o.offset + o.w).toBeLessThanOrEqual(wallLen - 1)
        expect(o.floor).toBeLessThan(h.floors)
        expect(o.sill + o.h).toBeLessThanOrEqual(h.storyH)
      }
    }
  })
})
