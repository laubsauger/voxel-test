/**
 * T70 — base-map draw-command generation. WHY: the base canvas is drawn once
 * at boot from layout data, so the command list IS the map. These tests pin
 * (a) determinism — same layout, same commands, byte for byte (the map may
 * never flicker between boots of the same seed), (b) completeness — every
 * road/house/pool the generator emits must appear on the map (a map that
 * silently drops features is worse than no map), and (c) Google-style layer
 * order — casings under fills is what makes intersections read as one road
 * network. Canvas pixels are NOT tested (node has no canvas; executor is a
 * thin switch).
 */
import { describe, expect, it } from 'vitest'
import { generateLayout } from '../src/sim/gen/layout'
import { WORLD_VX, WORLD_VZ } from '../src/world/chunks'
import { buildMapCommands, type DrawCmd, type MapLayout } from '../src/ui/map/map-render'
import { MAP_INK, DISTRICT_STYLES, districtStyle, roadStyle } from '../src/ui/map/map-style'

const DIMS = { vx: WORLD_VX, vz: WORLD_VZ }
const layout = generateLayout(1337)

describe('buildMapCommands — determinism digest', () => {
  it('same layout ⇒ identical command list (stable JSON digest)', () => {
    const a = buildMapCommands(layout, DIMS)
    const b = buildMapCommands(generateLayout(1337), DIMS)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('different seed ⇒ different map (commands actually depend on layout)', () => {
    const a = buildMapCommands(layout, DIMS)
    const b = buildMapCommands(generateLayout(42), DIMS)
    expect(JSON.stringify(a.cmds)).not.toBe(JSON.stringify(b.cmds))
  })
})

describe('buildMapCommands — completeness', () => {
  const list = buildMapCommands(layout, DIMS)
  const fills = (color: string) =>
    list.cmds.filter((c) => (c.op === 'rect' || c.op === 'rrect' || c.op === 'circle') && 'fill' in c && c.fill === color)

  it('canvas covers the full world at the projection scale', () => {
    expect(list.width).toBe(WORLD_VX * 2)
    expect(list.height).toBe(WORLD_VZ * 2)
    const bg = list.cmds[0]
    expect(bg.op).toBe('rect')
    if (bg.op === 'rect') expect([bg.w, bg.h]).toEqual([list.width, list.height])
  })

  it('every road contributes one casing and one fill; every sidewalk drawn', () => {
    expect(fills(roadStyle(undefined).fill).length).toBe(layout.roads.length)
    expect(fills(roadStyle(undefined).casing).length).toBe(layout.roads.length)
    expect(fills(MAP_INK.sidewalk).length).toBe(layout.roads.length * 2)
  })

  it('every house footprint (+ ell) appears as a building fill', () => {
    const bld = fills(DISTRICT_STYLES.suburban.building)
    const expected = layout.houses.length + layout.houses.filter((h) => h.ell).length
    expect(bld.length).toBe(expected)
  })

  it('every pool appears as water, every tree as a canopy dot', () => {
    expect(fills(MAP_INK.waterFill).length).toBe(layout.pools.length)
    expect(list.cmds.filter((c) => c.op === 'circle').length).toBe(layout.trees.length)
  })

  it('emits a district label even when the layout has no districts yet', () => {
    const labels = list.cmds.filter((c) => c.op === 'label')
    expect(labels.length).toBe(1)
    if (labels[0].op === 'label') expect(labels[0].text).toBe(DISTRICT_STYLES.suburban.label)
  })

  it('all geometry lands on the canvas (nothing projected out of bounds)', () => {
    const margin = 8 // casing overhang
    for (const c of list.cmds) {
      if (c.op === 'rect' || c.op === 'rrect') {
        expect(c.x).toBeGreaterThanOrEqual(-margin)
        expect(c.y).toBeGreaterThanOrEqual(-margin)
        expect(c.x + c.w).toBeLessThanOrEqual(list.width + margin)
        expect(c.y + c.h).toBeLessThanOrEqual(list.height + margin)
      }
    }
  })
})

describe('buildMapCommands — layer order (Google-style road merging)', () => {
  const list = buildMapCommands(layout, DIMS)
  const lastIndex = (pred: (c: DrawCmd) => boolean) => list.cmds.map(pred).lastIndexOf(true)
  const firstIndex = (pred: (c: DrawCmd) => boolean) => list.cmds.findIndex(pred)
  const isFill = (c: DrawCmd, color: string) => 'fill' in c && c.fill === color

  it('ALL casings precede ALL road fills (intersections merge seamlessly)', () => {
    expect(lastIndex((c) => isFill(c, roadStyle(undefined).casing))).toBeLessThan(
      firstIndex((c) => isFill(c, roadStyle(undefined).fill)),
    )
  })

  it('buildings render above roads/water, labels above everything', () => {
    expect(firstIndex((c) => isFill(c, DISTRICT_STYLES.suburban.building))).toBeGreaterThan(
      lastIndex((c) => isFill(c, roadStyle(undefined).fill)),
    )
    expect(firstIndex((c) => c.op === 'label')).toBeGreaterThan(lastIndex((c) => c.op !== 'label'))
  })
})

describe('T50 forward-compat (districts table-driven by kind string)', () => {
  it('unknown district kinds get the default style + derived label', () => {
    const s = districtStyle('beach_front')
    expect(s.ground).toBe(DISTRICT_STYLES.suburban.ground)
    expect(s.label).toBe('BEACH FRONT')
  })

  it('district-aware layouts tint lots/buildings per district and label each', () => {
    const fake: MapLayout = {
      roads: [],
      districts: [
        { kind: 'commercial', rect: { x0: 0, z0: 0, x1: 511, z1: 1023 } },
        { kind: 'park', rect: { x0: 512, z0: 0, x1: 1023, z1: 1023 }, name: 'POND PARK' },
      ],
      lots: [{ rect: { x0: 10, z0: 10, x1: 100, z1: 100 } }],
      buildings: [{ rect: { x0: 600, z0: 40, x1: 700, z1: 90 } }],
      ponds: [{ rect: { x0: 700, z0: 700, x1: 900, z1: 860 } }],
    }
    const list = buildMapCommands(fake, { vx: 1024, vz: 1024 })
    const has = (color: string) => list.cmds.some((c) => 'fill' in c && c.fill === color)
    expect(has(DISTRICT_STYLES.commercial.lot)).toBe(true) // lot tinted by ITS district
    expect(has(DISTRICT_STYLES.park.building)).toBe(true) // building tinted by ITS district
    expect(has(MAP_INK.waterFill)).toBe(true) // pond renders as water
    const labels = list.cmds.filter((c) => c.op === 'label').map((c) => (c.op === 'label' ? c.text : ''))
    expect(labels).toEqual(['DOWNTOWN', 'POND PARK'])
  })
})
