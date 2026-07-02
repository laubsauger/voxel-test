import type { Sim } from './loop'
import { ChunkKind, CHUNK_COUNT } from '../world/chunks'

/**
 * I.hash — FNV-1a 32-bit over full sim state. Deterministic, order-fixed.
 * Same command log ⇒ same hash sequence (V3). Used by replay tests and
 * the multiplayer desync detector (V10).
 */
export class Fnv {
  private h = 0x811c9dc5

  u8(v: number): this {
    this.h = Math.imul(this.h ^ (v & 0xff), 0x01000193)
    return this
  }

  u32(v: number): this {
    return this.u8(v).u8(v >>> 8).u8(v >>> 16).u8(v >>> 24)
  }

  /** f64 hashed via its IEEE-754 bits — exact, no rounding ambiguity */
  f64(v: number): this {
    scratchF64[0] = v
    return this.u32(scratchU32[0]).u32(scratchU32[1])
  }

  bytes(data: Uint8Array): this {
    for (let i = 0; i < data.length; i++) {
      this.h = Math.imul(this.h ^ data[i], 0x01000193)
    }
    return this
  }

  get value(): number {
    return this.h >>> 0
  }
}

const scratchF64 = new Float64Array(1)
const scratchU32 = new Uint32Array(scratchF64.buffer)

export function hashSim(sim: Sim): number {
  const h = new Fnv()
  h.u32(sim.tick)
  h.u32(sim.prng.state)
  h.u32(sim.nextEntityId)
  for (let i = 0; i < CHUNK_COUNT; i++) {
    const c = sim.world.chunkAt(i)
    if (c.kind === ChunkKind.Empty) continue // skip: empty is the default
    h.u32(i).u8(c.kind)
    if (c.kind === ChunkKind.Uniform) h.u8(c.mat)
    else h.bytes(c.data!)
  }
  return h.value
}
