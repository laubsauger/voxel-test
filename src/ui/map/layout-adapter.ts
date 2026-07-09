import type { Layout } from '../../sim/gen/layout'
import type { MapLayout } from './map-render'

/**
 * Real T50 Layout → MapLayout. The map renderer predates T50 and keys on
 * generic shapes: towers/rowBlocks become 'buildings' (styled by kind),
 * pond fill boxes flatten to rects, bare park-path rects get wrapped.
 */
export function adaptLayout(l: Layout): MapLayout & { seed?: number } {
  return {
    ...l,
    // T68 — hood lots render as parcels alongside the suburb lots (the hood
    // district style tints them via the point-in-district lookup)
    lots: [...l.lots, ...l.hoods.flatMap((h) => h.lots.map((lot, i) => ({ id: -1 - i, rect: lot.rect, front: lot.front })))],
    buildings: [
      ...l.towers.map((t) => ({ rect: t.rect, kind: 'tower' })),
      ...l.rowBlocks.map((r) => ({ rect: r.rect, kind: 'rowhouse' })),
      // T68 — hood buildings (worn houses + corner store)
      ...l.hoods.flatMap((h) => h.lots.filter((lot) => lot.house).map((lot) => ({ rect: lot.house as NonNullable<typeof lot.house>, kind: 'hood' }))),
    ],
    ponds: l.ponds.map((p) => ({
      rect: { x0: p.box.x0, z0: p.box.z0, x1: p.box.x1, z1: p.box.z1 },
    })),
    beaches: l.beaches.map((b) => ({
      sand: b.sand,
      boardwalk: b.boardwalk,
      ocean: { x0: b.ocean.x0, z0: b.ocean.z0, x1: b.ocean.x1, z1: b.ocean.z1 },
    })),
    parkPaths: l.parkPaths.map((rect) => ({ rect })),
  }
}
