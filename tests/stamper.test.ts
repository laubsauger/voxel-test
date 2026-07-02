import { describe, expect, it } from 'vitest'
import { ChunkStore, ChunkKind, CHUNK_COUNT } from '../src/world/chunks'
import { Fnv } from '../src/sim/hash'
import { generateLayout, type House, type Layout, type Opening } from '../src/sim/gen/layout'
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

function stamped(seed: number): { store: ChunkStore; layout: Layout; waterFills: { box: { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number } }[] } {
  const store = new ChunkStore()
  const layout = generateLayout(seed)
  const { waterFills } = stampScene(store, layout, placeholderProps())
  return { store, layout, waterFills }
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

describe('scene stamper (T20, V2, V5)', () => {
  const { store, layout, waterFills } = stamped(42)
  const g = layout.groundY

  it('terrain: grass surface over dirt, ground band respected', () => {
    expect(store.getVoxel(10, g - 1, 10)).toBe(MAT_GRASS)
    expect(store.getVoxel(10, g - 5, 10)).toBe(MAT_DIRT)
    expect(store.getVoxel(10, 0, 10)).toBe(MAT_DIRT)
  })

  it('roads are asphalt, sidewalks concrete, at surface level', () => {
    const road = layout.roads.find((r) => r.axis === 'x')!
    // probe off the 2-voxel center line (which may carry a paint dash, T43)
    expect(store.getVoxel(300, g - 1, road.center + 5)).toBe(MAT_ASPHALT)
    expect(store.getVoxel(300, g - 1, road.sidewalks[0].z0 + 1)).toBe(MAT_CONCRETE)
    expect(store.getVoxel(300, g, road.center)).toBe(MAT_AIR) // road surface is walkable
  })

  it('house: walls are brick/plaster, wood floor slab, hollow interior, doors open, windows glazed', () => {
    const h = layout.houses[0]
    const midX = (h.rect.x0 + h.rect.x1) >> 1
    const midZ = (h.rect.z0 + h.rect.z1) >> 1
    expect([MAT_BRICK, MAT_PLASTER]).toContain(h.wallMat)
    expect(store.getVoxel(h.rect.x0, g + 5, midZ)).toBe(h.wallMat) // x- wall below sill height
    expect(store.getVoxel(midX, g, midZ)).toBe(MAT_WOOD) // floor slab
    expect(store.getVoxel(midX, g + 10, midZ)).toBe(MAT_AIR) // hollow interior
    const [dx, dy, dz] = openingProbe(h, h.door, g)
    expect(store.getVoxel(dx, dy, dz)).toBe(MAT_AIR) // door carved through wall
    const [wx, wy, wz] = openingProbe(h, h.windows[0], g)
    expect(store.getVoxel(wx, wy, wz)).toBe(MAT_GLASS)
    // roof exists above the top story
    const roofY = g + h.floors * h.storyH
    expect(store.getVoxel(midX, roofY, midZ)).toBe(h.roof === 'flat' ? MAT_CONCRETE : MAT_WOOD)
  })

  it('driveways are concrete', () => {
    const h = layout.houses[0]
    const midX = (h.driveway.x0 + h.driveway.x1) >> 1
    const midZ = (h.driveway.z0 + h.driveway.z1) >> 1
    expect(store.getVoxel(midX, g - 1, midZ)).toBe(MAT_CONCRETE)
  })

  it('pools: concrete-lined basin, interior air, water fill requested as data', () => {
    expect(layout.pools.length).toBeGreaterThan(0)
    const b = layout.pools[0].basin
    const midX = (b.x0 + b.x1) >> 1
    const midY = (b.y0 + b.y1) >> 1
    const midZ = (b.z0 + b.z1) >> 1
    expect(store.getVoxel(midX, midY, midZ)).toBe(MAT_AIR) // dug empty
    expect(store.getVoxel(b.x0 - 1, midY, midZ)).toBe(MAT_CONCRETE) // side lining
    expect(store.getVoxel(midX, b.y0 - 1, midZ)).toBe(MAT_CONCRETE) // floor lining
    expect(waterFills.map((w) => w.box)).toEqual(layout.pools.map((p) => p.basin))
  })

  it('placeholder car props are stamped (metal body on the driveway)', () => {
    expect(layout.props.length).toBeGreaterThan(0)
    const p = layout.props[0]
    // body spans nearly the whole footprint at y+5 for rot 0 and 2
    expect(store.getVoxel(p.x + 5, p.y + 5, p.z + 5)).toBe(MAT_METAL)
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
      // upper floor next to the opening is still walkable slab
      const midX = (h.rect.x0 + h.rect.x1) >> 1
      const midZ = (h.rect.z0 + h.rect.z1) >> 1
      expect(store.getVoxel(midX, g + h.storyH, midZ)).toBe(MAT_WOOD)
    }
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

  it('road markings: dashes + crosswalks exist, paint ONLY on asphalt (T43)', () => {
    // WHY: markings are stamped 1 voxel deep into the road surface — paint
    // anywhere else (grass, sidewalk) means the asphalt guard regressed.
    const asphalt = layout.roads.map((r) => r.asphalt)
    let paint = 0
    for (let z = 0; z < 1024; z++) {
      for (let x = 0; x < 1024; x++) {
        if (store.getVoxel(x, g - 1, z) !== MAT_PAINT) continue
        paint++
        const onRoad = asphalt.some((a) => x >= a.x0 && x <= a.x1 && z >= a.z0 && z <= a.z1)
        expect(onRoad, `paint at (${x},${z}) off the asphalt`).toBe(true)
      }
    }
    expect(paint).toBeGreaterThan(500) // dashes + 9 intersections of zebra stripes
    // center dash: 2-wide line at the road center, away from intersections
    const xRoad = layout.roads.find((r) => r.axis === 'x')!
    let dash = 0
    for (let x = 0; x < 1024; x++) {
      if (store.getVoxel(x, g - 1, xRoad.center) === MAT_PAINT) dash++
    }
    expect(dash).toBeGreaterThan(50)
    // crosswalk band near the center intersection (east approach, past the
    // crossing sidewalk: x ∈ [512+44 .. 512+51])
    let zebra = 0
    for (let z = 512 - 28; z <= 512 + 28; z++) {
      for (let x = 556; x <= 563; x++) {
        if (store.getVoxel(x, g - 1, z) === MAT_PAINT) zebra++
      }
    }
    expect(zebra).toBeGreaterThan(50)
  })

  it('street furniture: fences, lamp posts, mailboxes, bins stamped (T43)', () => {
    expect(layout.fences.length).toBeGreaterThan(0)
    for (const f of layout.fences.slice(0, 6)) {
      expect(store.getVoxel(f.x0, g, f.z0), 'fence post base').toBe(MAT_WOOD)
      expect(store.getVoxel(f.x0, g + 10, f.z0), 'fence post top').toBe(MAT_WOOD)
    }
    expect(layout.lamps.length).toBeGreaterThan(10)
    for (const l of layout.lamps.slice(0, 6)) {
      expect(store.getVoxel(l.x, g, l.z), 'lamp pole base').toBe(MAT_METAL)
      expect(store.getVoxel(l.x, g + 23, l.z), 'lamp pole top').toBe(MAT_METAL)
      const dx = l.dir === 'x-' ? -1 : l.dir === 'x+' ? 1 : 0
      const dz = l.dir === 'z-' ? -1 : l.dir === 'z+' ? 1 : 0
      expect(store.getVoxel(l.x + dx * 3, g + 22, l.z + dz * 3), 'emissive head').toBe(MAT_LAMP)
      // lamp stands on the sidewalk
      expect(store.getVoxel(l.x, g - 1, l.z)).toBe(MAT_CONCRETE)
    }
    expect(layout.mailboxes.length).toBe(layout.houses.length)
    for (const m of layout.mailboxes.slice(0, 6)) {
      expect(store.getVoxel(m.x, g, m.z), 'mailbox post').toBe(MAT_WOOD)
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
      expect([MAT_BRICK, MAT_CONCRETE], 'path pavers').toContain(surf)
    }
    const porched = layout.houses.find((h) => h.porch)
    expect(porched, 'some house should have a porch').toBeTruthy()
    const p = porched!.porch!
    expect(store.getVoxel((p.x0 + p.x1) >> 1, g, (p.z0 + p.z1) >> 1)).toBe(MAT_CONCRETE)
    // roof variation: at least one rooftile gable across the suburb
    const tiled = layout.houses.find((h) => h.roof === 'gable' && h.roofMat === 12)
    expect(tiled, 'some gable should use rooftile').toBeTruthy()
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
