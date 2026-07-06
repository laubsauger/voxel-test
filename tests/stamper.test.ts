import { describe, expect, it } from 'vitest'
import { ChunkStore, ChunkKind, CHUNK_COUNT, VOXEL_SIZE, WORLD_VX, WORLD_VZ } from '../src/world/chunks'

// B32 — central arterial crossing sits at the world center (SPAWN_VX/VZ).
// Derived from world size so a future resize never breaks the re-basing.
const CVX = WORLD_VX >> 1
import { Fnv } from '../src/sim/hash'
import { generateLayout, isCarKind, DOOR_W, STAIR_W, STAIR_TREAD, STAIR_STEPS, WALL_T, type House, type Layout, type Opening } from '../src/sim/gen/layout'
import { stampScene } from '../src/sim/gen/stamper'
import { placeholderProps } from '../src/sim/gen/props'
import {
  MAT_AIR,
  MAT_ASPHALT,
  MAT_BRICK,
  MAT_CONCRETE,
  MAT_DIRT,
  MAT_GLASS,
  MAT_GRASS,
  MAT_LAMP,
  MAT_LEAVES,
  MAT_METAL,
  MAT_PAINT,
  MAT_PLASTER,
  MAT_SAND,
  MAT_ROOFTILE,
  MAT_WOOD,
  MATERIALS,
  MatFlags,
} from '../src/sim/materials'

/** Fnv over all touched (non-empty) chunks — same shape hashSim uses for world state */
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

function stamped(seed: number): { store: ChunkStore; layout: Layout; waterFills: { box: { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number } }[]; vehicleSpawns: { archetype: string; cx: number; cy: number; cz: number; yaw: number }[] } {
  const store = new ChunkStore()
  const layout = generateLayout(seed)
  const { waterFills, vehicleSpawns } = stampScene(store, layout, placeholderProps())
  return { store, layout, waterFills, vehicleSpawns }
}

/** first voxel of an opening in world coords (mirrors stamper side logic) */
function openingProbe(h: House, o: Opening, groundY: number): [number, number, number] {
  const y = groundY + o.floor * h.storyH + o.sill + 1
  const r = h.rect
  switch (o.side) {
    case 'z-': return [r.x0 + o.offset + 1, y, r.z0]
    case 'z+': return [r.x0 + o.offset + 1, y, r.z1]
    case 'x-': return [r.x0, y, r.z0 + o.offset + 1]
    case 'x+': return [r.x1, y, r.z0 + o.offset + 1]
  }
}

describe('scene stamper (T20/T50/T51, V2, V5)', () => {
  const { store, layout, waterFills, vehicleSpawns } = stamped(42)
  const g = layout.groundY

  it('terrain: grass surface over dirt, ground band respected', () => {
    expect(store.getVoxel(10, g - 1, 10)).toBe(MAT_GRASS)
    expect(store.getVoxel(10, g - 5, 10)).toBe(MAT_DIRT)
    expect(store.getVoxel(10, 0, 10)).toBe(MAT_DIRT)
  })

  it('roads are asphalt, sidewalks concrete, at surface level', () => {
    const road = layout.roads.find((r) => r.axis === 'x' && r.kind === 'res')!
    // probe off the 2-voxel center line (which may carry a paint dash, T43)
    expect(store.getVoxel(300, g - 1, road.center + 5)).toBe(MAT_ASPHALT)
    expect(store.getVoxel(300, g - 1, road.sidewalks[0].z0 + 1)).toBe(MAT_CONCRETE)
    expect(store.getVoxel(300, g, road.center)).toBe(MAT_AIR) // road surface is walkable
  })

  it('house: walls are brick/plaster, wood floor slab, doors open, windows glazed', () => {
    const h = layout.houses[0]
    const midX = (h.rect.x0 + h.rect.x1) >> 1
    const midZ = (h.rect.z0 + h.rect.z1) >> 1
    expect([MAT_BRICK, MAT_PLASTER]).toContain(h.wallMat)
    expect(store.getVoxel(h.rect.x0, g + 5, midZ)).toBe(h.wallMat) // x- wall below sill height
    expect(store.getVoxel(midX, g, midZ)).toBe(MAT_WOOD) // floor slab
    const [dx, dy, dz] = openingProbe(h, h.door, g)
    expect(store.getVoxel(dx, dy, dz)).toBe(MAT_AIR) // door carved through wall
    const [wx, wy, wz] = openingProbe(h, h.windows[0], g)
    expect(store.getVoxel(wx, wy, wz)).toBe(MAT_GLASS)
    // roof exists above the top story
    const roofY = g + h.floors * h.storyH
    expect(store.getVoxel(midX, roofY, midZ)).toBe(h.roof === 'flat' ? MAT_CONCRETE : h.roofMat)
  })

  it('driveways are concrete', () => {
    const h = layout.houses[0]
    const midX = (h.driveway.x0 + h.driveway.x1) >> 1
    const midZ = (h.driveway.z0 + h.driveway.z1) >> 1
    expect(store.getVoxel(midX, g - 1, midZ)).toBe(MAT_CONCRETE)
  })

  it('pavers are subtle (B12): concrete base + sparse rooftile accents, never a brick checker', () => {
    // WHY: the old 2×2 brick/concrete checker read as a rendering glitch —
    // paver surfaces must be mostly concrete with low-frequency accents.
    for (const h of layout.houses.slice(0, 8)) {
      let concrete = 0
      let accent = 0
      const midZ = (h.path.z0 + h.path.z1) >> 1
      for (const rect of h.driveMat === 'paver' ? [h.path, h.driveway] : [h.path]) {
        for (let z = rect.z0; z <= rect.z1; z++) {
          for (let x = rect.x0; x <= rect.x1; x++) {
            const m = store.getVoxel(x, g - 1, z)
            expect([MAT_CONCRETE, MAT_ROOFTILE], `paver surface at (${x},${z}) is ${m}`).toContain(m)
            if (m === MAT_CONCRETE) concrete++
            else accent++
          }
        }
      }
      expect(concrete, 'paver base is concrete').toBeGreaterThan(0)
      expect(accent / (concrete + accent), 'accents stay sparse').toBeLessThan(0.4)
      expect(store.getVoxel(h.path.x0 + 1, g - 1, midZ)).not.toBe(MAT_BRICK)
    }
  })

  it('pools + ponds: dug basins, water fills requested as data', () => {
    expect(layout.pools.length).toBeGreaterThan(0)
    const b = layout.pools[0].basin
    const midX = (b.x0 + b.x1) >> 1
    const midZ = (b.z0 + b.z1) >> 1
    // probe the deep half (a villa shallow end refills the house-side half)
    const deepZ = layout.pools[0].shallow
      ? (layout.pools[0].shallow!.z0 === b.z0 ? b.z1 - 3 : b.z0 + 3)
      : midZ
    expect(store.getVoxel(midX, (b.y0 + b.y1) >> 1, deepZ)).toBe(MAT_AIR) // dug empty
    expect(store.getVoxel(b.x0 - 1, (b.y0 + b.y1) >> 1, midZ)).toBe(MAT_CONCRETE) // side lining
    expect(store.getVoxel(midX, b.y0 - 1, deepZ)).toBe(MAT_CONCRETE) // floor lining
    // fills: every pool basin, pond box, and beach ocean strip, in stamp order
    expect(waterFills.map((w) => w.box)).toEqual([
      ...layout.pools.map((p) => p.basin),
      ...layout.ponds.map((p) => p.box),
      ...layout.beaches.map((b) => b.ocean),
    ])
  })

  it('T69 beach/ocean district: sand, boardwalk, and shallow ocean fill are stamped', () => {
    expect(layout.districts.some((d) => d.kind === 'beach')).toBe(true)
    expect(layout.beaches.length).toBe(1)
    const beach = layout.beaches[0]
    const sx = beach.sand.x0 + 80
    // P7 — the beach now has inland dunes; check flat wet sand near the shore
    const sz = beach.ocean.z0 - 10
    expect(store.getVoxel(sx, g - 1, sz), 'sand surface').toBe(MAT_SAND) // B32 — real sand
    expect(store.getVoxel(sx, g, sz), 'walkable beach air').toBe(MAT_AIR)
    const bx = beach.boardwalk.x0 + 80
    const bz = (beach.boardwalk.z0 + beach.boardwalk.z1) >> 1
    expect([MAT_WOOD, MAT_ROOFTILE]).toContain(store.getVoxel(bx, g - 1, bz))
    const ox = beach.ocean.x0 + 80
    const oz = (beach.ocean.z0 + beach.ocean.z1) >> 1
    expect(store.getVoxel(ox, beach.ocean.y1, oz), 'ocean volume carved for water sim').toBe(MAT_AIR)
  })

  it('villa (B19): shallow + deep ends, paver deck, cabana with open front', () => {
    const v = layout.villa
    const pool = layout.pools.find((p) => p.lotId === v.lotId)!
    const sh = pool.shallow!
    const shX = (sh.x0 + sh.x1) >> 1
    const shZ = (sh.z0 + sh.z1) >> 1
    expect(store.getVoxel(shX, sh.y1, shZ), 'raised shallow floor').toBe(MAT_CONCRETE)
    expect(store.getVoxel(shX, sh.y1 + 1, shZ), 'water space above shallow floor').toBe(MAT_AIR)
    // deep end floor stays at basin bottom
    const deepZ = sh.z0 === pool.basin.z0 ? pool.basin.z1 - 2 : pool.basin.z0 + 2
    expect(store.getVoxel(shX, sh.y1, deepZ), 'deep end open at shallow-floor height').toBe(MAT_AIR)
    // deck apron surface around the basin
    expect([MAT_CONCRETE, MAT_ROOFTILE]).toContain(store.getVoxel(v.deck.x0 + 1, g - 1, (v.deck.z0 + v.deck.z1) >> 1))
    // cabana: plaster walls, wood roof, open front toward the pool
    const c = v.cabana
    const cMidZ = (c.z0 + c.z1) >> 1
    expect(store.getVoxel(c.x0, g + 3, c.z0 + 1)).toBe(MAT_PLASTER)
    expect(store.getVoxel((c.x0 + c.x1) >> 1, g + 22, cMidZ)).toBe(MAT_WOOD)
    const frontX = v.cabanaFront === 'x+' ? c.x1 : c.x0
    expect(store.getVoxel(frontX, g + 5, cMidZ), 'cabana open front').toBe(MAT_AIR)
  })

  it('nearest car props become drivable vehicles, the rest static voxel cars (B32)', () => {
    // WHY: parked cars must be enterable/drivable, but each live one is a Jolt
    // vehicle stepped every tick — at the 4× world we cap the live set to a
    // perf budget (48, nearest the centre) and stamp the remainder as static
    // voxel scenery. So we expect min(cars, 48) spawns, the near ones leaving
    // NO body voxels and the far ones DOING leave a stamped body.
    const cars = layout.props.filter((p) => isCarKind(p.kind))
    expect(cars.length).toBeGreaterThan(0)
    const REAL = 48
    expect(vehicleSpawns.length).toBe(Math.min(cars.length, REAL))
    // rank cars the same way the stamper does (distance to world centre)
    const cx0 = WORLD_VX / 2
    const cz0 = WORLD_VZ / 2
    const ranked = [...cars].sort(
      (a, b) => (a.x - cx0) ** 2 + (a.z - cz0) ** 2 - ((b.x - cx0) ** 2 + (b.z - cz0) ** 2) || a.x - b.x || a.z - b.z,
    )
    // the nearest car is a real vehicle (no stamped body)
    const near = ranked[0]
    expect(store.getVoxel(near.x + 5, near.y + 5, near.z + 5), 'nearest car is not stamped').toBe(MAT_AIR)
    const spawn = vehicleSpawns.find(
      (v) => v.archetype === near.kind
        && v.cx / VOXEL_SIZE > near.x && v.cx / VOXEL_SIZE < near.x + 44
        && v.cz / VOXEL_SIZE > near.z && v.cz / VOXEL_SIZE < near.z + 44,
    )
    expect(spawn, 'nearest car has a spawn request in its footprint').toBeTruthy()
    // if the world has more cars than the budget, the farthest is stamped solid
    if (cars.length > REAL) {
      const far = ranked[ranked.length - 1]
      expect([MAT_METAL, MAT_ROOFTILE, MAT_PLASTER]).toContain(store.getVoxel(far.x + 5, far.y + 5, far.z + 5))
    }
  })

  it('stairs: solid treads with capsule headroom and a carved ceiling opening (T41)', () => {
    // WHY: stairs exist so the player can WALK to the upper floor — each tread
    // must be solid, have 18 voxels (1.8 m capsule) of clear air above it, and
    // the upper slab must be opened where the head passes through its plane.
    const multi = layout.houses.filter((h) => h.floors > 1)
    expect(multi.length).toBeGreaterThan(0)
    for (const h of multi) {
      const s = h.stairs!
      const zc = (s.rect.z0 + s.rect.z1) >> 1
      const steps = h.storyH / 2 // STAIR_RISE
      for (let i = 0; i < steps; i++) {
        const top = g + (i + 1) * 2
        const x0 = s.dir === 1 ? s.rect.x0 + i * 3 : s.rect.x1 - i * 3 - 2
        const xc = x0 + 1
        expect(store.getVoxel(xc, top, zc), `tread ${i} top solid`).toBe(MAT_WOOD)
        for (let y = top + 1; y <= top + 18; y++) {
          expect(store.getVoxel(xc, y, zc), `air above tread ${i} at y=${y}`).toBe(MAT_AIR)
        }
      }
      // top step lands flush with the upper floor slab
      expect(g + steps * 2).toBe(g + h.storyH)
    }
  })

  it('T51 interiors: partition walls with door gaps, furniture inside rooms', () => {
    const h = layout.houses.find((x) => x.partitions.length > 0)!
    const p = h.partitions.find((x) => x.axis === 'x')!
    const base = g + p.floor * h.storyH
    // solid wall voxel away from the door gap
    const probeA = p.doorAt - 2 >= p.a0 ? p.doorAt - 2 : p.doorAt + DOOR_W + 2
    expect(store.getVoxel(probeA, base + 5, p.c), 'partition wall').toBe(MAT_PLASTER)
    expect(store.getVoxel(p.doorAt + 2, base + 5, p.c), 'partition door gap').toBe(MAT_AIR)
    // furniture: a table top is solid wood
    const table = layout.props.find((x) => x.kind === 'table')!
    expect(table).toBeTruthy()
    expect(store.getVoxel(table.x + 2, table.y + 4, table.z + 2), 'table top').toBe(MAT_WOOD)
    const bed = layout.props.find((x) => x.kind === 'bed')!
    expect(bed).toBeTruthy()
    expect(store.getVoxel(bed.x + 2, bed.y, bed.z + 4), 'bed frame').toBe(MAT_WOOD)
  })

  it('T51 garage: roll-door opening with metal lintel, connecting door to the house', () => {
    // garages are probabilistic per lot — find a seed that rolled one
    let found: { store: ChunkStore; h: House } | null = null
    for (const seed of [42, 7, 99, 1337]) {
      const s = seed === 42 ? { store, layout } : stamped(seed)
      const h = s.layout.houses.find((x) => x.garage)
      if (h) {
        found = { store: s.store, h }
        break
      }
    }
    expect(found, 'at least one garage across seeds').toBeTruthy()
    const { store: st, h } = found!
    const ga = h.garage!
    const frontZ = h.door.side === 'z-' ? ga.z0 : ga.z1
    // T59 — the roll door is up (air) or down (metal panel), per layout state
    expect(st.getVoxel(ga.x0 + 10, g + 5, frontZ), 'roll-door bay').toBe(h.garageOpen ? MAT_AIR : MAT_METAL)
    expect(st.getVoxel(ga.x0 + 10, g + 19, frontZ), 'metal lintel').toBe(MAT_METAL)
    expect(st.getVoxel(ga.x0 + 10, g + 24, (ga.z0 + ga.z1) >> 1), 'flat roof').toBe(MAT_CONCRETE)
    expect(st.getVoxel(ga.x0, g + 5, (ga.z0 + ga.z1) >> 1), 'side wall').toBe(h.wallMat)
  })

  it('T50 tower: concrete frame, glass curtain, slabs, core stairs and open shaft', () => {
    const t = layout.towers[0]
    const r = t.rect
    const wallTop = g + t.floors * t.storyH - 1
    // corner column concrete, curtain glass between mullions
    expect(store.getVoxel(r.x0, g + 12, r.z0)).toBe(MAT_CONCRETE)
    expect(store.getVoxel(r.x0 + 6, g + 12, r.z0), 'glass curtain').toBe(MAT_GLASS)
    // spandrel band at story base is concrete
    expect(store.getVoxel(r.x0 + 6, g + t.storyH + 2, r.z0)).toBe(MAT_CONCRETE)
    // interior slab at floor 1, clear interior air above it
    const midX = (r.x0 + r.x1) >> 1
    const midZ = (r.z0 + r.z1) >> 1
    expect(store.getVoxel(midX, g + t.storyH, midZ), 'floor-1 slab').toBe(MAT_CONCRETE)
    expect(store.getVoxel(midX, g + t.storyH + 8, midZ), 'floor-1 air').toBe(MAT_AIR)
    // roof + parapet
    expect(store.getVoxel(midX, wallTop + 1, midZ)).toBe(MAT_CONCRETE)
    expect(store.getVoxel(r.x0, wallTop + 3, r.z0)).toBe(MAT_CONCRETE)
    // entrance is carved open
    const frontLen = t.front === 'z-' || t.front === 'z+' ? r.x1 - r.x0 + 1 : r.z1 - r.z0 + 1
    const doorMid = (frontLen >> 1)
    const [ex, ez] =
      t.front === 'z-' ? [r.x0 + doorMid, r.z0]
      : t.front === 'z+' ? [r.x0 + doorMid, r.z1]
      : t.front === 'x-' ? [r.x0, r.z0 + doorMid]
      : [r.x1, r.z0 + doorMid]
    expect(store.getVoxel(ex, g + 8, ez), 'entrance open').toBe(MAT_AIR)
    // elevator shaft: void from ground to top, metal guard beside it
    const shX = (t.shaft.x0 + t.shaft.x1) >> 1
    const shZ = (t.shaft.z0 + t.shaft.z1) >> 1
    expect(store.getVoxel(shX, g + t.storyH, shZ), 'shaft void through slab').toBe(MAT_AIR)
    expect(store.getVoxel(shX, wallTop - 2, shZ), 'shaft void at top').toBe(MAT_AIR)
    const stairZ = (t.stairs.z0 + t.stairs.z1) >> 1
    expect(store.getVoxel(t.shaft.x0 - 1, g + 5, stairZ), 'shaft guard wall').toBe(MAT_METAL)
    // stair treads: solid concrete columns rising through the core
    for (let i = 0; i < 4; i++) {
      const top = g + (i + 1) * 2
      const x0 = t.stairs.x0 + i * STAIR_TREAD
      expect(store.getVoxel(x0 + 1, top, stairZ), `tower tread ${i}`).toBe(MAT_CONCRETE)
      expect(store.getVoxel(x0 + 1, top + 10, stairZ), `air above tread ${i}`).toBe(MAT_AIR)
    }
    // slab above the stair run is carved open (you can actually ascend);
    // probe over tread 0 — the TOP tread is intentionally flush with the slab
    expect(store.getVoxel(t.stairs.x0 + 1, g + t.storyH, stairZ), 'stairwell opening').toBe(MAT_AIR)
  })

  it('T50 rowhouse: party walls, doors + stoops, windows, switchback stairs, stepped roofs', () => {
    const b = layout.rowBlocks[0]
    const u = b.units[0]
    const frontZneg = b.front === 'z-'
    const frontZ = frontZneg ? b.rect.z0 : b.rect.z1
    const w = u.x1 - u.x0 + 1
    const doorOff = (w - DOOR_W) >> 1
    expect(store.getVoxel(u.x0, g + 5, (b.rect.z0 + b.rect.z1) >> 1), 'party wall').toBe(u.wallMat)
    expect(store.getVoxel(u.x0 + doorOff + 4, g + 5, frontZ), 'front door open').toBe(MAT_AIR)
    expect(store.getVoxel(u.x0 + ((w / 4) | 0) - 2, g + b.storyH + 15, frontZ), 'floor-1 window').toBe(MAT_GLASS)
    // stoop in front of the door
    const stoopZ = frontZneg ? b.rect.z0 - 2 : b.rect.z1 + 2
    expect(store.getVoxel(u.x0 + doorOff + 4, g, stoopZ)).toBe(MAT_CONCRETE)
    // roof at the unit's own height (stepped rooflines)
    const wallTop = g + u.floors * b.storyH - 1
    expect(store.getVoxel((u.x0 + u.x1) >> 1, wallTop + 1, (b.rect.z0 + b.rect.z1) >> 1)).toBe(MAT_CONCRETE)
    // first stair tread near the back (dir=1 run for floor 0)
    const iz1 = b.rect.z1 - WALL_T
    const runZ0 = iz1 - STAIR_TREAD * STAIR_STEPS + 1
    expect(store.getVoxel(u.x0 + WALL_T + 2, g + 2, runZ0 + 1), 'rowhouse tread 0').toBe(MAT_WOOD)
    expect(STAIR_W).toBeGreaterThan(0)
  })

  it('T50 parking lot: asphalt slab with painted stalls, cars parked', () => {
    expect(layout.parking.length).toBeGreaterThan(0)
    const lot = layout.parking[0].rect
    const midZ = (lot.z0 + lot.z1) >> 1
    expect(store.getVoxel((lot.x0 + lot.x1) >> 1, g - 1, midZ)).toBe(MAT_ASPHALT)
    // first stall line painted along the z- row
    expect(store.getVoxel(lot.x0 + 4, g - 1, lot.z0 + 5)).toBe(MAT_PAINT)
    // some cars stand in commercial stalls
    const carsInLots = layout.props.filter(
      (p) => isCarKind(p.kind) && p.x >= lot.x0 && p.x <= lot.x1 && p.z >= lot.z0 && p.z <= lot.z1,
    )
    expect(carsInLots.length).toBeGreaterThan(0)
  })

  it('T50 pond: dug into the meadow, dirt bottom, box matches the dug volume', () => {
    expect(layout.ponds.length).toBeGreaterThan(0)
    const p = layout.ponds[0]
    const l0 = p.lobes[0]
    expect(store.getVoxel(l0.x, g - 1, l0.z), 'pond center dug').toBe(MAT_AIR)
    expect(store.getVoxel(l0.x, g - p.depth - 1, l0.z), 'solid below max depth').not.toBe(MAT_AIR)
    // fill box: top leaves freeboard below the surface
    expect(p.box.y1).toBeLessThan(g)
    // park path is walkable pavers
    const path = layout.parkPaths[0]
    expect([MAT_CONCRETE, MAT_ROOFTILE]).toContain(store.getVoxel((path.x0 + path.x1) >> 1, g - 1, (path.z0 + path.z1) >> 1))
  })

  it('paint claims material id 15: white ramp, strength 1 (T43, V13)', () => {
    // WHY: id 15 was the last reserved slot — its assignment is baked into
    // stamped worlds forever; render/physics derive from this single entry.
    expect(MAT_PAINT).toBe(15)
    const paint = MATERIALS[15]!
    expect(paint.id).toBe(15)
    expect(paint.name).toBe('paint')
    expect(paint.strength).toBe(1)
    expect(paint.colorRamp[0]).toBe(0xf0f0ea)
    expect(paint.colorRamp[1]).toBe(0xffffff)
    expect(paint.flags).toBe(MatFlags.None)
    expect(paint.density).toBeGreaterThan(0)
  })

  it('road markings: dashes, arterial double line, crosswalks — paint ONLY on asphalt (T43/T50)', () => {
    // WHY: markings are stamped 1 voxel deep into the road surface — paint
    // anywhere else (grass, sidewalk) means the asphalt guard regressed.
    // Parking stalls are painted asphalt too, so scan against BOTH.
    const paintable = [
      ...layout.roads.map((r) => r.asphalt),
      ...layout.parking.map((p) => p.rect),
      ...layout.airports.map((a) => a.runway), // B32 — runway centre/threshold paint
    ]
    let paint = 0
    for (let z = 0; z < WORLD_VZ; z += 1) {
      for (let x = 0; x < WORLD_VX; x += 1) {
        if (store.getVoxel(x, g - 1, z) !== MAT_PAINT) continue
        paint++
        const onRoad = paintable.some((a) => x >= a.x0 && x <= a.x1 && z >= a.z0 && z <= a.z1)
        if (!onRoad) expect.fail(`paint at (${x},${z}) off the asphalt`)
      }
    }
    expect(paint).toBeGreaterThan(2000) // dashes + 25 intersections + stalls
    // residential center dash: 2-wide line at the road center
    const resRoad = layout.roads.find((r) => r.axis === 'x' && r.kind === 'res')!
    let dash = 0
    for (let x = 0; x < WORLD_VX; x++) {
      if (store.getVoxel(x, g - 1, resRoad.center) === MAT_PAINT) dash++
    }
    expect(dash).toBeGreaterThan(100)
    // arterial: double solid center line (offset ±: c-2 and c+1)
    const art = layout.roads.find((r) => r.axis === 'x' && r.kind === 'arterial')!
    let solidA = 0
    let solidB = 0
    // B32 — scan a 200-voxel span clear of any cross-road so the double line
    // reads as continuously solid. The center line clears a margin around each
    // junction box; the first block right of the crossing (CVX+80..CVX+280) is
    // fully painted asphalt between the center crossing and the next z-road.
    for (let x = CVX + 80; x < CVX + 280; x++) {
      if (store.getVoxel(x, g - 1, art.center - 2) === MAT_PAINT) solidA++
      if (store.getVoxel(x, g - 1, art.center + 1) === MAT_PAINT) solidB++
    }
    expect(solidA).toBe(200) // solid, not dashed
    expect(solidB).toBe(200)
    // crosswalk band on the east approach of the central crossing (B32: SPAWN)
    const ex = CVX + 52 // arterial extent at the central crossing
    let zebra = 0
    for (let z = CVX - 38; z <= CVX + 38; z++) {
      for (let x = ex + 2; x <= ex + 9; x++) {
        if (store.getVoxel(x, g - 1, z) === MAT_PAINT) zebra++
      }
    }
    expect(zebra).toBeGreaterThan(50)
  })

  it('trees: wood trunk rooted in the ground with a leaf canopy above (T42)', () => {
    // WHY: trees are plain destructible voxels — trunk must connect ground →
    // canopy so connectivity can fell them as one piece.
    expect(layout.trees.length).toBeGreaterThan(0)
    for (const t of layout.trees.slice(0, 8)) {
      expect(store.getVoxel(t.x, g, t.z), `trunk base (${t.x},${t.z})`).toBe(MAT_WOOD)
      expect(store.getVoxel(t.x, g + t.trunkH - 1, t.z), 'trunk top').toBe(MAT_WOOD)
      // canopy: some leaves in the blob around the trunk top
      let leaves = 0
      const cy = g + t.trunkH + (t.canopyR >> 1) - 1
      for (let y = cy - 2; y <= cy + 2; y++)
        for (let z = t.z - 3; z <= t.z + 3; z++)
          for (let x = t.x - 3; x <= t.x + 3; x++) {
            if (store.getVoxel(x, y, z) === MAT_LEAVES) leaves++
          }
      expect(leaves, `canopy leaves near (${t.x},${t.z})`).toBeGreaterThan(10)
    }
    // shrubs: leafy mound on the grass
    expect(layout.shrubs.length).toBeGreaterThan(0)
    const s = layout.shrubs[0]
    expect(store.getVoxel(s.x, g + 1, s.z)).toBe(MAT_LEAVES)
  })

  it('street furniture: fences, lamp posts, mailboxes, bins stamped (T43)', () => {
    expect(layout.fences.length).toBeGreaterThan(0)
    for (const f of layout.fences.slice(0, 6)) {
      expect(store.getVoxel(f.x0, g, f.z0), 'fence post base').toBe(MAT_WOOD)
      expect(store.getVoxel(f.x0, g + 10, f.z0), 'fence post top').toBe(MAT_WOOD)
    }
    expect(layout.lamps.length).toBeGreaterThan(10)
    // road lamps are appended last — they stand on the sidewalk
    for (const l of layout.lamps.slice(-6)) {
      expect(store.getVoxel(l.x, g, l.z), 'lamp pole base').toBe(MAT_METAL)
      expect(store.getVoxel(l.x, g + 23, l.z), 'lamp pole top').toBe(MAT_METAL)
      const dx = l.dir === 'x-' ? -1 : l.dir === 'x+' ? 1 : 0
      const dz = l.dir === 'z-' ? -1 : l.dir === 'z+' ? 1 : 0
      expect(store.getVoxel(l.x + dx * 3, g + 22, l.z + dz * 3), 'emissive head').toBe(MAT_LAMP)
      expect(store.getVoxel(l.x, g - 1, l.z), 'lamp stands on the sidewalk').toBe(MAT_CONCRETE)
    }
    expect(layout.mailboxes.length).toBe(layout.houses.length)
    for (const m of layout.mailboxes.slice(0, 6)) {
      // T59 — style 0 = wood post, style 1 = brick pedestal
      expect(store.getVoxel(m.x, g, m.z), 'mailbox base').toBe(m.style === 1 ? MAT_BRICK : MAT_WOOD)
      expect(store.getVoxel(m.x, g + 11, m.z), 'mailbox box').toBe(MAT_METAL)
    }
    expect(layout.bins.length).toBeGreaterThan(0)
    const b = layout.bins[0]
    expect(store.getVoxel(b.x, g + 2, b.z)).toBe(MAT_METAL)
  })

  it('house detail: garden path pavers, porches, shutters appear (T43)', () => {
    // every house has a paver path reaching the front lot edge
    for (const h of layout.houses.slice(0, 4)) {
      const midZ = (h.path.z0 + h.path.z1) >> 1
      const surf = store.getVoxel(h.path.x0 + 1, g - 1, midZ)
      expect([MAT_ROOFTILE, MAT_CONCRETE], 'path pavers').toContain(surf)
    }
    const porched = layout.houses.find((h) => h.porch)
    expect(porched, 'some house should have a porch').toBeTruthy()
    const p = porched!.porch!
    expect(store.getVoxel((p.x0 + p.x1) >> 1, g, (p.z0 + p.z1) >> 1)).toBe(MAT_CONCRETE)
    // roof variation: at least one rooftile pitched roof across the suburb
    const tiled = layout.houses.find((h) => h.roof !== 'flat' && h.roofMat === 12)
    expect(tiled, 'some pitched roof should use rooftile').toBeTruthy()
  })

  it('is deterministic: same seed → identical chunk hash; different seed differs', () => {
    const a = stamped(42)
    expect(hashStore(a.store)).toBe(hashStore(store))
    const b = stamped(43)
    expect(hashStore(b.store)).not.toBe(hashStore(store))
  })

  it('fails loud on missing prop grids', () => {
    const s = new ChunkStore()
    expect(() => stampScene(s, layout, {})).toThrow(/no voxel grid/)
  })
})
