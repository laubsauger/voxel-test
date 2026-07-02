/**
 * T35 — region batching math. Draw calls scale with regions, not chunks
 * (B2: 2437 per-chunk meshes × 4 passes = 23fps). Every chunk must map to
 * exactly one region and the region grid must invert consistently — a wrong
 * mapping merges a chunk into the wrong region mesh at the wrong offset.
 */
import { describe, expect, it } from 'vitest'
import { REGION, regionCoords, regionIndex } from '../src/render/chunk-mesh-manager'
import { chunkCoords } from '../src/render/remesh-scheduler'
import { ChunkKind, ChunkStore, CHUNK_COUNT, WORLD_CX, WORLD_CY, WORLD_CZ } from '../src/world/chunks'
import { generateLayout } from '../src/sim/gen/layout'
import { stampScene } from '../src/sim/gen/stamper'
import { placeholderProps } from '../src/sim/gen/props'

describe('T35 region batching', () => {
  it('maps every chunk into the region containing its coords', () => {
    for (let ci = 0; ci < CHUNK_COUNT; ci++) {
      const [cx, cy, cz] = chunkCoords(ci)
      const [rx, ry, rz] = regionCoords(regionIndex(ci))
      expect(rx).toBe(Math.floor(cx / REGION))
      expect(ry).toBe(Math.floor(cy / REGION))
      expect(rz).toBe(Math.floor(cz / REGION))
    }
  })

  it('region grid partitions the world exactly', () => {
    const regions = new Set<number>()
    for (let ci = 0; ci < CHUNK_COUNT; ci++) regions.add(regionIndex(ci))
    expect(regions.size).toBe(
      Math.ceil(WORLD_CX / REGION) * Math.ceil(WORLD_CY / REGION) * Math.ceil(WORLD_CZ / REGION),
    )
  })

  it('bounds draw calls: the STAMPED town occupies few enough regions for the fps budget', () => {
    // WHY: empty regions produce no meshes and no draws — the real draw-call
    // count scales with regions that contain non-empty chunks. The T50 world
    // is 8× the volume, but occupancy stays a thin populated slab + towers.
    // The smoke fps gate (≥30, target 60) is the runtime ground truth; this
    // bound catches procgen changes that would blow the draw budget.
    const store = new ChunkStore()
    stampScene(store, generateLayout(1337), placeholderProps())
    const occupied = new Set<number>()
    for (let ci = 0; ci < CHUNK_COUNT; ci++) {
      if (store.chunkAt(ci).kind !== ChunkKind.Empty) occupied.add(regionIndex(ci))
    }
    // main pass + 3 CSM cascades
    expect(occupied.size * 4).toBeLessThanOrEqual(1600)
  })
})
