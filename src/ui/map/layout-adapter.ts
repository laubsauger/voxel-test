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
    buildings: [
      ...l.towers.map((t) => ({ rect: t.rect, kind: 'tower' })),
      ...l.rowBlocks.map((r) => ({ rect: r.rect, kind: 'rowhouse' })),
    ],
    ponds: l.ponds.map((p) => ({
      rect: { x0: p.box.x0, z0: p.box.z0, x1: p.box.x1, z1: p.box.z1 },
    })),
    parkPaths: l.parkPaths.map((rect) => ({ rect })),
  }
}
