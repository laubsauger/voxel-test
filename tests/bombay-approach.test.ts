/**
 * T106 — WP8 desert approach dressing + cosmetic rail. Stamps the approach
 * module directly (its bounds discipline must hold on any store), then
 * checks the §3 WP8 beats: junction sign + billboard, leaning pole line,
 * SINGLE-track rail (verified correction — never double), sparse creosote
 * off the streets/lots, and V2 determinism.
 */
import { describe, expect, it } from 'vitest'
import { ChunkKind, ChunkStore, CHUNK_COUNT, WORLD_VX } from '../src/world/chunks'
import { Fnv } from '../src/sim/hash'
import { generateLayout, type BombayZone, type Layout, type Rect, type Road } from '../src/sim/gen/layout'
import { stampBombay_approach } from '../src/sim/gen/bombay/approach'
import { hash3 } from '../src/sim/gen/stamper'
import {
  MAT_ART_RED,
  MAT_ART_TEAL,
  MAT_CHAR,
  MAT_GALV_METAL,
  MAT_LEAVES,
  MAT_METAL,
  MAT_PLASTER,
  MAT_RUST,
  MAT_WOOD,
} from '../src/sim/materials'

const SEED = 7
/** bombay street half-extent incl. verge (research §2.3 / layout BB_ROAD_EXT) */
const ST_EXT = 35

function stamped(): { store: ChunkStore; layout: Layout; zone: BombayZone } {
  const layout = generateLayout(SEED)
  const zone = layout.bombay
  if (!zone) throw new Error('seed 7: bombay zone missing')
  const store = new ChunkStore()
  stampBombay_approach(store, layout, zone)
  return { store, layout, zone }
}

/** CA-111 stand-in = nearest world x-road north of the town rect */
function ca111(layout: Layout, zone: BombayZone): Road {
  let road: Road | null = null
  for (const r of layout.roads) {
    if (r.axis !== 'x' || r.center >= zone.town.z0) continue
    if (!road || r.center > road.center) road = r
  }
  if (!road) throw new Error('no frame road north of the zone')
  return road
}

/** Fnv over all touched chunks — same shape hashSim uses for world state */
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

describe('bombay approach dressing (T106, WP8, V2)', () => {
  const { store, layout, zone } = stamped()
  const g = layout.groundY

  it('welcome sign + billboard stand at the spur/CA-111 junction', () => {
    // WHY: §3 WP8 accept — approaching on the frame road the sequence must
    // read rail/desert → SIGN → spur → town. Both boards live in the desert
    // band just south of the junction, east of the spur roadway.
    let plaster = 0
    let char = 0
    let metal = 0
    let ghost = 0
    let wood = 0
    for (let x = zone.spur.center + 40; x <= zone.spur.center + 120; x++) {
      for (let z = zone.town.z0 + 10; z <= zone.town.z0 + 90; z++) {
        for (let y = g; y <= g + 26; y++) {
          const m = store.getVoxel(x, y, z)
          if (m === MAT_PLASTER) plaster++
          else if (m === MAT_CHAR) char++
          else if (m === MAT_METAL) metal++
          else if (m === MAT_ART_RED || m === MAT_ART_TEAL) ghost++
          else if (m === MAT_WOOD) wood++
        }
      }
    }
    expect(plaster, 'sign 18×8 + billboard 30×12 plaster boards').toBeGreaterThan(300)
    expect(char, 'dark glyph band on the sign').toBeGreaterThanOrEqual(8)
    expect(metal, '2 metal billboard posts').toBeGreaterThanOrEqual(20)
    expect(ghost, '2-color ghost of old paint on the billboard').toBeGreaterThanOrEqual(15)
    // posts are 16 tall but the board overwrites their mid 8 voxels
    expect(wood, '2 wood sign posts').toBeGreaterThanOrEqual(14)
  })

  it('≥10 leaning utility poles run the spur + 1st Street, each top offset vs base', () => {
    // WHY: WP8 wants the line visibly LEANING (1-3 vox off vertical) — a
    // straight pole row reads like city infrastructure, not Bombay Beach.
    const first = zone.streets.find((s) => s.name === '1st Street')!
    const px = zone.town.x0 + 2
    const dirs: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    let poles = 0
    for (let z = zone.town.z0 + 10; z <= first.a1; z += 60) {
      expect(store.getVoxel(px, g, z), `pole base at z=${z}`).toBe(MAT_WOOD)
      expect(store.getVoxel(px + 1, g + 1, z + 1)).toBe(MAT_WOOD) // 2×2 shaft
      const h = hash3(px, 0, z, 0x7106)
      const lean = 1 + (h % 3)
      const [dx, dz] = dirs[(h >>> 4) & 3]
      expect(lean).toBeGreaterThanOrEqual(1)
      expect(lean).toBeLessThanOrEqual(3)
      // top segment sits displaced by the full lean; the un-leaned top spot
      // on the lean axis is vacated — the pole really tilts, not thickens
      expect(store.getVoxel(px + dx * lean, g + 24, z + dz * lean), `leaned top at z=${z}`).toBe(MAT_WOOD)
      expect(store.getVoxel(px - dx, g + 24, z - dz)).not.toBe(MAT_WOOD)
      // crossarm at the leaned top
      expect(store.getVoxel(px + dx * lean - 3, g + 23, z + dz * lean)).toBe(MAT_WOOD)
      poles++
    }
    expect(poles, 'pole line spans spur + 1st Street').toBeGreaterThanOrEqual(10)
  })

  it('single-track rail: two continuous rust runs ≥400, gauge 15, ties every 5', () => {
    // WHY: research §1 verified correction — the UP Yuma sub is SINGLE-track
    // here. Exactly two rails, 15 apart, on a raised bed with ties; runs must
    // be long enough to read as a mainline from the frame road.
    const road = ca111(layout, zone)
    const zc = road.sidewalks[0].z0 + 1
    const zA = zc - 7
    const zB = zc + 8
    // longest continuous rust run at full bed height on rail A
    let best: [number, number] = [0, -1]
    let runStart = -1
    for (let x = zone.town.x0; x <= WORLD_VX - 1; x++) {
      if (store.getVoxel(x, g + 3, zA) === MAT_RUST) {
        if (runStart < 0) runStart = x
        if (x - runStart > best[1] - best[0]) best = [runStart, x]
      } else runStart = -1
    }
    const [a0, a1] = best
    expect(a1 - a0 + 1, 'continuous rail run').toBeGreaterThanOrEqual(400)
    let ties = 0
    for (let x = a0; x <= a1; x++) {
      // gauge: the partner rail mirrors rail A across the whole run — and no
      // third rail in between (single track, not double)
      expect(store.getVoxel(x, g + 3, zB), `rail B at x=${x}`).toBe(MAT_RUST)
      if (x % 100 === 0) expect(store.getVoxel(x, g + 3, zc)).not.toBe(MAT_RUST)
      if (x % 5 === 0) {
        const tie = store.getVoxel(x, g + 2, zc)
        expect([MAT_WOOD, MAT_GALV_METAL], `tie at x=${x}`).toContain(tie)
        ties++
      }
    }
    expect(ties, 'ties every 5 along the run').toBeGreaterThanOrEqual(60)
    // 4-6 telegraph poles alongside, inland of the bed
    let poles = 0
    for (let x = zone.town.x0; x <= WORLD_VX - 1; x++) {
      if (store.getVoxel(x, g + 5, zc - 13) === MAT_WOOD) poles++
    }
    expect(poles).toBeGreaterThanOrEqual(4)
    expect(poles).toBeLessThanOrEqual(6)
  })

  it('creosote scrub present on the margins, zero shrub voxels on streets/lots', () => {
    // WHY: bounds discipline — the desert dressing must never contest street
    // or lot ground (other WP modules own those rects); and the margins must
    // actually carry scrub or the approach reads empty.
    let shrubLeaves = 0
    const scan: Rect = { x0: zone.town.x0, z0: zone.town.z0, x1: zone.shore.x1, z1: zone.town.z1 }
    for (let z = scan.z0; z <= scan.z1; z += 2) {
      for (let x = scan.x0; x <= scan.x1; x += 2) {
        for (let y = g; y <= g + 4; y++) if (store.getVoxel(x, y, z) === MAT_LEAVES) shrubLeaves++
      }
    }
    expect(shrubLeaves, 'scrub exists (sampled every 2nd column)').toBeGreaterThanOrEqual(10)
    const streetRect = (s: { axis: 'x' | 'z'; center: number; a0: number; a1: number; bend?: { offset: number } }): Rect =>
      s.axis === 'z'
        ? { x0: s.center - ST_EXT, z0: s.a0, x1: s.center + ST_EXT + (s.bend?.offset ?? 0), z1: s.a1 }
        : { x0: s.a0, z0: s.center - ST_EXT, x1: s.a1, z1: s.center + ST_EXT }
    const rects: Rect[] = [
      ...[...zone.streets, ...zone.alleys, zone.spur, ...zone.stubs].map((s) => streetRect(s)),
      ...zone.lots.map((l) => l.rect),
    ]
    // plain counting loop — an expect() per voxel would take minutes here
    let violations = 0
    let firstHit = ''
    for (const r of rects) {
      for (let z = r.z0; z <= r.z1; z++) {
        for (let x = r.x0; x <= r.x1; x++) {
          for (let y = g; y <= g + 5; y++) {
            if (store.getVoxel(x, y, z) === MAT_LEAVES) {
              if (violations === 0) firstHit = `${x},${y},${z}`
              violations++
            }
          }
        }
      }
    }
    expect(violations, `shrub voxels inside street/lot rects (first at ${firstHit})`).toBe(0)
  })

  it('deterministic: double-stamp yields identical stores (V2)', () => {
    // WHY: the stamp is part of tick-0 sim state — MP lockstep + reloads need
    // byte-identical voxels for the same seed.
    const again = stamped()
    const h1 = hashStore(store)
    expect(h1).not.toBe(0)
    expect(hashStore(again.store)).toBe(h1)
  })
})
