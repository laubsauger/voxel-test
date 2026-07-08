import { describe, expect, it } from 'vitest'
import { ChunkKind, CHUNK_COUNT, WORLD_CX, WORLD_CZ } from '../src/world/chunks'
import { generateLayout } from '../src/sim/gen/layout'
import { stampScene } from '../src/sim/gen/stamper'
import { placeholderProps } from '../src/sim/gen/props'
import { ChunkStore } from '../src/world/chunks'

// T97/V21 — 256-chunk world boot health. The dense store must palette-compact
// to a sparse footprint right after the stamp (Game.create runs this sweep),
// P22 road parity must hold, and the layout stays deterministic at new dims.

describe('world resize 256 (T97, V21)', () => {
  it('WORLD dims are 256 and the P22 odd-road-parity invariant holds', () => {
    expect(WORLD_CX).toBe(256)
    expect(WORLD_CZ).toBe(256)
    const l = generateLayout(7)
    const xRoads = l.roads.filter((r) => r.axis === 'x').length
    const zRoads = l.roads.filter((r) => r.axis === 'z').length
    expect(xRoads % 2).toBe(1) // odd → a center road exists (P22 parity)
    expect(zRoads % 2).toBe(1)
  })

  it('layout deterministic at new dims (same seed ⇒ identical layout)', () => {
    expect(JSON.stringify(generateLayout(1337))).toBe(JSON.stringify(generateLayout(1337)))
  })

  it('full compactStep sweep after stampScene leaves ~no Dense chunks (V21 boot memory)', () => {
    const store = new ChunkStore()
    const layout = generateLayout(7)
    stampScene(store, layout, placeholderProps())
    // the same sweep Game.create runs at boot — ignoreDirty=true is the point:
    // at that stage the dirty set covers the whole stamped world and the
    // default skip would compress NOTHING (the bug this test pins)
    for (let swept = 0; swept < CHUNK_COUNT; swept += 65536) store.compactStep(65536, 65536, true)
    let dense = 0
    let nonEmpty = 0
    for (let i = 0; i < CHUNK_COUNT; i++) {
      const k = store.chunkAtRaw(i).kind // raw — chunkAt would inflate what we count
      if (k !== ChunkKind.Empty) nonEmpty++
      if (k === ChunkKind.Dense) dense++
    }
    expect(nonEmpty).toBeGreaterThan(1000) // sanity: a real world got stamped
    expect(dense).toBe(0) // every dense chunk palette-compressed
    // reads stay correct through the compressed store (bit-unpack path)
    expect(store.getVoxel(100, layout.groundY - 1, 100)).not.toBe(0)
  }, 120000)
})
