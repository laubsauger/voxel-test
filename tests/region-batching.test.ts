/**
 * T35 — region batching math. Draw calls scale with regions, not chunks
 * (B2: 2437 per-chunk meshes × 4 passes = 23fps). Every chunk must map to
 * exactly one region and the region grid must invert consistently — a wrong
 * mapping merges a chunk into the wrong region mesh at the wrong offset.
 */
import { describe, expect, it } from 'vitest'
import { REGION, regionCoords, regionIndex } from '../src/render/chunk-mesh-manager'
import { chunkCoords } from '../src/render/remesh-scheduler'
import { CHUNK_COUNT, WORLD_CX, WORLD_CY, WORLD_CZ } from '../src/world/chunks'

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

  it('bounds draw calls: region count is ~REGION³ below chunk count', () => {
    const regions = new Set<number>()
    for (let ci = 0; ci < CHUNK_COUNT; ci++) regions.add(regionIndex(ci))
    expect(regions.size).toBe(
      Math.ceil(WORLD_CX / REGION) * Math.ceil(WORLD_CY / REGION) * Math.ceil(WORLD_CZ / REGION),
    )
    // the whole arena fits in few enough regions to hit the §C 60fps budget
    // even with every region drawn in all 4 passes (main + 3 CSM cascades)
    expect(regions.size * 4).toBeLessThanOrEqual(1200)
  })
})
